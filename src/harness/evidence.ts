/**
 * Execution evidence from real host tool results (technical §7.1 execution row, §11).
 * Pure: no clock, environment, network, or filesystem. Timestamps come from the host event.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../../vendor/jev-harness/src/audit/receipt.ts";

export const EVIDENCE_OUTCOMES = ["ok", "error", "timeout", "cancelled"] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export const DEFAULT_SUMMARY_LINES = 20;
const MAX_SUMMARY_LINES = 1000;
/** Per-line cap for the head summary; the full text is only kept via the artifact. */
const MAX_SUMMARY_LINE_CHARS = 400;
const SHA256 = /^[a-f0-9]{64}$/;

/** Canonical encoding of one content block; the output digest covers the list of these. */
export interface EvidenceOutputBlock {
  type: string;
  /** Declared MIME type; null when the block carries none (text blocks, plain strings). */
  mimeType: string | null;
  /** sha256 of the block data: the text for text blocks, the `data` string (as given, e.g. base64) otherwise, or H's canonical JSON of the whole block when it has neither. */
  sha256: string;
  /** UTF-8 byte length of the hashed data. */
  bytes: number;
}

export interface EvidenceOutput {
  /**
   * sha256 over H's `canonicalJson` of `blocks` (compute with `outputDigest`), so every block —
   * text or not — is bound by type, MIME type, and data digest.
   */
  sha256: string;
  /** UTF-8 bytes of the text output (text blocks joined with "\n"). */
  bytes: number;
  lines: number;
  /** First N lines, each capped at 400 characters. */
  head: string[];
  /** True when lines beyond N exist or a head line was cut. */
  headTruncated: boolean;
  /** Content blocks that are not text (for example images); bound by `sha256` through `blocks`. */
  nonTextBlocks: number;
  /** Per-block canonical encoding, kept even when no artifact retains the full output. */
  blocks?: EvidenceOutputBlock[];
}

export interface Evidence {
  actionId: string;
  toolCallId: string;
  toolName: string;
  outcome: EvidenceOutcome;
  /** Known process exit code; null when the tool reports none. */
  exitCode: number | null;
  /**
   * Present (true) when host fields contradicted each other, e.g. `isError:false` with a nonzero
   * exit code, `timedOut`, or `cancelled`/`aborted`; the outcome is then the conservative one.
   */
  conflict?: true;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  output: EvidenceOutput;
  /** Run-directory-relative path of the full output, or null when not retained. */
  artifactRef: string | null;
}

export interface ToolResultInput {
  actionId: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  content: unknown;
  details?: unknown;
  /** Epoch milliseconds supplied by the host event. */
  startedAt: number;
  endedAt: number;
}

export interface EvidenceOptions {
  /** Lines kept in the head summary; default 20. */
  summaryLines?: number;
  /** "full" retains the complete text output under `artifacts/`; default "none". */
  artifacts?: "none" | "full";
}

/** Full output to persist at `ref` (run-directory relative); written by `writeRunArtifacts`. */
export interface EvidenceArtifact {
  ref: string;
  text: string;
}

