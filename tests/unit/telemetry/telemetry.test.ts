import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  aggregate,
  createTelemetryWriter,
  percentile,
  runReport,
  sanitizeEvent,
  type TelemetryEvent,
  type TelemetryInput,
} from "../../../src/telemetry/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-telemetry-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function diskText(dir: string): Promise<string> {
  let text = "";
  for (const name of await readdir(dir)) text += await readFile(join(dir, name), "utf8");
  return text;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RUN = `run_${uuid(1)}`;
const DEC = `dec_${uuid(1)}`;
const att = (n: number) => `att_${uuid(n)}`;
const base = { runId: RUN, decisionId: DEC, kind: "jev_attempt", outcome: "ok", durationMs: 5 } as const;

function event(overrides: Partial<TelemetryEvent>): TelemetryEvent {
  return sanitizeEvent({ ...base, ...overrides }, 1)!;
}

test("diagnostic events require a known diagnostic source and stay out of route kinds", async () => {
  await withTempDir(async (dir) => {
    const writer = createTelemetryWriter({ dir, now: () => 1000 });
    const diagnostic = { runId: RUN, decisionId: `dec_${uuid(2)}`, kind: "diagnostic", outcome: "skipped", durationMs: 0 } as const;
    assert.equal(await writer.record({ ...diagnostic, source: "adapter:duplicate_load" }), true);
    assert.equal(await writer.record({ ...diagnostic, source: "adapter:no_profile" }), true);
    assert.equal(await writer.record({ ...diagnostic, source: "adapter:other" } as unknown as TelemetryInput), false);
    assert.equal(await writer.record(diagnostic as unknown as TelemetryInput), false);
    assert.deepEqual(writer.diagnostics(), { written: 2, rejected: 2, writeFailures: 0 });

    const report = await runReport(dir);
    assert.deepEqual(report.byKind, { diagnostic: 2 });
  });
});

test("writer drops prompt/args/error text and free-text strings from disk", async () => {
  await withTempDir(async (dir) => {
    const writer = createTelemetryWriter({ dir, now: () => 1000 });
    const leaky = {
      ...base,
      attemptId: att(1),
      source: "jev:ok",
      prompt: "SECRET_PROMPT body",
      args: { path: "SECRET_ARGS" },
      error: "SECRET_ERROR raw http 500",
      tokens: { input: 10, output: 2, secret: "SECRET_TOKEN_FIELD" },
    } as unknown as TelemetryInput;
    assert.equal(await writer.record(leaky), true);
    // A long string with spaces in an ID/enum slot rejects the whole event.
    const spaced = { ...base, runId: "run with spaces ".repeat(20) } as TelemetryInput;
    assert.equal(await writer.record(spaced), false);
    assert.equal(await writer.record({ ...base, source: "has space" } as unknown as TelemetryInput), false);
    assert.equal(await writer.record({ ...base, outcome: "not an enum" } as unknown as TelemetryInput), false);

    const text = await diskText(dir);
    for (const needle of ["SECRET", "prompt", "args", "error", "with spaces", "has space", "not an enum"]) {
      assert.equal(text.includes(needle), false, `disk contains ${needle}`);
    }
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), {
      schemaVersion: 1,
      ts: 1000,
      runId: RUN,
      decisionId: DEC,
      attemptId: att(1),
      kind: "jev_attempt",
      outcome: "ok",
      durationMs: 5,
      tokens: { input: 10, output: 2, cacheRead: null, cacheWrite: null },
      costUsd: null,
      source: "jev:ok",
    });
    assert.deepEqual(writer.diagnostics(), { written: 1, rejected: 3, writeFailures: 0 });
  });
});

