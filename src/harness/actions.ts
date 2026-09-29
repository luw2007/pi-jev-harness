/**
 * Host-owned action envelopes and deterministic validation (technical design
 * §5, §7.1, §9.3 row 3). Structural, boundary, freshness, and authorization
 * failures are decided here, before any outbound review; a failure means the
 * action is blocked and Jev is never asked.
 *
 * Nothing here executes or writes. File-system reads go through the injected
 * `HarnessFs`; no environment, network, or clock access.
 */
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataArray, dataRecord } from "../../vendor/jev-harness/src/contract/input.ts";
import { parseUnifiedDiff } from "../../vendor/jev-harness/src/contract/diff.ts";
import { validateProposal } from "../../vendor/jev-harness/src/contract/validate.ts";
import type {
  ActionChange,
  ActionEnvelope,
  ActionHost,
  ActionKind,
  ActionPolicy,
  AuthorizationScope,
  EnvelopeValidation,
  Freshness,
  FsStat,
  HarnessFs,
  Preimage,
  Replacement,
  ToolCallInput,
} from "./types.ts";

/** Bytes inspected for NUL when deciding a file is binary (git's heuristic window). */
const BINARY_SNIFF_BYTES = 8000;

type ArgSpec = Record<string, "string" | "number" | "boolean" | "replacements" | "strings">;

interface ToolSpec {
  kind: Exclude<ActionKind, "create" | "overwrite" | "unsupported"> | "write";
  required: ArgSpec;
  optional: ArgSpec;
  /** Argument naming the target path; absent means the host cwd. */
  pathArg: string;
}

/**
 * Pi 0.87.1 built-ins (dist/core/tools/*.d.ts) plus H's two proposal tools.
 * Anything else — rename, delete, move, extension tools — is unsupported.
 */
const TOOLS: Readonly<Record<string, ToolSpec>> = Object.freeze({
  read: { kind: "read", required: { path: "string" }, optional: { offset: "number", limit: "number" }, pathArg: "path" },
  grep: {
    kind: "search",
    required: { pattern: "string" },
    optional: { path: "string", glob: "string", ignoreCase: "boolean", literal: "boolean", context: "number", limit: "number" },
    pathArg: "path",
  },
  find: { kind: "search", required: { pattern: "string" }, optional: { path: "string", limit: "number" }, pathArg: "path" },
  ls: { kind: "search", required: {}, optional: { path: "string", limit: "number" }, pathArg: "path" },
  edit: { kind: "edit", required: { path: "string" }, optional: { edits: "replacements", oldText: "string", newText: "string" }, pathArg: "path" },
  write: { kind: "write", required: { path: "string", content: "string" }, optional: {}, pathArg: "path" },
  bash: { kind: "command", required: { command: "string" }, optional: { timeout: "number" }, pathArg: "" },
  // H proposal tools: the strict shape is checked by H's `validateProposal`.
  read_file: { kind: "read", required: { path: "string" }, optional: { rationale: "string", evidence: "strings" }, pathArg: "path" },
  propose_patch: {
    kind: "edit",
    required: { path: "string" },
    optional: { patch: "string", rationale: "string", evidence: "strings" },
    pathArg: "path",
  },
});

