/**
 * Content-free audit log: stop / route / autorun / approval decisions as JSONL.
 *
 * Every line is rebuilt from `AUDIT_SCHEMA`: event, outcome and mode must be members of the kind's
 * enums, metrics must be named in the kind's allowlist with the declared type, ids must be
 * prefixed UUIDs. Task text, prompts, paths and keys therefore cannot reach disk. Lines use the legacy `omp-jev-extensions` telemetry shape
 * (`plugin`, `event`, `mode`, `outcome`, `durationMs`, `metrics`) so `aggregateAudit` reports the
 * same core metrics as the legacy `telemetry/report.js`.
 *
 * Rotation: `audit.jsonl` is renamed to `audit.<seq>.jsonl` before a write would exceed the size
 * limit; the limit honours `OMP_TELEMETRY_MAX_BYTES` (same floor as the legacy writer).
 */
import * as nodeFs from "node:fs/promises";
import { dirname, join } from "node:path";
import { percentile } from "./report.ts";
import type { TelemetryFs } from "./writer.ts";

export const AUDIT_KINDS = ["stop", "route", "autorun", "approval"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AUDIT_FILE = "audit.jsonl";
export const ROTATED_AUDIT_PATTERN = /^audit\.(\d+)\.jsonl$/;
const RECORD_LIMIT_BYTES = 4096;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Ids are bare UUIDs with a fixed prefix; nothing longer or free-form. */
const ID = /^(run|dec)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HOST_MODES = ["off", "shadow", "on"] as const;
const FAILURES = ["skipped", "withheld", "unavailable", "budget", "timeout", "invalid", "off", "failed"] as const;

/** Legacy `METRIC_TYPES` (omp-jev-extensions telemetry/writer.js): shared by every kind. */
const COMMON_METRICS = {
  inputTokens: "number", outputTokens: "number", cacheReadTokens: "number", cacheWriteTokens: "number",
  requests: "number", jevRequests: "number",
  cacheHits: "number", cacheMisses: "number", cacheRead: "number", cacheHit: "boolean",
  inputCharacters: "number", outputCharacters: "number", charsBefore: "number", charsAfter: "number",
} as const;

type MetricType = "number" | "boolean";
interface KindSchema {
  events: readonly string[];
  outcomes: readonly string[];
  modes: readonly string[];
  metrics: Readonly<Record<string, MetricType>>;
}

/**
 * Explicit enums per kind. Anything outside them is rejected (event/outcome/mode) or dropped
 * (metrics). Lanes adding a new category extend this table; there is no free-form escape hatch.
 */
export const AUDIT_SCHEMA: Readonly<Record<AuditKind, KindSchema>> = {
  route: {
    events: ["jev_plan"],
    outcomes: ["ok", ...FAILURES],
    modes: ["direct", "single", "parallel", "dag"],
    metrics: { ...COMMON_METRICS, candidates: "number", slices: "number", pinned: "boolean", degraded: "boolean" },
  },
  autorun: {
    events: ["effort"],
    outcomes: ["low", "medium", "high", "xhigh", ...FAILURES],
    modes: HOST_MODES,
    metrics: { ...COMMON_METRICS, applied: "boolean" },
  },
  stop: {
    events: ["stop", "continue", "settle", "complete"],
    outcomes: ["ok", "allowed", "blocked", "continued", "complete", "incomplete", ...FAILURES],
    modes: HOST_MODES,
    metrics: { ...COMMON_METRICS, continues: "number", maxContinues: "number" },
  },
  approval: {
    events: ["tool_call", "ask"],
    outcomes: ["ok", "approved", "denied", "asked", ...FAILURES],
    modes: HOST_MODES,
    metrics: { ...COMMON_METRICS },
  },
};

/** Audit directory for a host: sibling of its telemetry directory (`<harnessDir>/audit`). */
export function auditDirFor(telemetryDir: string): string {
  return join(dirname(telemetryDir), "audit");
}

export interface AuditInput {
  kind: AuditKind;
  /** One of `AUDIT_SCHEMA[kind].events`. */
  event: string;
  /** One of `AUDIT_SCHEMA[kind].outcomes`. */
  outcome: string;
  /** One of `AUDIT_SCHEMA[kind].modes`. */
  mode?: string;
  durationMs?: number;
  runId?: string;
  decisionId?: string;
  /** Only `AUDIT_SCHEMA[kind].metrics` names with the declared type are kept. */
  metrics?: Record<string, unknown>;
}

export interface AuditRecord {
  schemaVersion: 1;
  ts: number;
  timestamp: string;
  plugin: AuditKind;
  event: string;
  outcome: string;
  mode?: string;
  durationMs?: number;
  runId?: string;
  decisionId?: string;
  metrics?: Record<string, number | boolean>;
}

export interface AuditDiagnostics {
  written: number;
  rejected: number;
  writeFailures: number;
}

export interface AuditWriter {
  /** Never throws/rejects. Resolves true when the line reached disk. */
  record(input: AuditInput): Promise<boolean>;
  /** Resolves when every queued line has been attempted. */
  flush(): Promise<void>;
  diagnostics(): AuditDiagnostics;
}

export interface AuditWriterOptions {
  dir: string;
  now: () => number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides `OMP_TELEMETRY_MAX_BYTES`. */
  maxFileBytes?: number;
  fs?: TelemetryFs;
}

const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function metrics(value: unknown, allowed: KindSchema["metrics"]): Record<string, number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const safe: Record<string, number | boolean> = {};
  for (const [key, type] of Object.entries(allowed)) {
    if (!Object.hasOwn(raw, key)) continue;
    const v = raw[key];
    if (type === "boolean" && typeof v === "boolean") safe[key] = v;
    else if (type === "number" && nonNegative(v) !== undefined) safe[key] = v as number;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Whitelist rebuild; undefined when kind/event/outcome/mode is outside the kind's enums. */
export function sanitizeAudit(input: unknown, ts: number): AuditRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !Object.hasOwn(AUDIT_SCHEMA, raw.kind)) return undefined;
  const kind = raw.kind as AuditKind;
  const schema = AUDIT_SCHEMA[kind];
  const member = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);
  if (!member(schema.events, raw.event) || !member(schema.outcomes, raw.outcome)) return undefined;
  if (raw.mode !== undefined && !member(schema.modes, raw.mode)) return undefined;
  const duration = nonNegative(raw.durationMs);
  const safeMetrics = metrics(raw.metrics, schema.metrics);
  return {
    schemaVersion: 1,
    ts,
    timestamp: new Date(ts).toISOString(),
    plugin: kind,
    event: raw.event,
    outcome: raw.outcome,
    ...(raw.mode !== undefined ? { mode: raw.mode as string } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(typeof raw.runId === "string" && ID.test(raw.runId) ? { runId: raw.runId } : {}),
    ...(typeof raw.decisionId === "string" && ID.test(raw.decisionId) ? { decisionId: raw.decisionId } : {}),
    ...(safeMetrics ? { metrics: safeMetrics } : {}),
  };
}