test("a key-like string in runId, decisionId, attemptId or source never reaches disk", async () => {
  const KEY = "sk-test-SECRET-9f8e7d";
  await withTempDir(async (dir) => {
    const writer = createTelemetryWriter({ dir, now: () => 1000 });
    const valid = { ...base, attemptId: att(1), source: "jev:ok" } as const;
    for (const field of ["runId", "decisionId", "attemptId", "source"] as const) {
      assert.equal(await writer.record({ ...valid, [field]: KEY } as unknown as TelemetryInput), false, `${field} accepted a key`);
      // A correct prefix does not make free text a valid ID.
      const prefixed = { runId: `run_${KEY}`, decisionId: `dec_${KEY}`, attemptId: `att_${KEY}`, source: `jev:${KEY}` }[field];
      assert.equal(await writer.record({ ...valid, [field]: prefixed } as unknown as TelemetryInput), false, `${field} accepted a prefixed key`);
    }
    assert.equal(await writer.record(valid), true);
    const text = await diskText(dir);
    assert.equal(text.includes("SECRET"), false);
    assert.equal(text.trim().split("\n").length, 1);
    assert.deepEqual(writer.diagnostics(), { written: 1, rejected: 8, writeFailures: 0 });
  });
});

test("missing usage aggregates as unknown, not 0", () => {
  const report = aggregate([
    event({ attemptId: att(1), tokens: null, costUsd: null }),
    event({ attemptId: att(2), tokens: { input: 7, output: null, cacheRead: null, cacheWrite: null } }),
    event({ attemptId: att(3), kind: "route_tools", tokens: null }),
  ]);
  assert.deepEqual(report.tokenCoverage, { known: 1, total: 3, ratio: 1 / 3 });
  const jev = report.groups.find((g) => g.kind === "jev_attempt")!;
  assert.deepEqual(jev.tokens.input, { sum: 7, known: 1, total: 2, coverage: 0.5 });
  assert.deepEqual(jev.tokens.output, { sum: null, known: 0, total: 2, coverage: 0 });
  assert.deepEqual(jev.costUsd, { sum: null, known: 0, total: 2, coverage: 0 });
  const route = report.groups.find((g) => g.kind === "route_tools")!;
  assert.equal(route.tokens.input.sum, null);
  // Writer input without tokens/cost is persisted as null, not 0.
  assert.deepEqual(sanitizeEvent({ ...base, tokens: { input: Number.NaN } }, 1)!.tokens, null);
  assert.equal(sanitizeEvent({ ...base, costUsd: -1 }, 1)!.costUsd, null);
});

test("aggregate counts each attemptId once", () => {
  const report = aggregate([
    event({ attemptId: att(1), durationMs: 10 }),
    event({ attemptId: att(1), durationMs: 999 }),
    event({ attemptId: att(2), durationMs: 20 }),
    event({ attemptId: att(1), decisionId: `dec_${uuid(2)}`, durationMs: 30 }),
    event({ kind: "completion", durationMs: 1 }),
    event({ kind: "completion", durationMs: 1 }),
  ]);
  assert.equal(report.events, 5);
  assert.equal(report.duplicatesDropped, 1);
  assert.deepEqual(report.byKind, { jev_attempt: 3, completion: 2 });
  assert.deepEqual(report.byOutcome, { ok: 5 });
  assert.equal(report.groups.find((g) => g.kind === "jev_attempt")!.durationMs.p99, 30);
});

test("writer does not throw when the directory is unwritable and counts the failure", async () => {
  await withTempDir(async (dir) => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const writer = createTelemetryWriter({ dir: join(blocker, "telemetry"), now: () => 1 });
    assert.equal(await writer.record({ ...base }), false);
    assert.deepEqual(writer.diagnostics(), { written: 0, rejected: 0, writeFailures: 1 });

    const throwingClock = createTelemetryWriter({ dir, now: () => { throw new Error("clock"); } });
    assert.equal(await throwingClock.record({ ...base }), false);
  });
});