const H_TOOLS: Record<string, true> = { read_file: true, propose_patch: true };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function lstatOrNull(fs: HarnessFs, path: string): Promise<FsStat | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Realpath of `abs`, or of its nearest existing ancestor plus the missing remainder. */
async function resolveTarget(fs: HarnessFs, abs: string): Promise<{ real: string; exists: boolean }> {
  try {
    return { real: await fs.realpath(abs), exists: true };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if ((await lstatOrNull(fs, abs))?.isSymbolicLink())
    throw Error(`${abs} is a dangling symbolic link`);
  const parent = dirname(abs);
  if (parent === abs) throw Error(`no existing ancestor for ${abs}`);
  const up = await resolveTarget(fs, parent);
  return { real: join(up.real, basename(abs)), exists: false };
}

async function realRoots(fs: HarnessFs, roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await fs.realpath(root));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return out;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function inRoots(roots: readonly string[], target: string): boolean {
  return roots.some((root) => within(root, target));
}

/** Pi strips a leading `@`; `~` expansion needs the environment, so it is refused. */
function requestedPath(raw: string, cwd: string): string {
  if (/[\x00-\x1f]/.test(raw)) throw Error("path contains control characters");
  const path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~" || path.startsWith("~/")) throw Error("home-relative paths are not resolved by the harness");
  if (!path) throw Error("path is empty");
  return resolve(cwd, path);
}

function checkArg(value: unknown, type: ArgSpec[string]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "strings":
      return dataArray(value)?.every((item) => typeof item === "string") ?? false;
    case "replacements": {
      const items = dataArray(value);
      return !!items?.length && items.every((item) => {
        const edit = dataRecord(item);
        return !!edit && Object.keys(edit).length === 2 && typeof edit.oldText === "string" && typeof edit.newText === "string";
      });
    }
  }
}

function argIssues(args: Record<string, unknown>, spec: ToolSpec, toolName: string): string[] {
  const issues: string[] = [];
  for (const [key, type] of Object.entries(spec.required))
    if (!checkArg(args[key], type)) issues.push(`${toolName}.${key} must be a ${type}`);
  for (const key of Object.keys(args)) {
    const type = spec.optional[key];
    if (key in spec.required) continue;
    // H's strict schema reports unknown keys for its own tools.
    if (!type) {
      if (!Object.hasOwn(H_TOOLS, toolName)) issues.push(`${toolName} does not accept argument ${JSON.stringify(key)}`);
    } else if (!checkArg(args[key], type)) issues.push(`${toolName}.${key} must be a ${type}`);
  }
  return issues;
}

