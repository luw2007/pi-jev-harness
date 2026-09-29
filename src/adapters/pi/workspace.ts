/**
 * Workspace baseline for the run changeset (product §5 step 3, technical §11.1). Envelope tracking
 * only sees edit/create/overwrite; a file written by bash or any other path shows up here instead.
 *
 * - Git workspace: at task start record every path `git status` reports as dirty (tracked changes
 *   and untracked files) with its sha256. At the end, a path dirty now or at start is this task's
 *   change when its content differs from the start state (start digest when it was dirty, else the
 *   HEAD blob; absent when untracked). The dirty-at-start paths are reported separately as
 *   pre-existing changes and are never counted as this task's changes on their own.
 * - Not a git repository (or git unavailable): a walk of the workspace (size, mtime, sha256),
 *   skipping `.git`, `node_modules` and excluded directories. Unchanged size+mtime is not rehashed.
 *
 * Ignored files (git) and symlinks (walk) are not followed.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Walk cap: beyond this the walk baseline is marked incomplete. Raise (or require git) if real workspaces hit it. */
export const MAX_WALK_FILES = 20_000;
const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);
const GIT_BUFFER = 64 * 1024 * 1024;

export interface WorkspaceChange {
  /** Workspace-relative path with forward slashes (the changeset path). */
  path: string;
  /** sha256 before (null: did not exist) and now (null: gone). */
  before: string | null;
  after: string | null;
}

export interface WorkspaceDiff {
  changes: WorkspaceChange[];
  /** Workspace-relative paths already dirty when the task started. */
  preexisting: string[];
  /** Why the diff is incomplete or unavailable; null when complete. */
  note: string | null;
}

export interface WorkspaceBaseline {
  diff(): Promise<WorkspaceDiff>;
}

interface WalkEntry {
  size: number;
  mtimeMs: number;
  digest: string;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

async function digestOrNull(path: string): Promise<string | null> {
  try {
    const stat = await nodeFs.lstat(path);
    if (!stat.isFile()) return null;
    return await hashFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

const display = (root: string, target: string) => relative(root, target).split(sep).join("/");

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run("git", ["--no-optional-locks", ...args], { cwd, encoding: "buffer", maxBuffer: GIT_BUFFER });
  return stdout;
}

/** Absolute paths `git status` reports under `cwd` (renames contribute both paths). */
async function gitDirty(top: string, cwd: string): Promise<string[]> {
  const out = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])).toString("utf8");
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(join(top, entry.slice(3)));
    // -z rename/copy: the original path follows as its own field.
    if (xy.includes("R") || xy.includes("C")) paths.push(join(top, parts[++i]!));
  }
  return paths;
}

async function headDigest(top: string, target: string): Promise<string | null> {
  const rel = relative(top, target).split(sep).join("/");
  try {
    return createHash("sha256").update(await git(top, ["cat-file", "blob", `HEAD:${rel}`])).digest("hex");
  } catch {
    // Not in HEAD (untracked, or no commit yet): the file did not exist before the task.
    return null;
  }
}

async function gitBaseline(top: string, cwd: string, excluded: readonly string[]): Promise<WorkspaceBaseline> {
  const keep = (path: string) => !excluded.some((dir) => inside(dir, path));
  const start = new Map<string, string | null>();
  for (const path of (await gitDirty(top, cwd)).filter(keep)) start.set(path, await digestOrNull(path));
  return {
    async diff() {
      const now = (await gitDirty(top, cwd)).filter(keep);
      const changes: WorkspaceChange[] = [];
      for (const target of new Set([...start.keys(), ...now])) {
        const before = start.has(target) ? start.get(target)! : await headDigest(top, target);
        const after = await digestOrNull(target);
        if (before !== after) changes.push({ path: display(cwd, target), before, after });
      }
      return { changes, preexisting: [...start.keys()].map((target) => display(cwd, target)), note: null };
    },
  };
}

async function walk(root: string, excluded: readonly string[], previous?: ReadonlyMap<string, WalkEntry>): Promise<{ files: Map<string, WalkEntry>; truncated: boolean }> {
  const files = new Map<string, WalkEntry>();
  const dirs = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    let entries;
    try {
      entries = await nodeFs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !excluded.some((ex) => inside(ex, path))) dirs.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= MAX_WALK_FILES) return { files, truncated: true };
      let stat;
      try {
        stat = await nodeFs.stat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const prior = previous?.get(path);
      const digest = prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs ? prior.digest : await hashFile(path);
      files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, digest });
    }
  }
  return { files, truncated: false };
}

async function walkBaseline(root: string, excluded: readonly string[]): Promise<WorkspaceBaseline> {
  const start = await walk(root, excluded);
  return {
    async diff() {
      const now = await walk(root, excluded, start.files);
      const changes: WorkspaceChange[] = [];
      for (const target of new Set([...start.files.keys(), ...now.files.keys()])) {
        const before = start.files.get(target)?.digest ?? null;
        const after = now.files.get(target)?.digest ?? null;
        if (before !== after) changes.push({ path: display(root, target), before, after });
      }
      const truncated = start.truncated || now.truncated;
      return { changes, preexisting: [], note: truncated ? `工作区文件超过 ${MAX_WALK_FILES} 个，改动检测不完整` : null };
    },
  };
}

/** Snapshot `cwd` now; `excluded` directories (for example the run products directory) are ignored. */
export async function snapshotWorkspace(cwd: string, excluded: readonly string[] = []): Promise<WorkspaceBaseline> {
  let top: string | undefined;
  try {
    top = (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim() || undefined;
  } catch {
    top = undefined; // not a git work tree, or git missing: walk instead
  }
  // Compare in the same spelling as cwd (macOS /var vs /private/var): paths are joined from the real top.
  if (top !== undefined) return gitBaseline(await nodeFs.realpath(top), await nodeFs.realpath(cwd), await Promise.all(excluded.map((dir) => nodeFs.realpath(dir).catch(() => dir))));
  return walkBaseline(cwd, excluded);
}
