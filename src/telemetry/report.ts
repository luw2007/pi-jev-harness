// Adapted from omp-jev-extensions@0f93c809c2088c61fab4e613807e515ff9e65b1a:extensions/telemetry/report.js (MIT)
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TELEMETRY_SCHEMA_VERSION,
  type DurationStats,
  type FileReport,
  type KnownSum,
  type TelemetryEvent,
  type TelemetryGroup,
  type TelemetryReport,
  type TelemetryTokens,
} from "./types.ts";
import { ROTATED_FILE_PATTERN, TELEMETRY_FILE, sanitizeEvent } from "./writer.ts";

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const satisfies readonly (keyof TelemetryTokens)[];

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function durationStats(values: number[]): DurationStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
  };
}

function knownSum(values: (number | null)[]): KnownSum {
  const known = values.filter((v): v is number => v !== null);
  return {
    sum: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
    known: known.length,
    total: values.length,
    coverage: values.length === 0 ? null : known.length / values.length,
  };
}

/**
 * Aggregate sanitized events. Events sharing runId/decisionId/attemptId/kind are one physical
 * attempt; later duplicates are dropped. Unknown usage stays `null`, never 0.
 */
export function aggregate(events: readonly TelemetryEvent[]): TelemetryReport {
  const seen = new Set<string>();
  const unique: TelemetryEvent[] = [];
  for (const event of events) {
    if (event.attemptId !== undefined) {
      const key = JSON.stringify([event.runId, event.decisionId, event.attemptId, event.kind]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    unique.push(event);
  }

  const byKind: TelemetryReport["byKind"] = {};
  const byOutcome: TelemetryReport["byOutcome"] = {};
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of unique) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    byOutcome[event.outcome] = (byOutcome[event.outcome] ?? 0) + 1;
    const key = `${event.kind}\u0000${event.outcome}\u0000${event.chain ? "chain" : ""}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  // Chain-step events restate a physical attempt's outcome and never carry usage; they would dilute coverage.
  const physical = unique.filter((e) => !e.chain);
  const tokenKnown = physical.filter((e) => e.tokens !== null).length;
  const finished: TelemetryGroup[] = [...groups.values()].map((items) => ({
    kind: items[0]!.kind,
    outcome: items[0]!.outcome,
    events: items.length,
    ...(items[0]!.chain ? { chainStep: true as const } : {}),
    durationMs: durationStats(items.map((e) => e.durationMs)),
    tokens: Object.fromEntries(
      TOKEN_KEYS.map((key) => [key, knownSum(items.map((e) => e.tokens?.[key] ?? null))]),
    ) as TelemetryGroup["tokens"],
    costUsd: knownSum(items.map((e) => e.costUsd)),
  }));
  finished.sort((a, b) => a.kind.localeCompare(b.kind) || a.outcome.localeCompare(b.outcome) || Number(a.chainStep === true) - Number(b.chainStep === true));

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    events: unique.length,
    duplicatesDropped: events.length - unique.length,
    byKind,
    byOutcome,
    durationMs: durationStats(unique.map((e) => e.durationMs)),
    tokenCoverage: {
      known: tokenKnown,
      total: physical.length,
      ratio: physical.length === 0 ? null : tokenKnown / physical.length,
    },
    groups: finished,
  };
}

/** Read the live file plus every rotated file in `dir`, re-validating each line against the whitelist. */
export async function runReport(dir: string): Promise<FileReport> {
  const names = (await readdir(dir))
    .filter((name) => name === TELEMETRY_FILE || ROTATED_FILE_PATTERN.test(name))
    .sort((a, b) => {
      const seq = (name: string) => (name === TELEMETRY_FILE ? Infinity : Number(ROTATED_FILE_PATTERN.exec(name)![1]));
      return seq(a) - seq(b);
    });
  const events: TelemetryEvent[] = [];
  let lines = 0;
  let skipped = 0;
  for (const name of names) {
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      lines += 1;
      let event: TelemetryEvent | undefined;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        event = parsed?.schemaVersion === TELEMETRY_SCHEMA_VERSION ? sanitizeEvent(parsed, parsed.ts) : undefined;
      } catch {
        event = undefined;
      }
      if (event) events.push(event);
      else skipped += 1;
    }
  }
  return { ...aggregate(events), files: names.length, lines, skipped };
}
