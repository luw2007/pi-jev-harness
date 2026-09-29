import assert from "node:assert/strict";
import { test } from "node:test";
import { computeReport, renderReport } from "./report-core.ts";
import { bootstrap, median, quantile, shuffle } from "./stats.ts";
import type { BenchMeta, Outcome, ResultRecord } from "./types.ts";

const fig = (value: number | null) => ({ value, known: value === null ? 0 : 1, sources: 1 });

function rec(p: { task: string; arm: string; rep?: number; passed: boolean; ms: number; cost?: number | null; outcome?: Outcome; runStatus?: string | null; invalid?: number | null; category?: string }): ResultRecord {
  const outcome = p.outcome ?? (p.passed ? "completed" : "incomplete");
  return {
    taskId: p.task,
    category: p.category ?? "small_fix",
    arm: p.arm,
    rep: p.rep ?? 1,
    order: 0,
    startedAt: "2026-01-01T00:00:00Z",
    runStatus: p.runStatus === undefined ? outcome : p.runStatus,
    outcome,
    cliExit: 0,
    timedOut: outcome === "timeout",
    sessionError: null,
    acceptance: { exit: p.passed ? 0 : 1, timedOut: false, durationMs: 10 },
    passed: p.passed,
    durationMs: p.ms,
    usage: p.cost === undefined ? { costUsd: fig(0.01), input: fig(1), output: fig(1) } : { costUsd: fig(p.cost), input: fig(1), output: fig(1) },
    invalidToolCalls: p.invalid === undefined ? 0 : p.invalid,
    jevRequests: null,
    runDir: "/x",
  };
}

const meta = (arms: BenchMeta["arms"]): BenchMeta => ({ startedAt: "t", seed: 1, repeat: 1, concurrency: 1, model: "m", jev: "fake", arms, tasks: [] });
const AB = meta([
  { id: "A", label: "A", baseline: true, config: {} },
  { id: "B", label: "B", config: {} },
]);

test("quantile, median and seeded shuffle are deterministic", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([0, 10], 0.95), 9.5);
  assert.equal(median([]), null);
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], 42), shuffle([1, 2, 3, 4, 5], 42));
  assert.deepEqual([...shuffle([1, 2, 3, 4, 5], 42)].sort(), [1, 2, 3, 4, 5]);
});

test("bootstrap: fixed seed reproduces; interval brackets the estimate; n<2 has no interval", () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const a = bootstrap(v, median, 7);
  assert.deepEqual(a, bootstrap(v, median, 7));
  assert.ok(a.lo! <= a.estimate! && a.estimate! <= a.hi!);
  assert.ok(a.lo! >= 1 && a.hi! <= 10);
  assert.deepEqual(bootstrap([5]), { estimate: 5, lo: null, hi: null, n: 1 });
  const constant = bootstrap([2, 2, 2]);
  assert.equal(constant.lo, 2);
  assert.equal(constant.hi, 2);
});

test("paired differences are per task (repeats averaged first), arm minus baseline", () => {
  const records = [
    rec({ task: "t1", arm: "A", rep: 1, passed: true, ms: 100 }),
    rec({ task: "t1", arm: "A", rep: 2, passed: true, ms: 300 }),
    rec({ task: "t1", arm: "B", rep: 1, passed: true, ms: 50 }),
    rec({ task: "t1", arm: "B", rep: 2, passed: true, ms: 150 }),
    rec({ task: "t2", arm: "A", passed: true, ms: 1000 }),
    rec({ task: "t2", arm: "B", passed: false, ms: 10 }),
  ];
  const r = computeReport(records, AB);
  assert.equal(r.tasks, 2);
  const c = r.comparisons[0]!;
  const completion = c.metrics.find((m) => m.metric === "completionRate")!;
  assert.deepEqual(completion.diffs, [
    { taskId: "t1", diff: 0 },
    { taskId: "t2", diff: -1 },
  ]);
  const duration = c.metrics.find((m) => m.metric === "durationCompletedMs")!;
  // t1: median(50,150) - median(100,300) = 100 - 200; t2 excluded because B never completed.
  assert.deepEqual(duration.diffs, [{ taskId: "t1", diff: -100 }]);
  assert.equal(duration.excluded, 1);
});

