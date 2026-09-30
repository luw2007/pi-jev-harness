/**
 * Verifier-added properties of the report math (T102). These pass on 07c6c0c and pin the
 * non-negotiables from the ticket: raw categories in the denominator, time-to-failure apart,
 * null usage propagation, per-task aggregation, fixed-seed bootstrap, A/A baseline, caveat.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeReport, renderReport, taskArmCell } from "./report-core.ts";
import { countModelAttempts } from "./runner.ts";
import { bootstrap, mean, quantile, rng } from "./stats.ts";
import type { BenchMeta, Outcome, ResultRecord } from "./types.ts";

const fig = (value: number | null) => ({ value, known: value === null ? 0 : 1, sources: 1 });

function rec(p: { task: string; arm: string; rep?: number; passed: boolean; ms: number; cost?: number | null; outcome?: Outcome; runStatus?: string | null; invalid?: number | null; category?: string; usage?: null }): ResultRecord {
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
    usage: p.usage === null ? null : { costUsd: fig(p.cost === undefined ? 0.01 : p.cost), input: fig(1), output: fig(1) },
    invalidToolCalls: p.invalid === undefined ? 0 : p.invalid,
    jevRequests: null,
    runDir: "/x",
  };
}

const meta = (arms: BenchMeta["arms"], seed = 1): BenchMeta => ({ startedAt: "t", seed, repeat: 1, concurrency: 1, model: "m", jev: "fake", arms, tasks: [] });
const AB = meta([
  { id: "A", label: "A", baseline: true, config: {} },
  { id: "B", label: "B", config: {} },
]);

test("every failure kind stays in the denominator with its raw category", () => {
  const kinds: Outcome[] = ["timeout", "session_error", "spawn_error", "artifacts_missing", "blocked", "cancelled", "failed", "verification_unavailable", "incomplete"];
  const records = [rec({ task: "ok", arm: "B", passed: true, ms: 5 }), ...kinds.map((k, i) => rec({ task: `t${i}`, arm: "B", passed: false, ms: 100 + i, outcome: k, runStatus: null }))];
  const b = computeReport(records, AB).arms.find((a) => a.arm === "B")!;
  assert.equal(b.runs, kinds.length + 1);
  assert.equal(b.completed, 1);
  assert.equal(b.completionRate, 1 / (kinds.length + 1));
  for (const k of kinds) assert.equal(b.outcomes[k], 1, `outcome ${k} kept`);
  // durations of failed runs never enter the completed-duration percentiles
  assert.equal(b.durationP50, 5);
  assert.equal(b.durationP95, 5);
  assert.equal(b.timeToFailureP50, quantile(kinds.map((_, i) => 100 + i), 0.5));
});

test("a run that passed acceptance counts as completed even when run.json is missing (bench criterion)", () => {
  const r = computeReport([rec({ task: "t", arm: "A", passed: true, ms: 1, outcome: "artifacts_missing", runStatus: null, usage: null })], AB);
  assert.equal(r.arms[0]!.completed, 1);
  assert.equal(r.arms[0]!.outcomes.artifacts_missing, 1);
  assert.equal(r.arms[0]!.falseCompletions, 0);
});

test("repeats are not independent samples: one task with many repeats yields n=1 and no interval", () => {
  const records = Array.from({ length: 10 }, (_, i) => [
    rec({ task: "only", arm: "A", rep: i + 1, passed: i % 2 === 0, ms: 100 }),
    rec({ task: "only", arm: "B", rep: i + 1, passed: true, ms: 90 }),
  ]).flat();
  const r = computeReport(records, AB);
  assert.equal(r.tasks, 1);
  const completion = r.comparisons[0]!.metrics.find((m) => m.metric === "completionRate")!;
  assert.equal(completion.interval.n, 1);
  assert.equal(completion.interval.lo, null);
  assert.deepEqual(completion.diffs, [{ taskId: "only", diff: 0.5 }]);
  assert.ok(r.limitations.some((l) => l.includes("独立任务数 1")));
});

test("adding repeats of existing tasks does not change the number of paired units", () => {
  const base = ["t1", "t2", "t3"].flatMap((t) => [rec({ task: t, arm: "A", passed: true, ms: 10 }), rec({ task: t, arm: "B", passed: false, ms: 5 })]);
  const more = [...base, ...base.map((r) => ({ ...r, rep: 2 })), ...base.map((r) => ({ ...r, rep: 3 }))];
  const n1 = computeReport(base, AB).comparisons[0]!.metrics[0]!.interval.n;
  const n3 = computeReport(more, AB).comparisons[0]!.metrics[0]!.interval.n;
  assert.equal(n1, 3);
  assert.equal(n3, 3);
});

test("bootstrap uses a fixed seed: identical reports on repeated computation; seed is taken from meta", () => {
  const records = Array.from({ length: 12 }, (_, i) => [
    rec({ task: `t${i}`, arm: "A", passed: true, ms: 100 + i * 7 }),
    rec({ task: `t${i}`, arm: "B", passed: true, ms: 80 + ((i * 13) % 50) }),
  ]).flat();
  const a = JSON.stringify(computeReport(records, meta(AB.arms, 5)));
  const b = JSON.stringify(computeReport(records, meta(AB.arms, 5)));
  assert.equal(a, b);
  const values = Array.from({ length: 15 }, (_, i) => Math.sin(i + 1) * 100);
  const s5 = bootstrap(values, mean, 5);
  assert.deepEqual(s5, bootstrap(values, mean, 5));
  const s6 = bootstrap(values, mean, 6);
  assert.equal(s5.estimate, s6.estimate);
  assert.ok(s5.lo !== s6.lo || s5.hi !== s6.hi, "different seeds resample differently");
  // PRNG itself is deterministic and in [0,1)
  const g1 = rng(9);
  const g2 = rng(9);
  for (let i = 0; i < 100; i++) {
    const x = g1();
    assert.equal(x, g2());
    assert.ok(x >= 0 && x < 1);
  }
});

test("bootstrap of mean on a symmetric sample brackets the mean", () => {
  const iv = bootstrap([-2, -1, 0, 1, 2, -2, -1, 0, 1, 2], mean, 3);
  assert.equal(iv.estimate, 0);
  assert.ok(iv.lo! < 0 && iv.hi! > 0);
});

test("unknown usage never becomes zero at cell level; one unknown repeat nulls the task cost", () => {
  const cell = taskArmCell([rec({ task: "t", arm: "A", passed: true, ms: 1, cost: 0.5 }), rec({ task: "t", arm: "A", rep: 2, passed: true, ms: 1, cost: null })]);
  assert.equal(cell.costPerCompleted, null);
  const noRun = taskArmCell([rec({ task: "t", arm: "A", passed: true, ms: 1, usage: null })]);
  assert.equal(noRun.costPerCompleted, null);
  const r = computeReport([rec({ task: "t", arm: "A", passed: true, ms: 1, usage: null }), rec({ task: "t", arm: "B", passed: true, ms: 1, usage: null })], AB);
  const md = renderReport(r);
  assert.ok(!/\$0\.0000/.test(md), "unknown cost never rendered as $0");
  assert.match(md, /费用覆盖率 0\/2/);
});

test("failed runs' cost still counts toward cost per completed task", () => {
  const cell = taskArmCell([rec({ task: "t", arm: "A", passed: true, ms: 1, cost: 1 }), rec({ task: "t", arm: "A", rep: 2, passed: false, ms: 1, cost: 3 })]);
  assert.equal(cell.costPerCompleted, 4);
});

test("A/A arm is not given a non-inferiority verdict and caveat is present for every real arm", () => {
  const m = meta([
    { id: "A", label: "A", baseline: true, config: {} },
    { id: "AA", label: "AA", aaOf: "A", config: {} },
    { id: "B", label: "B", config: {} },
    { id: "C", label: "C", config: {} },
  ]);
  const records = ["t1", "t2"].flatMap((t) => ["A", "AA", "B", "C"].map((arm) => rec({ task: t, arm, passed: true, ms: 1 })));
  const r = computeReport(records, m);
  assert.ok(r.limitations.some((l) => l.startsWith("B 相对 A：样本不足以支持 2 个百分点非劣结论")));
  assert.ok(r.limitations.some((l) => l.startsWith("C 相对 A：样本不足以支持 2 个百分点非劣结论")));
  assert.ok(!r.limitations.some((l) => l.startsWith("AA 相对")));
});

test("per-category paired differences only use tasks of that category", () => {
  const records = [
    rec({ task: "r1", arm: "A", passed: true, ms: 1, category: "read_explain" }),
    rec({ task: "r1", arm: "B", passed: false, ms: 1, category: "read_explain" }),
    rec({ task: "f1", arm: "A", passed: false, ms: 1, category: "feature" }),
    rec({ task: "f1", arm: "B", passed: true, ms: 1, category: "feature" }),
  ];
  const c = computeReport(records, AB).comparisons[0]!;
  const read = c.byCategory.find((g) => g.category === "read_explain")!;
  const feat = c.byCategory.find((g) => g.category === "feature")!;
  assert.deepEqual(read.completion.diffs, [{ taskId: "r1", diff: -1 }]);
  assert.deepEqual(feat.completion.diffs, [{ taskId: "f1", diff: 1 }]);
});

test("countModelAttempts counts assistant attempts including errored ones; null when no session log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-verify-"));
  try {
    assert.equal(await countModelAttempts(dir), null);
    await mkdir(join(dir, "s"), { recursive: true });
    const lines = [
      { type: "session" },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", stopReason: "error" } },
      { type: "message", message: { role: "assistant", stopReason: "toolUse" } },
      { type: "message", message: { role: "toolResult", isError: true } },
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ];
    await writeFile(join(dir, "s", "a.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    assert.deepEqual(await countModelAttempts(dir), { attempts: 3, errors: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