/** Same rule as the legacy writer: `OMP_TELEMETRY_MAX_BYTES` when a number ≥ the record limit. */
export function auditMaxBytes(env: Readonly<Record<string, string | undefined>> = {}): number {
  const configured = Number(env.OMP_TELEMETRY_MAX_BYTES);
  return Number.isFinite(configured) && configured >= RECORD_LIMIT_BYTES ? Math.floor(configured) : DEFAULT_MAX_FILE_BYTES;
}

export function createAuditWriter(options: AuditWriterOptions): AuditWriter {
  const fs: TelemetryFs = options.fs ?? (nodeFs as unknown as TelemetryFs);
  const maxBytes = Math.max(RECORD_LIMIT_BYTES, options.maxFileBytes ?? auditMaxBytes(options.env));
  const path = join(options.dir, AUDIT_FILE);
  const stats: AuditDiagnostics = { written: 0, rejected: 0, writeFailures: 0 };
  let queue: Promise<unknown> = Promise.resolve();

  async function rotateIfNeeded(incoming: number): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    if (size + incoming <= maxBytes) return;
    let seq = 0;
    for (const name of await fs.readdir(options.dir)) {
      const match = ROTATED_AUDIT_PATTERN.exec(name);
      if (match) seq = Math.max(seq, Number(match[1]));
    }
    await fs.rename(path, join(options.dir, `audit.${seq + 1}.jsonl`));
  }

  async function write(line: string): Promise<boolean> {
    try {
      await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
      await rotateIfNeeded(Buffer.byteLength(line));
      await fs.appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      stats.written += 1;
      return true;
    } catch {
      stats.writeFailures += 1;
      return false;
    }
  }

  return {
    record(input) {
      let line: string | undefined;
      try {
        const safe = sanitizeAudit(input, options.now());
        line = safe ? `${JSON.stringify(safe)}\n` : undefined;
        if (line && Buffer.byteLength(line) > RECORD_LIMIT_BYTES) line = undefined;
      } catch {
        line = undefined;
      }
      if (!line) {
        stats.rejected += 1;
        return Promise.resolve(false);
      }
      const pending = line;
      const result = queue.then(() => write(pending));
      queue = result;
      return result;
    },
    flush: () => queue.then(() => undefined),
    diagnostics: () => ({ ...stats }),
  };
}