test("failures stay in the denominator with their raw category; time-to-failure reported separately", () => {
  const records = [
    rec({ task: "t1", arm: "A", passed: true, ms: 100 }),
    rec({ task: "t2", arm: "A", passed: false, ms: 20, outcome: "timeout", runStatus: null }),
    rec({ task: "t3", arm: "A", passed: false, ms: 40, outcome: "blocked" }),
    rec({ task: "t4", arm: "A", passed: false, ms: 60, outcome: "artifacts_missing", runStatus: null }),
    rec({ task: "t5", arm: "A", passed: false, ms: 80, outcome: "completed", runStatus: "completed" }),
  ];
  const a = computeReport(records, AB).arms.find((x) => x.arm === "A")!;
  assert.equal(a.runs, 5);
  assert.equal(a.completed, 1);
  assert.equal(a.completionRate, 0.2);
  assert.deepEqual(a.outcomes, { completed: 2, timeout: 1, blocked: 1, artifacts_missing: 1 });
  assert.equal(a.falseCompletions, 1);
  assert.equal(a.passedNotCompleted, 0);
  const b = computeReport([rec({ task: "t1", arm: "A", passed: true, ms: 1, outcome: "incomplete", runStatus: "incomplete" })], AB).arms[0]!;
  assert.equal(b.passedNotCompleted, 1);
  // p50 only over passing runs; failures do not shorten it.
  assert.equal(a.durationP50, 100);
  assert.equal(a.timeToFailureP50, 50);
});

test("unknown usage propagates as null with coverage, never as zero", () => {
  const records = [
    rec({ task: "t1", arm: "A", passed: true, ms: 1, cost: 0.02 }),
    rec({ task: "t1", arm: "B", passed: true, ms: 1, cost: null }),
    rec({ task: "t2", arm: "A", passed: true, ms: 1, cost: 0.04 }),
    rec({ task: "t2", arm: "B", passed: true, ms: 1, cost: 0.01 }),
  ];
  const r = computeReport(records, AB);
  const b = r.arms.find((x) => x.arm === "B")!;
  assert.equal(b.costPerCompleted, null);
  assert.deepEqual(b.costCoverage, { known: 1, runs: 2 });
  assert.equal(r.arms.find((x) => x.arm === "A")!.costPerCompleted, 0.03);
  const cost = r.comparisons[0]!.metrics.find((m) => m.metric === "costPerCompletedUsd")!;
  assert.equal(cost.diffs.length, 1);
  assert.equal(cost.excluded, 1);
  assert.ok(Math.abs(cost.diffs[0]!.diff - -0.03) < 1e-12);
  assert.ok(r.limitations.some((l) => l.includes("费用覆盖率 3/4")));
  const noRunJson = { ...rec({ task: "t3", arm: "A", passed: true, ms: 1 }), usage: null };
  assert.equal(computeReport([noRunJson], AB).arms[0]!.costPerCompleted, null);
  assert.equal(computeReport([rec({ task: "t1", arm: "A", passed: true, ms: 1, invalid: null })], AB).arms[0]!.invalidToolCallsMean, null);
});

test("A/A arm is compared to the baseline and labelled as noise; small samples are flagged", () => {
  const m = meta([
    { id: "A", label: "A", baseline: true, config: {} },
    { id: "AA", label: "AA", aaOf: "A", config: {} },
    { id: "B", label: "B", config: {} },
  ]);
  const records = ["t1", "t2", "t3"].flatMap((t, i) => [
    rec({ task: t, arm: "A", passed: true, ms: 100 + i }),
    rec({ task: t, arm: "AA", passed: true, ms: 110 + i }),
    rec({ task: t, arm: "B", passed: true, ms: 50 }),
  ]);
  const r = computeReport(records, m);
  const aa = r.comparisons.find((c) => c.arm === "AA")!;
  assert.equal(aa.aa, true);
  assert.deepEqual(
    aa.metrics.find((x) => x.metric === "durationCompletedMs")!.diffs.map((d) => d.diff),
    [10, 10, 10],
  );
  assert.ok(r.limitations.some((l) => l.includes("B 相对 A：样本不足以支持 2 个百分点非劣结论")));
  assert.ok(!r.limitations.some((l) => l.includes("没有 A/A")));
  const md = renderReport(r);
  assert.match(md, /AA − A（A\/A 噪声基线）/);
  assert.ok(computeReport(records.filter((x) => x.arm !== "AA"), AB).limitations.some((l) => l.includes("没有 A/A")));
});