export interface RecordedToolResult {
  evidence: Evidence;
  artifact: EvidenceArtifact | null;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw Error(`Evidence ${label} must be a non-empty string.`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw Error(`Evidence ${label} must be a finite non-negative number.`);
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function blockDigest(type: string, mimeType: string | null, data: string): EvidenceOutputBlock {
  return { type, mimeType, sha256: sha256Hex(data), bytes: Buffer.byteLength(data, "utf8") };
}

function outputBlocks(content: unknown): { text: string; nonTextBlocks: number; blocks: EvidenceOutputBlock[] } {
  if (typeof content === "string") return { text: content, nonTextBlocks: 0, blocks: [blockDigest("text", null, content)] };
  if (!Array.isArray(content)) throw Error("Evidence content must be a string or an array of content blocks.");
  const texts: string[] = [];
  const blocks: EvidenceOutputBlock[] = [];
  let nonTextBlocks = 0;
  for (const block of content) {
    const b = record(block);
    const mimeType = typeof b?.mimeType === "string" ? b.mimeType : null;
    if (b?.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
      blocks.push(blockDigest("text", mimeType, b.text));
      continue;
    }
    nonTextBlocks++;
    const type = typeof b?.type === "string" ? b.type : "unknown";
    blocks.push(blockDigest(type, mimeType, typeof b?.data === "string" ? b.data : canonicalJson(block ?? null)));
  }
  return { text: texts.join("\n"), nonTextBlocks, blocks };
}

/** Output digest of a host tool result's `content`, as recorded in `Evidence.output.sha256`. */
export function outputDigest(content: unknown): string {
  return sha256Hex(canonicalJson(outputBlocks(content).blocks));
}

function classify(input: ToolResultInput, text: string): { outcome: EvidenceOutcome; exitCode: number | null; conflict: boolean } {
  // Explicit host details come first; `isError` never overrides them.
  const details = record(input.details);
  const declared = details?.exitCode;
  let exitCode = typeof declared === "number" && Number.isInteger(declared) ? declared : null;
  const timedOut = details?.timedOut === true;
  const cancelled = details?.cancelled === true || details?.aborted === true;
  if (!input.isError) {
    const conflict = timedOut || cancelled || (exitCode !== null && exitCode !== 0);
    if (timedOut) return { outcome: "timeout", exitCode, conflict };
    if (cancelled) return { outcome: "cancelled", exitCode, conflict };
    if (conflict) return { outcome: "error", exitCode, conflict };
    // Pi's shell tool only returns a non-error result for exit code 0.
    if (exitCode === null && input.toolName === "bash") exitCode = 0;
    return { outcome: "ok", exitCode, conflict: false };
  }
  // Trailing status line written by Pi's shell tool on failure (core/tools/bash.js).
  const trimmed = text.trimEnd();
  const status = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  const exited = /^Command exited with code (-?\d+)$/.exec(status);
  if (exitCode === null && exited) exitCode = Number(exited[1]);
  // An error result declaring exit code 0 contradicts itself; it stays a failure.
  const conflict = exitCode === 0;
  if (timedOut || /^Command timed out after \d+(\.\d+)? seconds$/.test(status)) return { outcome: "timeout", exitCode, conflict };
  if (cancelled || status === "Command aborted") return { outcome: "cancelled", exitCode, conflict };
  return { outcome: "error", exitCode, conflict };
}

function summaryLines(options: EvidenceOptions): number {
  const n = options.summaryLines ?? DEFAULT_SUMMARY_LINES;
  if (!Number.isInteger(n) || n < 0 || n > MAX_SUMMARY_LINES) throw Error(`summaryLines must be an integer in [0, ${MAX_SUMMARY_LINES}].`);
  return n;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build evidence for one completed host tool call. Throws on malformed host input. */
export function recordToolResult(input: ToolResultInput, options: EvidenceOptions = {}): RecordedToolResult {
  const actionId = nonEmpty(input.actionId, "actionId");
  const toolCallId = nonEmpty(input.toolCallId, "toolCallId");
  const toolName = nonEmpty(input.toolName, "toolName");
  if (typeof input.isError !== "boolean") throw Error("Evidence isError must be a boolean.");
  const startedAt = timestamp(input.startedAt, "startedAt");
  const endedAt = timestamp(input.endedAt, "endedAt");
  if (endedAt < startedAt) throw Error("Evidence endedAt precedes startedAt.");
  const n = summaryLines(options);
  const mode = options.artifacts ?? "none";
  if (mode !== "none" && mode !== "full") throw Error("artifacts must be \"none\" or \"full\".");

  const { text, nonTextBlocks, blocks } = outputBlocks(input.content);
  const { outcome, exitCode, conflict } = classify(input, text);
  const lines = text.length === 0 ? [] : text.split("\n");
  let cut = false;
  const head = lines.slice(0, n).map((line) => {
    if (line.length <= MAX_SUMMARY_LINE_CHARS) return line;
    cut = true;
    return line.slice(0, MAX_SUMMARY_LINE_CHARS);
  });
  const sha256 = sha256Hex(canonicalJson(blocks));
  const artifact = mode === "full" ? { ref: `artifacts/${sha256}.txt`, text } : null;
  return {
    evidence: {
      actionId,
      toolCallId,
      toolName,
      outcome,
      exitCode,
      ...(conflict ? { conflict: true as const } : {}),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      output: {
        sha256,
        bytes: Buffer.byteLength(text, "utf8"),
        lines: lines.length,
        head,
        headTruncated: cut || lines.length > n,
        nonTextBlocks,
        blocks,
      },
      artifactRef: artifact?.ref ?? null,
    },
    artifact,
  };
}

/**
 * Binds tool results to actions by `toolCallId`, recorded when the host issues the call.
 * Results of parallel calls may arrive in any order; arrival order never decides the action.
 */
export class EvidenceLedger {
  readonly #actionByCall = new Map<string, string>();
  readonly #evidence = new Map<string, Evidence>();
  readonly #options: EvidenceOptions;

  constructor(options: EvidenceOptions = {}) {
    summaryLines(options);
    this.#options = options;
  }

  /** Register a host-issued tool call before its result can arrive. */
  expect(toolCallId: string, actionId: string): void {
    nonEmpty(toolCallId, "toolCallId");
    nonEmpty(actionId, "actionId");
    const existing = this.#actionByCall.get(toolCallId);
    if (existing !== undefined && existing !== actionId) throw Error(`toolCallId ${toolCallId} is already bound to another action.`);
    this.#actionByCall.set(toolCallId, actionId);
  }

  /** Record a result; the action comes from the registered `toolCallId`, never from the caller. */
  accept(result: Omit<ToolResultInput, "actionId">): RecordedToolResult {
    const actionId = this.#actionByCall.get(result.toolCallId);
    if (actionId === undefined) throw Error(`Unknown toolCallId ${String(result.toolCallId)}.`);
    if (this.#evidence.has(result.toolCallId)) throw Error(`Duplicate result for toolCallId ${result.toolCallId}.`);
    const recorded = recordToolResult({ ...result, actionId }, this.#options);
    this.#evidence.set(result.toolCallId, recorded.evidence);
    return recorded;
  }

  /** Evidence for one action, ordered by `toolCallId` registration order. */
  forAction(actionId: string): Evidence[] {
    const out: Evidence[] = [];
    for (const [toolCallId, owner] of this.#actionByCall) {
      const evidence = this.#evidence.get(toolCallId);
      if (owner === actionId && evidence) out.push(evidence);
    }
    return out;
  }

  /** Registered calls whose result has not arrived. */
  pending(): string[] {
    return [...this.#actionByCall.keys()].filter((id) => !this.#evidence.has(id));
  }
}

export type ChangeKind = "added" | "modified" | "deleted";
export interface FileChange {
  path: string;
  change: ChangeKind;
  before: string | null;
  after: string | null;
}

function digests(value: Record<string, string>, label: string): Map<string, string> {
  if (!record(value)) throw Error(`Changeset ${label} must be a path → sha256 record.`);
  const out = new Map<string, string>();
  for (const [path, sha] of Object.entries(value)) {
    if (path.length === 0 || typeof sha !== "string" || !SHA256.test(sha)) throw Error(`Changeset ${label} has an invalid entry for ${JSON.stringify(path)}.`);
    out.set(path, sha);
  }
  return out;
}

/**
 * Compare file digests before and after a changeset. A path absent from a side did not exist
 * there. Unchanged files are omitted; output is sorted by path.
 */
export function summarizeChangeset(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const a = digests(before, "before");
  const b = digests(after, "after");
  const changes: FileChange[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = a.get(path) ?? null;
    const now = b.get(path) ?? null;
    if (was === now) continue;
    changes.push({ path, change: was === null ? "added" : now === null ? "deleted" : "modified", before: was, after: now });
  }
  return changes;
}