// ---- report (core metrics of the legacy telemetry/report.js) ----------------------------------

const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

export interface AuditGroup {
  plugin: string;
  event: string;
  mode: string;
  outcome: string;
  events: number;
  durationMs: { count: number; p50: number | null; p95: number | null; sum: number; coverage: number | null };
  usage: Record<(typeof USAGE_KEYS)[number], { sum: number | null; known: number; total: number; coverage: number | null }>;
  requests: { count: number | null; known: number; total: number; coverage: number | null };
  /** Legacy report.js `cache`; null counts when no line carried cache metrics. */
  cache: { reads: number | null; hits: number | null; misses: number | null; known: number; total: number; coverage: number | null; hitRate: number | null };
  /** Legacy report.js `characterReduction`; null counts when no line carried character metrics. */
  characterReduction: { inputCharacters: number | null; outputCharacters: number | null; reducedCharacters: number | null; known: number; total: number; coverage: number | null; rate: number | null };
}

/** Why a legacy metric shows N/A: no current writer records its inputs. */
export const AUDIT_NA_NOTE =
  "cache and characterReduction: N/A unless audit lines carry cacheHits/cacheRead/cacheMisses/cacheHit or charsBefore/charsAfter (inputCharacters/outputCharacters); no current OMP adapter capability records them.";

