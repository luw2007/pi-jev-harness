/**
 * Production runtime receipt (technical §5 `RuntimeReceipt`, §4.2 content binding and replay).
 * Reuses H's `canonicalJson` for the sha256 binding; H's v1 receipt (fixtureId, good/bad arm,
 * constant `applied:false`) is not reused. Pure: no clock, environment, network, or filesystem.
 * SHA-256 here is an integrity check only, not authentication: sha256 只做完整性核对，不防伪造。
 * Anyone holding a receipt can edit it and recompute the digest; only values compared against
 * `TrustedCurrent` in `replayReceipt` are checked against the host.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../../vendor/jev-harness/src/audit/receipt.ts";
import { EVIDENCE_OUTCOMES, type Evidence } from "./evidence.ts";
import type { AuthorizationScope } from "./types.ts";

export const RUNTIME_RECEIPT_SCHEMA_VERSION = 1 as const;

export const EXECUTION_STATUSES = ["not_requested", "blocked", "executed", "failed"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const VERIFICATION_STATUSES = ["passed", "failed", "unavailable", "not_run"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Digest (sha256 hex) and schema/format version of a real host object. */
export interface DigestRef {
  digest: string;
  version: string;
}

export interface ReceiptExecution {
  status: ExecutionStatus;
  /** Why the action was blocked or failed; null otherwise. */
  reason: string | null;
  evidence: Evidence[];
}

export interface ReceiptVerification {
  status: VerificationStatus;
  /** toolCallIds of the evidence backing this verification. */
  evidenceRefs: string[];
  note: string | null;
}

/** Only provider-reported values; unknown stays null, never zero. */
export interface ReceiptUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export interface RuntimeReceipt {
  schemaVersion: typeof RUNTIME_RECEIPT_SCHEMA_VERSION;
  runId: string;
  sessionId: string;
  branchId: string;
  generation: number;
  actionId: string;
  snapshot: DigestRef;
  /** Exact serialized Jev request; null when no request was sent. */
  request: DigestRef | null;
  response: DigestRef | null;
  /** `AuthorizationScope.id` of the host grant; null when the action ran under no recorded grant. */
  authorizationRef: AuthorizationScope["id"] | null;
  execution: ReceiptExecution;
  verification: ReceiptVerification;
  /** null when the provider reported no usage at all. */
  usage: ReceiptUsage | null;
}

export interface SealedRuntimeReceipt {
  receipt: RuntimeReceipt;
  integrity: { algorithm: "sha256"; digest: string };
}

export interface RuntimeReceiptInput extends Omit<RuntimeReceipt, "schemaVersion" | "usage" | "request" | "response" | "authorizationRef" | "verification"> {
  request?: DigestRef | null;
  response?: DigestRef | null;
  authorizationRef?: AuthorizationScope["id"] | null;
  verification?: ReceiptVerification;
  /** Raw provider usage; missing or non-finite fields become null. */
  usage?: Partial<Record<keyof ReceiptUsage, unknown>> | null;
}

/** Trusted current host state; fields the receipt binds must be present to verify. */
export interface TrustedCurrent {
  runId?: string;
  sessionId?: string;
  branchId?: string;
  generation?: number;
  actionId?: string;
  snapshot?: DigestRef;
  request?: DigestRef | null;
  response?: DigestRef | null;
  authorizationRef?: AuthorizationScope["id"] | null;
  /** toolCallId → `outputDigest` of the tool result content (`Evidence.output.sha256`). */
  outputs?: Record<string, string>;
  /** Execution summary the host trusts; compared when present. */
  execution?: { status: ExecutionStatus };
  /** Verification summary the host trusts; compared when present. */
  verification?: { status: VerificationStatus };
}

/** Always attached to replay results. */
export const REPLAY_INTEGRITY_NOTE = "sha256 只做完整性核对，不防伪造：持有收据者可改写内容后重算摘要。";
export const REPLAY_UNCHECKED_NOTES = {
  both: "执行/验证状态未核对：可信当前状态未提供 execution 与 verification。",
  execution: "执行状态未核对：可信当前状态未提供 execution。",
  verification: "验证状态未核对：可信当前状态未提供 verification。",
} as const;

/** `notes` always holds `REPLAY_INTEGRITY_NOTE`, plus an unchecked note when applicable. */
export type ReplayOutcome =
  | { status: "match"; notes?: string[] }
  | { status: "mismatch"; reasons: string[]; notes?: string[] }
  | { status: "cannot_verify"; missing: string[]; notes?: string[] };

const SHA256 = /^[a-f0-9]{64}$/;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error(`Malformed ${label}.`);
  return value as Record<string, unknown>;
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw Error(`Malformed ${label}.`);
  return value;
}

