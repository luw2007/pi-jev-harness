// Adapted from omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:src/spill.ts (MIT)
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Content-addressed archive for tool output moved out of the model context.
 *
 * Layout: `<dir>/<sessionId>/<sha256-hex>`. Files are 0600, the session
 * directory is 0700, writes go to a temp file and are renamed into place.
 * The store root and the session directory must be real directories owned by
 * this user: a pre-existing symlink (or foreign directory) is refused before
 * anything is chmodded or written through it.
 * A caller may replace the original text only after `storePayload` returned
 * `ok: true`; on any failure the original must stay in context. Recall only
 * reads an archived file and verifies its digest; it never re-runs anything.
 *
 * Session ids are lowercase only (`[a-z0-9._-]`, not starting with `.`) and digests
 * are lowercase hex, so two distinct ids can never map to one directory on a
 * case-insensitive filesystem. Stores for one session are serialized inside this
 * process, which makes the quota check and the write one step; separate processes
 * writing the same session are not coordinated.
 */

/** Filesystem surface used here; injectable so tests can simulate failures. */
export interface SpillFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: Uint8Array, options: { mode: number; flag: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; uid: number }>;
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024;

export interface SpillOptions {
  sessionId: string;
  /** Per-payload limit in UTF-8 bytes. Default 8 MiB. */
  maxPayloadBytes?: number;
  /** Total archived bytes per session. Default 64 MiB. */
  maxSessionBytes?: number;
  fs?: SpillFs;
}

export type StoreFailureReason =
  | "invalid_session"
  | "invalid_content"
  | "payload_too_large"
  | "session_quota_exceeded"
  | "io_error";

export type StoreResult =
  | { ok: true; handle: string; bytes: number }
  | { ok: false; reason: StoreFailureReason; detail?: string };

export type RecallFailureReason =
  | "invalid_session"
  | "invalid_handle"
  | "foreign_session"
  | "not_found"
  | "corrupted"
  | "io_error";

export type RecallResult =
  | { ok: true; content: string }
  | { ok: false; reason: RecallFailureReason; detail?: string };

const SESSION_RE = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const TMP_RE = /^\.[0-9a-f]{64}\.[0-9a-f-]+\.tmp$/;
const HANDLE_RE = /^spill:([a-z0-9_-][a-z0-9._-]{0,127}):([0-9a-f]{64})$/;
const HANDLE_IN_TEXT_RE = /spill:[a-z0-9_-][a-z0-9._-]{0,127}:[0-9a-f]{64}/;
const NOTICE_MARKER = "[jev spill: ";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const defaultFs: SpillFs = nodeFs as unknown as SpillFs;

function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_RE.test(sessionId);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errDetail(error: unknown): string {
  return errCode(error) ?? (error instanceof Error ? error.message : String(error));
}

export function formatHandle(sessionId: string, digest: string): string {
  return `spill:${sessionId}:${digest}`;
}

/** Archived plus temp (in-flight or left over) bytes of one session. */
async function sessionBytes(fs: SpillFs, sessionDir: string): Promise<number> {
  let total = 0;
  for (const name of await fs.readdir(sessionDir)) {
    if (!DIGEST_RE.test(name) && !TMP_RE.test(name)) continue;
    const st = await fs.lstat(join(sessionDir, name));
    if (st.isFile()) total += st.size;
  }
  return total;
}

/**
 * Throws unless `path` is a directory itself (not a symlink to one) owned by this process's user.
 * Checked after `mkdir`, which silently accepts an existing symlink, and before any chmod or write.
 */
async function assertOwnDir(fs: SpillFs, path: string): Promise<void> {
  const st = await fs.lstat(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink`);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is not owned by this user`);
}

async function fileHasDigest(fs: SpillFs, path: string, digest: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path);
    if (!st.isFile()) return false;
    return sha256(await fs.readFile(path)) === digest;
  } catch {
    return false;
  }
}

const sessionLocks = new Map<string, Promise<void>>();

/** Runs `task` after every earlier task queued under `key` has settled. */
async function withSessionLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  const tail = previous.then(() => held);
  sessionLocks.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
  }
}

