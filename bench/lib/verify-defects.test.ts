/**
 * Verifier-added regression tests for defects found in T102 (07c6c0c). Each test states the
 * expected behavior and FAILS on 07c6c0c; the builder fixes production code until they pass.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeReport } from "./report-core.ts";
import { countModelAttempts } from "./runner.ts";
import type { BenchMeta, ResultRecord } from "./types.ts";

const fig = (value: number | null) => ({ value, known: value === null ? 0 : 1, sources: 1 });
const rec = (task: string, arm: string, passed: boolean): ResultRecord => ({
  taskId: task,
  category: "small_fix",
  arm,
  rep: 1,
  order: 0,
  startedAt: "2026-01-01T00:00:00Z",
  runStatus: passed ? "completed" : "incomplete",
  outcome: passed ? "completed" : "incomplete",
  cliExit: 0,
  timedOut: false,
  sessionError: null,
  acceptance: { exit: passed ? 0 : 1, timedOut: false, durationMs: 1 },
  passed,
  durationMs: 100,
  usage: { costUsd: fig(0.01), input: fig(1), output: fig(1) },
  invalidToolCalls: 0,
  jevRequests: null,
  runDir: "/x",
});
const AB: BenchMeta = {
  startedAt: "t",
  seed: 1,
  repeat: 1,
  concurrency: 1,
  model: "m",
  jev: "fake",
  arms: [
    { id: "A", label: "A", baseline: true, config: {} },
    { id: "B", label: "B", config: {} },
  ],
  tasks: [],
};

test("DEFECT: a 20-point completion regression must not be reported as 2-point non-inferior", () => {
  // 30 independent tasks; A completes all, B fails 6 of them (completion 100% -> 80%).
  const records = Array.from({ length: 30 }, (_, i) => [rec(`t${String(i).padStart(2, "0")}`, "A", true), rec(`t${String(i).padStart(2, "0")}`, "B", i >= 6)]).flat();
  const r = computeReport(records, AB);
  const b = r.arms.find((a) => a.arm === "B")!;
  assert.equal(b.completionRate, 0.8);
  const completion = r.comparisons[0]!.metrics.find((m) => m.metric === "completionRate")!;
  // The completion-rate difference is a difference in proportions: its point estimate must be -20pp.
  assert.ok(Math.abs(completion.interval.estimate! - -0.2) < 1e-9, `completion diff estimate ${completion.interval.estimate} should be -0.2`);
  const line = r.limitations.find((l) => l.startsWith("B 相对 A"))!;
  assert.match(line, /样本不足以支持 2 个百分点非劣结论|不支持/, `must not claim non-inferiority: ${line}`);
});

test("DEFECT: a truncated session-log line (SIGKILL mid-write) must not crash the whole bench", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-verify-"));
  try {
    await mkdir(join(dir, "s"), { recursive: true });
    await writeFile(join(dir, "s", "a.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } })}\n{"type":"message","message":{"role":"assis`);
    const got = await countModelAttempts(dir).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    assert.ok(got.ok, `countModelAttempts threw: ${got.ok ? "" : String(got.e)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