export interface AuditReport {
  schemaVersion: 1;
  files: number;
  lines: number;
  skipped: number;
  accepted: number;
  groups: AuditGroup[];
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

/** Aggregate audit lines by (plugin, event, mode, outcome); every line is re-sanitized first. */
export function aggregateAudit(lines: readonly string[]): Omit<AuditReport, "files"> {
  type Acc = { key: string[]; durations: number[]; usage: Record<string, { sum: number; known: number }>; requests: { sum: number; known: number }; events: number;
    cache: { reads: number; hits: number; misses: number; known: number }; chars: { input: number; output: number; known: number } };
  const groups = new Map<string, Acc>();
  let total = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    total += 1;
    let record: AuditRecord | undefined;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      record = parsed?.schemaVersion === 1 ? sanitizeAudit({ ...parsed, kind: parsed.plugin }, nonNegative(parsed.ts) ?? 0) : undefined;
    } catch {
      record = undefined;
    }
    if (!record) {
      skipped += 1;
      continue;
    }
    const key = [record.plugin, record.event, record.mode ?? "(none)", record.outcome];
    const id = JSON.stringify(key);
    let group = groups.get(id);
    if (!group) {
      group = { key, durations: [], usage: Object.fromEntries(USAGE_KEYS.map((k) => [k, { sum: 0, known: 0 }])), requests: { sum: 0, known: 0 }, events: 0,
        cache: { reads: 0, hits: 0, misses: 0, known: 0 }, chars: { input: 0, output: 0, known: 0 } };
      groups.set(id, group);
    }
    group.events += 1;
    if (record.durationMs !== undefined) group.durations.push(record.durationMs);
    const m = record.metrics ?? {};
    for (const k of USAGE_KEYS) {
      const value = nonNegative(m[k]);
      if (value !== undefined) {
        group.usage[k]!.sum += value;
        group.usage[k]!.known += 1;
      }
    }
    const requests = nonNegative(m.jevRequests) ?? nonNegative(m.requests);
    if (requests !== undefined) {
      group.requests.sum += requests;
      group.requests.known += 1;
    }
    // Same precedence as legacy report.js addRecord.
    const hits = nonNegative(m.cacheHits);
    const reads = nonNegative(m.cacheRead);
    const misses = nonNegative(m.cacheMisses);
    if (reads !== undefined && hits !== undefined) {
      group.cache.hits += hits;
      group.cache.reads += reads;
      group.cache.misses += misses ?? Math.max(0, reads - hits);
      group.cache.known += 1;
    } else if (hits !== undefined && misses !== undefined) {
      group.cache.hits += hits;
      group.cache.reads += hits + misses;
      group.cache.misses += misses;
      group.cache.known += 1;
    } else if (typeof m.cacheHit === "boolean") {
      group.cache.hits += m.cacheHit ? 1 : 0;
      group.cache.reads += 1;
      group.cache.misses += m.cacheHit ? 0 : 1;
      group.cache.known += 1;
    }
    const input = nonNegative(m.charsBefore) ?? nonNegative(m.inputCharacters);
    const output = nonNegative(m.charsAfter) ?? nonNegative(m.outputCharacters);
    if (input !== undefined && output !== undefined) {
      group.chars.input += input;
      group.chars.output += output;
      group.chars.known += 1;
    }
  }
  const finished = [...groups.values()].map((g): AuditGroup => {
    const sorted = [...g.durations].sort((a, b) => a - b);
    const n = g.events;
    const [plugin, event, mode, outcome] = g.key as [string, string, string, string];
    return {
      plugin, event, mode, outcome, events: n,
      durationMs: {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        sum: sorted.reduce((s, v) => s + v, 0),
        coverage: ratio(sorted.length, n),
      },
      usage: Object.fromEntries(USAGE_KEYS.map((k) => [k, { sum: g.usage[k]!.known === 0 ? null : g.usage[k]!.sum, known: g.usage[k]!.known, total: n, coverage: ratio(g.usage[k]!.known, n) }])) as AuditGroup["usage"],
      requests: { count: g.requests.known === 0 ? null : g.requests.sum, known: g.requests.known, total: n, coverage: ratio(g.requests.known, n) },
      cache: {
        reads: g.cache.known === 0 ? null : g.cache.reads,
        hits: g.cache.known === 0 ? null : g.cache.hits,
        misses: g.cache.known === 0 ? null : g.cache.misses,
        known: g.cache.known, total: n, coverage: ratio(g.cache.known, n),
        hitRate: ratio(g.cache.hits, g.cache.reads),
      },
      characterReduction: {
        inputCharacters: g.chars.known === 0 ? null : g.chars.input,
        outputCharacters: g.chars.known === 0 ? null : g.chars.output,
        reducedCharacters: g.chars.known === 0 ? null : g.chars.input - g.chars.output,
        known: g.chars.known, total: n, coverage: ratio(g.chars.known, n),
        rate: ratio(g.chars.input - g.chars.output, g.chars.input),
      },
    };
  }).sort((a, b) => a.plugin.localeCompare(b.plugin) || a.event.localeCompare(b.event) || a.mode.localeCompare(b.mode) || a.outcome.localeCompare(b.outcome));
  return { schemaVersion: 1, lines: total, skipped, accepted: total - skipped, groups: finished };
}

/** Read `audit.jsonl` plus rotated files in `dir`; null when the directory does not exist. */
export async function runAuditReport(dir: string): Promise<AuditReport | null> {
  let names: string[];
  try {
    names = (await nodeFs.readdir(dir)).filter((name) => name === AUDIT_FILE || ROTATED_AUDIT_PATTERN.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  const lines: string[] = [];
  for (const name of names) lines.push(...(await nodeFs.readFile(join(dir, name), "utf8")).split("\n"));
  return { ...aggregateAudit(lines), files: names.length };
}