/** Archives `content`; never throws. Identical content maps to one file. */
export async function storePayload(dir: string, content: string, options: SpillOptions): Promise<StoreResult> {
  const fs = options.fs ?? defaultFs;
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxSession = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const { sessionId } = options;
  if (!isValidSessionId(sessionId)) return { ok: false, reason: "invalid_session" };
  if (typeof content !== "string") return { ok: false, reason: "invalid_content" };

  const bytes = Buffer.from(content, "utf8");
  // Lone surrogates do not survive UTF-8; archiving them would not be lossless.
  if (bytes.toString("utf8") !== content) return { ok: false, reason: "invalid_content" };
  if (bytes.byteLength > maxPayload) return { ok: false, reason: "payload_too_large" };

  return withSessionLock(`${resolve(dir)}\0${sessionId}`, () =>
    storeLocked(fs, dir, sessionId, bytes, maxSession),
  );
}

async function storeLocked(
  fs: SpillFs,
  dir: string,
  sessionId: string,
  bytes: Buffer,
  maxSession: number,
): Promise<StoreResult> {
  const digest = sha256(bytes);
  const handle = formatHandle(sessionId, digest);
  const sessionDir = join(dir, sessionId);
  const finalPath = join(sessionDir, digest);
  const tmpPath = join(sessionDir, `.${digest}.${randomUUID()}.tmp`);

  try {
    // Root first, so a symlinked root is refused before anything is created through it.
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await assertOwnDir(fs, dir);
    await fs.mkdir(sessionDir, { recursive: true, mode: DIR_MODE });
    await assertOwnDir(fs, sessionDir);
    await fs.chmod(sessionDir, DIR_MODE);
    if (await fileHasDigest(fs, finalPath, digest)) {
      // Tighten an existing archive that was loosened, then confirm it is still ours.
      await fs.chmod(finalPath, FILE_MODE);
      if (await fileHasDigest(fs, finalPath, digest)) return { ok: true, handle, bytes: bytes.byteLength };
    }
    if ((await sessionBytes(fs, sessionDir)) + bytes.byteLength > maxSession) {
      return { ok: false, reason: "session_quota_exceeded" };
    }
  } catch (error) {
    return { ok: false, reason: "io_error", detail: errDetail(error) };
  }

  try {
    await fs.writeFile(tmpPath, bytes, { mode: FILE_MODE, flag: "wx" });
    await fs.chmod(tmpPath, FILE_MODE);
    await fs.rename(tmpPath, finalPath);
    return { ok: true, handle, bytes: bytes.byteLength };
  } catch (error) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch (cleanupError) {
      return { ok: false, reason: "io_error", detail: `${errDetail(error)}; cleanup failed: ${errDetail(cleanupError)}` };
    }
    return { ok: false, reason: "io_error", detail: errDetail(error) };
  }
}

/** Reads back an archived payload of this session; never throws. */
export async function recallPayload(
  dir: string,
  handle: string,
  options: Pick<SpillOptions, "sessionId" | "fs">,
): Promise<RecallResult> {
  const fs = options.fs ?? defaultFs;
  const { sessionId } = options;
  if (!isValidSessionId(sessionId)) return { ok: false, reason: "invalid_session" };
  const match = typeof handle === "string" ? HANDLE_RE.exec(handle) : null;
  if (!match) return { ok: false, reason: "invalid_handle" };
  const [, handleSession, digest] = match as unknown as [string, string, string];
  if (handleSession !== sessionId) return { ok: false, reason: "foreign_session" };

  const path = join(dir, sessionId, digest);
  let bytes: Uint8Array;
  try {
    const st = await fs.lstat(path);
    if (!st.isFile()) return { ok: false, reason: "corrupted", detail: "not a regular file" };
    bytes = await fs.readFile(path);
  } catch (error) {
    if (errCode(error) === "ENOENT") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "io_error", detail: errDetail(error) };
  }
  if (sha256(bytes) !== digest) return { ok: false, reason: "corrupted" };
  return { ok: true, content: Buffer.from(bytes).toString("utf8") };
}

export interface SpillNoticeMeta {
  /** Length of the original text in characters. */
  chars: number;
  /** Optional leading excerpt kept inline above the notice. */
  head?: string;
}

/** Replacement text shown in context in place of an archived payload. */
export function spillNotice(handle: string, meta: SpillNoticeMeta): string {
  const head = meta.head ? `${meta.head}\n` : "";
  return (
    `${head}${NOTICE_MARKER}${meta.chars} chars of this tool result were moved out of context. ` +
    `The full output is archived; recover it with jev_recall {"handle":"${handle}"}]`
  );
}

/** True when `text` contains a spill notice, so it is never archived again. */
export function isSpillNotice(text: string): boolean {
  return text.includes(NOTICE_MARKER) && text.includes("jev_recall") && HANDLE_IN_TEXT_RE.test(text);
}
