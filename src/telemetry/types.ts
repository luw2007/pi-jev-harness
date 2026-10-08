export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** `route_model` was removed with model routing (T051); old lines carrying it are skipped. */
export const TELEMETRY_KINDS = [
  "route_tools",
  "route_plan",
  "jev_attempt",
  "action",
  "review",
  "completion",
  "continuation",
  "context",
  "diagnostic",
] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

export const TELEMETRY_OUTCOMES = [
  "ok",
  "fallback",
  "rejected",
  "blocked",
  "withheld",
  "unavailable",
  "timeout",
  "error",
  "skipped",
] as const;
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];

/**
 * Correlation IDs carry a fixed prefix plus a lowercase UUID, produced by the caller
 * (`run_<uuid>`, `dec_<uuid>`, `att_<uuid>`). Anything else rejects the whole event, so free text
 * or a key can never ride along in an ID slot.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const TELEMETRY_ID_PATTERNS = {
  runId: new RegExp(`^run_${UUID}$`),
  decisionId: new RegExp(`^dec_${UUID}$`),
  attemptId: new RegExp(`^att_${UUID}$`),
} as const;

/** Every `source` a record may carry. Anything outside this set rejects the whole event. */
export const TELEMETRY_SOURCES = [
  // One physical Jev request, by attempt status.
  "jev:ok",
  "jev:http_error",
  "jev:timeout",
  "jev:aborted",
  "jev:too_large",
  "jev:malformed",
  "jev:network_error",
  // Tool routing result.
  "tools:selected",
  "tools:withheld",
  "tools:needs_clarification",
  "tools:no_match",
  "tools:unavailable",
  // Tool bundle application in mode `on` (same decisionId as the route): applied and verified by
  // read-back; read-back mismatch (restored); native tools kept because routing gave no bundle;
  // a mid-task external change kept; owned removals given back at task end.
  "tools:applied",
  "tools:apply_mismatch",
  "tools:native_kept",
  "tools:external_change_kept",
  "tools:restored",
  // Route withheld before any Jev request.
  "outbound:not_authorized",
  "outbound:credential_detected",
  // OMP context (T105 L4): C8 compaction applied / recorded only / left to native; proactive
  // compaction started / recorded only; request reduction skipped by the cache guard.
  "compaction:applied",
  "compaction:would_apply",
  "compaction:native",
  "proactive:compact",
  "proactive:would_compact",
  "context:cache_guard",
  // Diagnostics.
  "adapter:duplicate_load",
  // Host version/profile unknown, so adapter capabilities are off.
  "adapter:no_profile",
  // Legacy @omp-jev/harness present, so the OMP adapter is forced off (T105).
  "adapter:legacy_conflict",
] as const;
export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number];

/**
 * `diagnostic` events report host/adapter conditions, not routing decisions, so they never
 * count toward route statistics. Their `source` is required and limited to this set.
 */
export const TELEMETRY_DIAGNOSTIC_SOURCES = ["adapter:duplicate_load", "adapter:no_profile", "adapter:legacy_conflict"] as const satisfies readonly TelemetrySource[];
export type TelemetryDiagnosticSource = (typeof TELEMETRY_DIAGNOSTIC_SOURCES)[number];

/** Known token counts; each field is `null` when the provider did not report it (never 0). */
export interface TelemetryTokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

interface TelemetryEventBase<K extends TelemetryKind> {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  /** Epoch milliseconds from the injected clock. */
  ts: number;
  runId: string;
  decisionId: string;
  attemptId?: string;
  kind: K;
  outcome: TelemetryOutcome;
  durationMs: number;
  /** `null` = usage unknown. */
  tokens: TelemetryTokens | null;
  /** `null` = cost unknown. */
  costUsd: number | null;
  source?: TelemetrySource;
  /** `jev_attempt` only: one provider-chain step. Content-free: no key, url or task text. */
  chain?: TelemetryChainStep;
}

/** Provider ids are config names; anything outside this pattern drops the `chain` field. */
export const TELEMETRY_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TELEMETRY_CHAIN_OUTCOMES = [
  "ok", "invalid_request", "request_too_large", "http_error", "timeout", "aborted", "too_large", "malformed",
  "network_error", "no_provider_available", "no_key", "budget_exhausted",
] as const;
export interface TelemetryChainStep {
  providerId: string;
  outcome: (typeof TELEMETRY_CHAIN_OUTCOMES)[number];
  fellBack: boolean;
  httpStatus?: number;
}

type TelemetryEventOf<K extends TelemetryKind> = K extends "diagnostic"
  ? Omit<TelemetryEventBase<K>, "source"> & { source: TelemetryDiagnosticSource }
  : TelemetryEventBase<K>;

/** Discriminated on `kind`; the persisted record carries only these fields. */
export type TelemetryEvent = { [K in TelemetryKind]: TelemetryEventOf<K> }[TelemetryKind];

/** Caller input: writer stamps `schemaVersion` and `ts`; optional metrics default to unknown. */
export type TelemetryInput = {
  [K in TelemetryKind]: Omit<TelemetryEventOf<K>, "schemaVersion" | "ts" | "tokens" | "costUsd"> & {
    tokens?: Partial<TelemetryTokens> | null;
    costUsd?: number | null;
  };
}[TelemetryKind];

export interface TelemetryDiagnostics {
  written: number;
  /** Events dropped because they failed the whitelist. */
  rejected: number;
  /** Filesystem failures swallowed so the task result is unaffected. */
  writeFailures: number;
}

export interface DurationStats {
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

export interface KnownSum {
  /** `null` when no event reported the value. */
  sum: number | null;
  known: number;
  total: number;
  /** known / total; `null` when total is 0. */
  coverage: number | null;
}

export interface TelemetryGroup {
  kind: TelemetryKind;
  outcome: TelemetryOutcome;
  events: number;
  /** `jev_attempt` only: provider-chain steps, reported apart from physical requests (each call yields both). */
  chainStep?: true;
  durationMs: DurationStats;
  tokens: Record<keyof TelemetryTokens, KnownSum>;
  costUsd: KnownSum;
}

export interface TelemetryReport {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  events: number;
  duplicatesDropped: number;
  byKind: Partial<Record<TelemetryKind, number>>;
  byOutcome: Partial<Record<TelemetryOutcome, number>>;
  durationMs: DurationStats;
  /** Events with any known token field / all events. */
  tokenCoverage: { known: number; total: number; ratio: number | null };
  groups: TelemetryGroup[];
}

export interface FileReport extends TelemetryReport {
  files: number;
  lines: number;
  skipped: number;
}