function nullableStr(value: unknown, label: string): string | null {
  return value === null ? null : str(value, label);
}

function digestRef(value: unknown, label: string): DigestRef {
  const ref = obj(value, label);
  if (typeof ref.digest !== "string" || !SHA256.test(ref.digest)) throw Error(`Malformed ${label} digest.`);
  return { digest: ref.digest, version: str(ref.version, `${label} version`) };
}

function generation(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("Malformed generation.");
  return value;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function evidenceItem(value: unknown, actionId: string): Evidence {
  const e = obj(value, "evidence");
  const output = obj(e.output, "evidence output");
  if (e.actionId !== actionId) throw Error("Evidence belongs to another action.");
  if (!(EVIDENCE_OUTCOMES as readonly unknown[]).includes(e.outcome)) throw Error("Malformed evidence outcome.");
  if (e.exitCode !== null && !Number.isInteger(e.exitCode)) throw Error("Malformed evidence exit code.");
  if (typeof output.sha256 !== "string" || !SHA256.test(output.sha256)) throw Error("Malformed evidence output digest.");
  if (e.artifactRef !== null && (typeof e.artifactRef !== "string" || !/^artifacts\/[a-f0-9]{64}\.txt$/.test(e.artifactRef)))
    throw Error("Malformed evidence artifactRef.");
  str(e.toolCallId, "evidence toolCallId");
  str(e.toolName, "evidence toolName");
  for (const key of ["startedAt", "endedAt", "durationMs"] as const)
    if (nonNegative(e[key]) === null) throw Error(`Malformed evidence ${key}.`);
  for (const key of ["bytes", "lines", "nonTextBlocks"] as const)
    if (!Number.isSafeInteger(output[key]) || (output[key] as number) < 0) throw Error(`Malformed evidence output ${key}.`);
  if (!Array.isArray(output.head) || !output.head.every((line) => typeof line === "string") || typeof output.headTruncated !== "boolean")
    throw Error("Malformed evidence output head.");
  return e as unknown as Evidence;
}

function execution(value: unknown, actionId: string): ReceiptExecution {
  const x = obj(value, "execution");
  if (!(EXECUTION_STATUSES as readonly unknown[]).includes(x.status)) throw Error("Malformed execution status.");
  const status = x.status as ExecutionStatus;
  if (!Array.isArray(x.evidence)) throw Error("Malformed execution evidence.");
  const evidence = x.evidence.map((item) => evidenceItem(item, actionId));
  if (new Set(evidence.map((e) => e.toolCallId)).size !== evidence.length) throw Error("Duplicate execution evidence.");
  const reason = nullableStr(x.reason, "execution reason");
  if ((status === "not_requested" || status === "blocked") && evidence.length > 0) throw Error(`A ${status} action cannot carry execution evidence.`);
  if ((status === "blocked" || status === "failed") && reason === null) throw Error(`A ${status} action needs a reason.`);
  if (status === "executed" && (evidence.length === 0 || evidence.some((e) => e.outcome !== "ok")))
    throw Error("An executed action needs evidence and only successful results.");
  if (status === "failed" && evidence.length > 0 && evidence.every((e) => e.outcome === "ok"))
    throw Error("A failed action with evidence needs at least one unsuccessful result.");
  return { status, reason, evidence };
}

function verification(value: unknown, known: ReadonlySet<string>): ReceiptVerification {
  const v = obj(value, "verification");
  if (!(VERIFICATION_STATUSES as readonly unknown[]).includes(v.status)) throw Error("Malformed verification status.");
  if (!Array.isArray(v.evidenceRefs) || !v.evidenceRefs.every((ref) => typeof ref === "string" && known.has(ref)))
    throw Error("Verification references unknown evidence.");
  return { status: v.status as VerificationStatus, evidenceRefs: v.evidenceRefs as string[], note: nullableStr(v.note, "verification note") };
}

function usage(value: unknown): ReceiptUsage | null {
  if (value === null || value === undefined) return null;
  const raw = obj(value, "usage");
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, nonNegative(raw[key])])) as unknown as ReceiptUsage;
}

/** Structural validation shared by creation and replay; returns a plain-data copy. */
function parseReceipt(value: unknown): RuntimeReceipt {
  const r = obj(value, "receipt");
  if (r.schemaVersion !== RUNTIME_RECEIPT_SCHEMA_VERSION) throw Error("Unsupported receipt schemaVersion.");
  const actionId = str(r.actionId, "actionId");
  const exec = execution(r.execution, actionId);
  return {
    schemaVersion: RUNTIME_RECEIPT_SCHEMA_VERSION,
    runId: str(r.runId, "runId"),
    sessionId: str(r.sessionId, "sessionId"),
    branchId: str(r.branchId, "branchId"),
    generation: generation(r.generation),
    actionId,
    snapshot: digestRef(r.snapshot, "snapshot"),
    request: r.request === null ? null : digestRef(r.request, "request"),
    response: r.response === null ? null : digestRef(r.response, "response"),
    authorizationRef: nullableStr(r.authorizationRef, "authorizationRef"),
    execution: exec,
    verification: verification(r.verification, new Set(exec.evidence.map((e) => e.toolCallId))),
    usage: r.usage === null ? null : usage(r.usage),
  };
}

