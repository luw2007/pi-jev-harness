// Adapted from omp-jev-extensions@0f93c809c2088c61fab4e613807e515ff9e65b1a:extensions/telemetry/writer.js (MIT)
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import {
  TELEMETRY_CHAIN_OUTCOMES,
  TELEMETRY_DIAGNOSTIC_SOURCES,
  TELEMETRY_PROVIDER_ID_PATTERN,
  TELEMETRY_ID_PATTERNS,
  TELEMETRY_KINDS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SOURCES,
  type TelemetryChainStep,
  type TelemetryDiagnostics,
  type TelemetryEvent,
  type TelemetryInput,
  type TelemetryKind,
  type TelemetryOutcome,
  type TelemetryTokens,
} from "./types.ts";

export const TELEMETRY_FILE = "events.jsonl";
/** Rotated files: `events.<seq>.jsonl`, seq increasing from 1. */
export const ROTATED_FILE_PATTERN = /^events\.(\d+)\.jsonl$/;
const RECORD_LIMIT_BYTES = 4096;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Subset of `node:fs/promises` the writer uses; injectable for tests. */
export interface TelemetryFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  stat(path: string): Promise<{ size: number }>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  appendFile(path: string, data: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
}

export interface TelemetryWriterOptions {
  dir: string;
  now: () => number;
  fs?: TelemetryFs;
  maxFileBytes?: number;
}

export interface TelemetryWriter {
  /** Never throws/rejects. Resolves true when the event reached disk. */
  record(event: TelemetryInput): Promise<boolean>;
  diagnostics(): TelemetryDiagnostics;
}

const KINDS: ReadonlySet<string> = new Set(TELEMETRY_KINDS);
const OUTCOMES: ReadonlySet<string> = new Set(TELEMETRY_OUTCOMES);
const DIAGNOSTIC_SOURCES: ReadonlySet<string> = new Set(TELEMETRY_DIAGNOSTIC_SOURCES);
const SOURCES: ReadonlySet<string> = new Set(TELEMETRY_SOURCES);

function id(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokens(value: unknown): TelemetryTokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const safe: TelemetryTokens = {
    input: nonNegative(raw.input) ?? null,
    output: nonNegative(raw.output) ?? null,
    cacheRead: nonNegative(raw.cacheRead) ?? null,
    cacheWrite: nonNegative(raw.cacheWrite) ?? null,
  };
  return Object.values(safe).some((v) => v !== null) ? safe : null;
}

function chainStep(value: unknown): TelemetryChainStep | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerId !== "string" || !TELEMETRY_PROVIDER_ID_PATTERN.test(raw.providerId)) return undefined;
  if (typeof raw.outcome !== "string" || !(TELEMETRY_CHAIN_OUTCOMES as readonly string[]).includes(raw.outcome)) return undefined;
  if (typeof raw.fellBack !== "boolean") return undefined;
  const status = raw.httpStatus;
  const httpStatus = Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? (status as number) : undefined;
  return { providerId: raw.providerId, outcome: raw.outcome as TelemetryChainStep["outcome"], fellBack: raw.fellBack, ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

/**
 * Rebuild an event from the whitelist. Unknown fields are never copied; free-text strings
 * are rejected rather than escaped. Returns undefined when a required field is invalid.
 */
export function sanitizeEvent(raw: unknown, ts: unknown): TelemetryEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const stamp = nonNegative(ts);
  const runId = id(input.runId, TELEMETRY_ID_PATTERNS.runId);
  const decisionId = id(input.decisionId, TELEMETRY_ID_PATTERNS.decisionId);
  const durationMs = nonNegative(input.durationMs);
  if (stamp === undefined || !runId || !decisionId || durationMs === undefined) return undefined;
  if (typeof input.kind !== "string" || !KINDS.has(input.kind)) return undefined;
  if (typeof input.outcome !== "string" || !OUTCOMES.has(input.outcome)) return undefined;
  if (input.attemptId !== undefined && !id(input.attemptId, TELEMETRY_ID_PATTERNS.attemptId)) return undefined;
  if (input.source !== undefined && (typeof input.source !== "string" || !SOURCES.has(input.source))) return undefined;
  if (input.kind === "diagnostic" && (typeof input.source !== "string" || !DIAGNOSTIC_SOURCES.has(input.source))) return undefined;

  const event = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    ts: stamp,
    runId,
    decisionId,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId as string } : {}),
    kind: input.kind as TelemetryKind,
    outcome: input.outcome as TelemetryOutcome,
    durationMs,
    tokens: tokens(input.tokens),
    costUsd: nonNegative(input.costUsd) ?? null,
    ...(input.source !== undefined ? { source: input.source as TelemetryEvent["source"] } : {}),
  } as TelemetryEvent;
  const chain = input.kind === "jev_attempt" ? chainStep(input.chain) : undefined;
  if (chain) event.chain = chain;
  return event;
}

export function createTelemetryWriter(options: TelemetryWriterOptions): TelemetryWriter {
  const fs: TelemetryFs = options.fs ?? (nodeFs as unknown as TelemetryFs);
  const maxBytes = Math.max(RECORD_LIMIT_BYTES, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const path = join(options.dir, TELEMETRY_FILE);
  const stats: TelemetryDiagnostics = { written: 0, rejected: 0, writeFailures: 0 };
  // Serialize appends so size checks and rotation never race each other.
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
      const match = ROTATED_FILE_PATTERN.exec(name);
      if (match) seq = Math.max(seq, Number(match[1]));
    }
    await fs.rename(path, join(options.dir, `events.${seq + 1}.jsonl`));
  }

  async function write(line: string): Promise<boolean> {
    try {
      await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
      await rotateIfNeeded(Buffer.byteLength(line));
      await fs.appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      stats.written += 1;
      return true;
    } catch {
      // §9.3: telemetry failure must not change the task result; keep a diagnostic only.
      stats.writeFailures += 1;
      return false;
    }
  }

  return {
    record(event) {
      let line: string | undefined;
      try {
        const safe = sanitizeEvent(event, options.now());
        if (safe) {
          line = `${JSON.stringify(safe)}\n`;
          if (Buffer.byteLength(line) > RECORD_LIMIT_BYTES) line = undefined;
        }
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
    diagnostics: () => ({ ...stats }),
  };
}