/** Pi accepts `edits[]` or the legacy top-level `oldText`/`newText` pair, never both. */
function editReplacements(args: Record<string, unknown>): Replacement[] | string {
  const hasLegacy = "oldText" in args || "newText" in args;
  if ("edits" in args) {
    if (hasLegacy) return "edit takes either edits[] or oldText/newText, not both";
    return dataArray(args.edits)!.map((item) => {
      const edit = dataRecord(item)!;
      return { oldText: edit.oldText as string, newText: edit.newText as string };
    });
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string")
    return [{ oldText: args.oldText, newText: args.newText }];
  return "edit requires edits[] or oldText/newText";
}

async function takePreimage(fs: HarnessFs, path: string, maxBytes: number): Promise<Preimage | null> {
  const stat = await lstatOrNull(fs, path);
  if (!stat?.isFile() || stat.size > maxBytes) return null;
  const bytes = await fs.readFile(path);
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * Translate a native tool call into a host-owned envelope. Unknown tools, and
 * rename/delete-style actions, become `unsupported` and are withheld.
 */
export async function buildEnvelope(toolCall: ToolCallInput, host: ActionHost): Promise<ActionEnvelope> {
  const spec = Object.hasOwn(TOOLS, toolCall.toolName) ? TOOLS[toolCall.toolName] : undefined;
  const args = dataRecord(toolCall.args);
  const roots = await realRoots(host.fs, host.allowedRoots);
  const issues: string[] = [];
  let kind: ActionKind = "unsupported";
  if (spec) kind = spec.kind === "write" ? (toolCall.overwrite === true ? "overwrite" : "create") : spec.kind;
  const grant = kind === "unsupported" ? null : (host.grants.find((g) => g.kinds.includes(kind)) ?? null);
  const envelope: ActionEnvelope = {
    actionId: host.newId(),
    toolCallId: toolCall.toolCallId ?? host.newId(),
    kind,
    toolName: toolCall.toolName,
    args,
    requestedPaths: [],
    targets: [],
    preimage: null,
    change: null,
    scope: { grant, roots },
    rationale: toolCall.rationale ?? null,
    withheld: kind === "unsupported",
    issues,
  };
  if (!spec) {
    issues.push(`tool ${JSON.stringify(toolCall.toolName)} is not a supported action; withheld`);
    return envelope;
  }
  if (!args) {
    issues.push(`${toolCall.toolName} arguments must be a plain object`);
    return envelope;
  }
  if (Object.hasOwn(H_TOOLS, toolCall.toolName) && envelope.rationale === null && typeof args.rationale === "string")
    envelope.rationale = args.rationale;
  issues.push(...argIssues(args, spec, toolCall.toolName));
  if (issues.length) return envelope;

  let change: ActionChange | null = null;
  if (toolCall.toolName === "edit") {
    const edits = editReplacements(args);
    if (typeof edits === "string") issues.push(edits);
    else change = { format: "replacements", edits };
  } else if (toolCall.toolName === "propose_patch" && typeof args.patch === "string") {
    change = { format: "unified_diff", patch: args.patch };
  } else if (spec.kind === "write" && typeof args.content === "string") {
    const bytes = utf8Bytes(args.content);
    change = { format: "content", sha256: sha256(bytes), bytes: bytes.length };
  }

  let requested: string;
  try {
    const raw = spec.pathArg ? args[spec.pathArg] : undefined;
    requested = typeof raw === "string" ? requestedPath(raw, host.cwd) : resolve(host.cwd);
  } catch (error) {
    issues.push(errorText(error));
    envelope.change = change;
    return envelope;
  }
  envelope.requestedPaths = [requested];
  try {
    const { real, exists } = await resolveTarget(host.fs, requested);
    envelope.targets = [real];
    if (kind === "command" && typeof args.command === "string") change = { format: "command", script: args.command, cwd: real };
    if (exists && (kind === "read" || kind === "edit" || kind === "overwrite") && grant && inRoots(roots, real))
      envelope.preimage = await takePreimage(host.fs, real, grant.maxFileBytes);
  } catch (error) {
    issues.push(errorText(error));
  }
  envelope.change = change;
  return envelope;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Pi matches against LF-normalized content with any BOM stripped. */
function normalizeForMatch(text: string): string {
  return (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n/g, "\n");
}

/** Overlapping occurrences count too: any second position is ambiguous. */
function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

type Span = { start: number; end: number; index: number; newText: string };

/** Locate every replacement exactly once in LF-normalized text; sorted, non-overlapping spans or a failure reason. */
function replacementSpans(text: string, edits: Replacement[]): Span[] | string {
  const spans: Span[] = [];
  for (const [index, edit] of edits.entries()) {
    const oldText = edit.oldText.replace(/\r\n/g, "\n");
    if (!oldText) return `edits[${index}].oldText is empty`;
    const found = occurrences(text, oldText);
    if (found.length !== 1) return `edits[${index}].oldText matches ${found.length} times; exactly one match is required`;
    spans.push({ start: found[0]!, end: found[0]! + oldText.length, index, newText: edit.newText.replace(/\r\n/g, "\n") });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++)
    if (spans[i]!.start < spans[i - 1]!.end) return `edits[${spans[i - 1]!.index}] and edits[${spans[i]!.index}] overlap`;
  return spans;
}

function checkReplacements(content: string, edits: Replacement[], maxBytes: number): string | null {
  const text = normalizeForMatch(content);
  const spans = replacementSpans(text, edits);
  if (typeof spans === "string") return spans;
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start) + span.newText;
    cursor = span.end;
  }
  result += text.slice(cursor);
  const bytes = utf8Bytes(result).length;
  return bytes > maxBytes ? `edited file would be ${bytes} bytes; limit is ${maxBytes}` : null;
}

/** Unchanged lines kept around each change in a generated diff (the `diff -u` default). */
const DIFF_CONTEXT_LINES = 3;

/** Lines with their terminators; a last line without "\n" has none. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Single-file unified diff for exact replacements on `content`, using the same matching as
 * validation (BOM stripped, LF-normalized, each `oldText` exactly once, no overlap). `path` is
 * written into the `a/` and `b/` headers unchanged. Throws when the replacements do not apply.
 */
export function replacementsToUnifiedDiff(path: string, content: string, edits: Replacement[]): string {
  const text = normalizeForMatch(content);
  const spans = replacementSpans(text, edits);
  if (typeof spans === "string") throw Error(spans);
  const lines = splitLines(text);
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i]!.length, i++) starts.push(at);
  const lineOf = (offset: number): number => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= offset) line++;
    return line;
  };
  // Changed regions: whole old lines [first, last] and the lines replacing them.
  const regions: { first: number; last: number; spans: Span[] }[] = [];
  for (const span of spans) {
    const first = lineOf(span.start);
    const last = lineOf(span.end - 1);
    const prev = regions.at(-1);
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.spans.push(span);
    } else regions.push({ first, last, spans: [span] });
  }
  const body = (prefix: string, line: string): string[] =>
    line.endsWith("\n") ? [prefix + line.slice(0, -1)] : [prefix + line, "\\ No newline at end of file"];
  const out = [`--- a/${path}`, `+++ b/${path}`];
  const range = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`;
  let delta = 0;
  let hunk: { oldStart: number; oldEnd: number; oldCount: number; newCount: number; lines: string[] } | null = null;
  const context = (from: number, to: number) => {
    for (let i = from; i < to; i++) hunk!.lines.push(...body(" ", lines[i]!));
    hunk!.oldCount += to - from;
    hunk!.newCount += to - from;
  };
  const close = () => {
    if (!hunk) return;
    context(hunk.oldEnd, Math.min(lines.length, hunk.oldEnd + DIFF_CONTEXT_LINES));
    out.push(`@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.oldStart + delta, hunk.newCount)} @@`, ...hunk.lines);
    delta += hunk.newCount - hunk.oldCount;
  };
  for (const region of regions) {
    const from = starts[region.first]!;
    const to = starts[region.last]! + lines[region.last]!.length;
    let replaced = "";
    let cursor = from;
    for (const span of region.spans) {
      replaced += text.slice(cursor, span.start) + span.newText;
      cursor = span.end;
    }
    replaced += text.slice(cursor, to);
    if (hunk && region.first - hunk.oldEnd <= 2 * DIFF_CONTEXT_LINES) context(hunk.oldEnd, region.first);
    else {
      close();
      const oldStart = Math.max(0, region.first - DIFF_CONTEXT_LINES);
      hunk = { oldStart, oldEnd: oldStart, oldCount: 0, newCount: 0, lines: [] };
      context(oldStart, region.first);
    }
    for (let i = region.first; i <= region.last; i++) hunk.lines.push(...body("-", lines[i]!));
    const added = splitLines(replaced);
    for (const line of added) hunk.lines.push(...body("+", line));
    hunk.oldCount += region.last - region.first + 1;
    hunk.newCount += added.length;
    hunk.oldEnd = region.last + 1;
  }
  close();
  return `${out.join("\n")}\n`;
}

/** H checks that each hunk's old side appears; exact application needs exactly one position. */
function checkHunksUnique(patch: string, content: string): string | null {
  const fileLines = content.replace(/\r\n/g, "\n").split("\n");
  for (const file of parseUnifiedDiff(patch).files)
    for (const hunk of file.hunks) {
      const oldLines = hunk.diff
        .split("\n")
        .slice(1)
        .filter((line) => /^[ -]/.test(line))
        .map((line) => line.slice(1));
      let count = 0;
      outer: for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
        for (let j = 0; j < oldLines.length; j++) if (fileLines[i + j] !== oldLines[j]) continue outer;
        count++;
      }
      if (count !== 1) return `patch hunk ${hunk.header} matches ${count} positions; exactly one is required`;
    }
  return null;
}

type FileRead = { stat: FsStat; bytes: Uint8Array; text: string };

async function readTextFile(fs: HarnessFs, path: string, maxBytes: number): Promise<FileRead | string> {
  const stat = await lstatOrNull(fs, path);
  if (!stat) return `${path} does not exist`;
  if (!stat.isFile()) return `${path} is not a regular file`;
  if (stat.size > maxBytes) return `${path} is ${stat.size} bytes; limit is ${maxBytes}`;
  const bytes = await fs.readFile(path);
  if (bytes.length > maxBytes) return `${path} is ${bytes.length} bytes; limit is ${maxBytes}`;
  const text = decodeText(bytes);
  if (text === null) return `${path} is a binary file`;
  return { stat, bytes, text };
}

function checkNewContent(envelope: ActionEnvelope, maxBytes: number): string | null {
  const content = envelope.args?.content;
  if (typeof content !== "string") return "write content is missing";
  if (content.includes("\0")) return "write content is binary";
  const bytes = utf8Bytes(content).length;
  return bytes > maxBytes ? `write content is ${bytes} bytes; limit is ${maxBytes}` : null;
}

function hProposal(envelope: ActionEnvelope): unknown {
  return { tool: envelope.toolName, ...envelope.args };
}

async function validateTargets(envelope: ActionEnvelope, policy: ActionPolicy, grant: AuthorizationScope): Promise<string | null> {
  const fs = policy.fs;
  const roots = await realRoots(fs, policy.allowedRoots);
  if (!envelope.targets.length || envelope.targets.length !== envelope.requestedPaths.length)
    return "action has no resolved target";
  for (const [index, requested] of envelope.requestedPaths.entries()) {
    const { real } = await resolveTarget(fs, requested);
    if (real !== envelope.targets[index]) return `${requested} now resolves to ${real}, not ${envelope.targets[index]}`;
    if (!inRoots(roots, real))
      return inRoots([...roots, ...policy.allowedRoots.map((root) => resolve(root))], requested)
        ? `${requested} is a symbolic link resolving outside the allowed roots (${real})`
        : `${real} is outside the allowed roots`;
  }
  const target = envelope.targets[0]!;
  const max = grant.maxFileBytes;
  switch (envelope.kind) {
    case "read": {
      const file = await readTextFile(fs, target, max);
      if (typeof file === "string") return file;
      if (envelope.toolName === "read_file") {
        const path = envelope.args?.path as string;
        const result = validateProposal(hProposal(envelope), { [path]: file.text });
        if (!result.ok) return result.errors.join("; ");
      }
      return null;
    }
    case "search":
      return (await lstatOrNull(fs, target)) ? null : `${target} does not exist`;
    case "edit": {
      const file = await readTextFile(fs, target, max);
      if (typeof file === "string") return `edit target: ${file}`;
      if (!envelope.preimage) return "edit has no preimage";
      if (envelope.preimage.path !== target || envelope.preimage.sha256 !== sha256(file.bytes))
        return "preimage does not match the current file content";
      const change = envelope.change;
      if (change?.format === "replacements") return checkReplacements(file.text, change.edits, max);
      if (change?.format === "unified_diff") {
        const path = envelope.args?.path as string;
        const result = validateProposal(hProposal(envelope), { [path]: file.text });
        if (!result.ok) return result.errors.join("; ");
        return checkHunksUnique(change.patch, file.text);
      }
      const result = validateProposal(hProposal(envelope), { [String(envelope.args?.path)]: file.text });
      return result.ok ? "edit carries no change" : result.errors.join("; ");
    }
    case "create": {
      if ((await lstatOrNull(fs, target)) || (await lstatOrNull(fs, envelope.requestedPaths[0]!)))
        return `${target} already exists; replacing it requires an explicit overwrite marker`;
      const parent = dirname(target);
      const parentStat = await lstatOrNull(fs, parent);
      if (!parentStat) return `parent directory ${parent} does not exist`;
      if (!parentStat.isDirectory()) return `parent ${parent} is not a directory`;
      if (!inRoots(roots, parent)) return `parent directory ${parent} is outside the allowed roots`;
      return checkNewContent(envelope, max);
    }
    case "overwrite": {
      const file = await readTextFile(fs, target, max);
      if (typeof file === "string") return `overwrite target: ${file}`;
      if (!envelope.preimage || envelope.preimage.path !== target || envelope.preimage.sha256 !== sha256(file.bytes))
        return "preimage does not match the current file content";
      return checkNewContent(envelope, max);
    }
    case "command": {
      // Structure only: a command named "test" is not thereby side-effect free.
      const change = envelope.change;
      if (change?.format !== "command") return "command has no script or argv";
      if (change.cwd !== target) return "command cwd does not match its resolved target";
      if ("script" in change ? !change.script.trim() : !change.argv.length) return "command is empty";
      return (await lstatOrNull(fs, target))?.isDirectory() ? null : `command cwd ${target} is not a directory`;
    }
    case "unsupported":
      return "unsupported action";
  }
}

/**
 * Deterministic validation. `{ ok: false }` blocks the action outright: no Jev
 * request, and no semantic score may override it.
 */
export async function validateEnvelope(envelope: ActionEnvelope, policy: ActionPolicy): Promise<EnvelopeValidation> {
  if (envelope.withheld || envelope.kind === "unsupported")
    return { ok: false, reason: `unsupported action ${JSON.stringify(envelope.toolName)} is withheld` };
  if (envelope.issues.length) return { ok: false, reason: envelope.issues.join("; ") };
  const granted = envelope.scope.grant;
  const grant = granted && policy.grants.find((g) => g.id === granted.id && g.kinds.includes(envelope.kind));
  if (!grant) return { ok: false, reason: `no grant authorizes ${envelope.kind} for ${envelope.toolName}` };
  try {
    const failure = await validateTargets(envelope, policy, grant);
    return failure === null ? { ok: true } : { ok: false, reason: failure };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * True for an authorized, in-root, size-bounded read or search: it skips Jev
 * review. Call after `validateEnvelope` succeeded; this does not re-read files.
 */
export function isFastPathRead(envelope: ActionEnvelope): boolean {
  if (envelope.kind !== "read" && envelope.kind !== "search") return false;
  const grant = envelope.scope.grant;
  if (envelope.withheld || envelope.issues.length || !grant?.kinds.includes(envelope.kind)) return false;
  if (!envelope.targets.length || !envelope.targets.every((target) => inRoots(envelope.scope.roots, target))) return false;
  if (envelope.kind === "search") return true;
  const preimage = envelope.preimage;
  return !!preimage && preimage.path === envelope.targets[0] && preimage.bytes <= grant.maxFileBytes;
}

/** Re-read the preimage right before execution; any change is `stale`. */
export async function checkFreshness(envelope: ActionEnvelope, fs: HarnessFs): Promise<Freshness> {
  try {
    const requested = envelope.requestedPaths[0];
    if (requested !== undefined) {
      const { real } = await resolveTarget(fs, requested);
      if (real !== envelope.targets[0]) return { status: "stale", reason: `${requested} now resolves to ${real}` };
    }
    if (envelope.preimage) {
      const bytes = await fs.readFile(envelope.preimage.path);
      if (sha256(bytes) !== envelope.preimage.sha256)
        return { status: "stale", reason: `${envelope.preimage.path} changed since its preimage was taken` };
      return { status: "fresh" };
    }
    if (envelope.kind === "create" && (await lstatOrNull(fs, envelope.targets[0]!)))
      return { status: "stale", reason: `${envelope.targets[0]} was created since the action was built` };
    return { status: "fresh" };
  } catch (error) {
    return { status: "stale", reason: errorText(error) };
  }
}