const digestOf = (receipt: RuntimeReceipt) => createHash("sha256").update(canonicalJson(receipt), "utf8").digest("hex");

/** Validate and seal a receipt with a sha256 over H's canonical JSON. Throws on malformed input. */
export function createRuntimeReceipt(input: RuntimeReceiptInput): SealedRuntimeReceipt {
  const receipt = parseReceipt(JSON.parse(canonicalJson({
    ...input,
    schemaVersion: RUNTIME_RECEIPT_SCHEMA_VERSION,
    request: input.request ?? null,
    response: input.response ?? null,
    authorizationRef: input.authorizationRef ?? null,
    verification: input.verification ?? { status: "not_run", evidenceRefs: [], note: null },
    usage: usage(input.usage),
  })));
  return { receipt, integrity: { algorithm: "sha256", digest: digestOf(receipt) } };
}

type Bound = "runId" | "sessionId" | "branchId" | "generation" | "actionId" | "snapshot" | "request" | "response" | "authorizationRef";
const BOUND: readonly Bound[] = ["runId", "sessionId", "branchId", "generation", "actionId", "snapshot", "request", "response", "authorizationRef"];

/**
 * Offline check of a recorded receipt against trusted current host state. Never trusts values
 * carried by the receipt as the expectation and never re-runs any action.
 */
export function replayReceipt(input: unknown, trustedCurrent: TrustedCurrent): ReplayOutcome {
  let receipt: RuntimeReceipt;
  try {
    const envelope = obj(typeof input === "string" ? JSON.parse(input) : input, "sealed receipt");
    const integrity = obj(envelope.integrity, "integrity");
    receipt = parseReceipt(JSON.parse(canonicalJson(envelope.receipt)));
    if (integrity.algorithm !== "sha256" || integrity.digest !== digestOf(receipt) ||
        canonicalJson(receipt) !== canonicalJson(envelope.receipt)) throw Error("Receipt digest mismatch.");
  } catch (error) {
    return { status: "mismatch", reasons: [error instanceof Error ? error.message : "Unreadable receipt."], notes: [REPLAY_INTEGRITY_NOTE] };
  }

  const current = trustedCurrent !== null && typeof trustedCurrent === "object" ? trustedCurrent : {};
  const missing: string[] = [];
  const reasons: string[] = [];
  for (const key of BOUND) {
    const recorded = receipt[key];
    const has = Object.hasOwn(current, key) && current[key] !== undefined;
    if (!has) {
      if (recorded !== null) missing.push(key);
      continue;
    }
    let actual: unknown;
    try {
      actual = canonicalJson(current[key]);
    } catch {
      missing.push(key);
      continue;
    }
    if (actual !== canonicalJson(recorded)) reasons.push(`${key} differs from the trusted current state.`);
  }

  if (receipt.execution.evidence.length > 0) {
    const outputs = current.outputs !== null && typeof current.outputs === "object" ? current.outputs : undefined;
    for (const e of receipt.execution.evidence) {
      const actual = outputs && Object.hasOwn(outputs, e.toolCallId) ? outputs[e.toolCallId] : undefined;
      if (typeof actual !== "string") missing.push(`outputs.${e.toolCallId}`);
      else if (actual !== e.output.sha256) reasons.push(`Output of ${e.toolCallId} differs from the recorded digest.`);
    }
  }

  const notes: string[] = [REPLAY_INTEGRITY_NOTE];
  const summaries = [
    ["execution", current.execution, receipt.execution.status],
    ["verification", current.verification, receipt.verification.status],
  ] as const;
  const unchecked: string[] = [];
  for (const [key, trusted, recorded] of summaries) {
    if (trusted === undefined || trusted === null) unchecked.push(key);
    else if (typeof trusted !== "object" || trusted.status !== recorded) reasons.push(`${key} status differs from the trusted current state.`);
  }
  if (unchecked.length === 2) notes.push(REPLAY_UNCHECKED_NOTES.both);
  else if (unchecked.length === 1) notes.push(REPLAY_UNCHECKED_NOTES[unchecked[0] as "execution" | "verification"]);

  if (reasons.length > 0) return { status: "mismatch", reasons, notes };
  if (missing.length > 0) return { status: "cannot_verify", missing, notes };
  return { status: "match", notes };
}