test("runReport reads every rotated file", async () => {
  await withTempDir(async (dir) => {
    const writer = createTelemetryWriter({ dir, now: () => 1, maxFileBytes: 4096 });
    const total = 60;
    for (let i = 0; i < total; i += 1) {
      assert.equal(await writer.record({ ...base, attemptId: att(i), durationMs: i }), true);
    }
    const files = await readdir(dir);
    assert.ok(files.length >= 3, `expected rotation, got ${files.join(",")}`);
    assert.ok(files.includes("events.jsonl") && files.includes("events.1.jsonl"));
    const report = await runReport(dir);
    assert.equal(report.files, files.length);
    assert.equal(report.events, total);
    assert.equal(report.skipped, 0);
    assert.deepEqual(writer.diagnostics(), { written: total, rejected: 0, writeFailures: 0 });
  });
});

test("runReport skips tampered lines", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "events.jsonl"),
      `${JSON.stringify({ ...base, schemaVersion: 1, ts: 1, prompt: "leak" })}\nnot json\n${JSON.stringify({ ...base, schemaVersion: 1, ts: 1, runId: "bad id" })}\n`,
    );
    const report = await runReport(dir);
    assert.equal(report.events, 1);
    assert.equal(report.skipped, 2);
  });
});

test("duration percentiles use nearest rank on known samples", () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1);
  const report = aggregate(samples.reverse().map((d, i) => event({ attemptId: att(i), durationMs: d })));
  assert.deepEqual(report.durationMs, { count: 100, p50: 50, p90: 90, p99: 99 });
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([4], 0.99), 4);
  assert.deepEqual(aggregate([
    event({ attemptId: att(101), durationMs: 30 }),
    event({ attemptId: att(102), durationMs: 10 }),
    event({ attemptId: att(103), durationMs: 20 }),
  ]).durationMs, { count: 3, p50: 20, p90: 30, p99: 30 });
});

test("tool-apply sources (mode on) are accepted on route_tools with existing outcomes", async () => {
  await withTempDir(async (dir) => {
    const writer = createTelemetryWriter({ dir, now: () => 1000 });
    const route = { runId: RUN, decisionId: DEC, kind: "route_tools", durationMs: 0 } as const;
    const pairs = [["ok", "tools:applied"], ["fallback", "tools:apply_mismatch"], ["fallback", "tools:native_kept"],
      ["skipped", "tools:external_change_kept"], ["ok", "tools:restored"]] as const;
    for (const [outcome, source] of pairs) assert.equal(await writer.record({ ...route, outcome, source }), true, source);
    assert.equal(await writer.record({ ...route, outcome: "ok", source: "tools:apply_other" } as unknown as TelemetryInput), false);
    assert.deepEqual(writer.diagnostics(), { written: 5, rejected: 1, writeFailures: 0 });
  });
});

test("T051: route_model and model:* sources are rejected by the writer and skipped when read back", async () => {
  await withTempDir(async (dir) => {
    const writer = createTelemetryWriter({ dir, now: () => 1000 });
    assert.equal(await writer.record({ runId: RUN, decisionId: DEC, kind: "route_model", outcome: "ok", durationMs: 0, source: "model:jev" } as unknown as TelemetryInput), false);
    for (const source of ["model:pin", "model:no_allowlist", "model:window_uncertified"])
      assert.equal(await writer.record({ runId: RUN, decisionId: DEC, kind: "route_tools", outcome: "withheld", durationMs: 0, source } as unknown as TelemetryInput), false, source);
    assert.equal(await writer.record({ runId: RUN, decisionId: DEC, kind: "diagnostic", outcome: "skipped", durationMs: 0, source: "adapter:model_candidates_truncated" } as unknown as TelemetryInput), false);
    assert.equal(await writer.record({ runId: RUN, decisionId: DEC, kind: "route_tools", outcome: "ok", durationMs: 0, source: "tools:selected" }), true, "tool routing stays");
    assert.deepEqual(writer.diagnostics(), { written: 1, rejected: 5, writeFailures: 0 });
    assert.equal(sanitizeEvent({ runId: RUN, decisionId: DEC, kind: "route_model", outcome: "ok", durationMs: 0, schemaVersion: 1, ts: 1 }, 1), undefined);
  });
});
