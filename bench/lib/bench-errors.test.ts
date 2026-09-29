import assert from "node:assert/strict";
import { test } from "node:test";
import { computeReport, renderBenchErrors } from "./report-core.ts";
import type { BenchMeta, ResultRecord } from "./types.ts";

const fig = (value: number | null) => ({ value, known: 1, sources: 1 });
const rec = (task: string, arm: string, rep: number): ResultRecord => ({
  taskId: task,
  category: "small_fix",
  arm,
  rep,
  order: 0,
  startedAt: "t",
  runStatus: "completed",
  outcome: "completed",
  cliExit: 0,
  timedOut: false,
  sessionError: null,
  acceptance: { exit: 0, timedOut: false, durationMs: 1 },
  passed: true,
  durationMs: 10,
  usage: { costUsd: fig(0.01), input: fig(1), output: fig(1) },
  invalidToolCalls: 0,
  jevRequests: null,
  runDir: "/x",
});
const meta: BenchMeta = {
  startedAt: "t",
  seed: 1,
  repeat: 2,
  concurrency: 2,
  model: "m",
  jev: "fake",
  arms: [
    { id: "A", label: "A", baseline: true, config: {} },
    { id: "B", label: "B", config: {} },
  ],
  tasks: [
    { id: "t1", category: "small_fix" },
    { id: "t2", category: "small_fix" },
  ],
};

test("bench-internal failures are listed by task/arm, partial repeats warned, and kept out of metrics", () => {
  const records = [rec("t1", "A", 1), rec("t1", "A", 2), rec("t1", "B", 1), rec("t1", "B", 2), rec("t2", "A", 1), rec("t2", "A", 2), rec("t2", "B", 1)];
  const errors = ["t2 rep 2 arm B: EACCES scratch", "t2 rep 2 arm B: second failure", "worker crashed", ""];
  const md = renderBenchErrors(errors, records, meta).join("\n");
  assert.match(md, /## bench 内部失败/);
  assert.match(md, /### 任务 t2 \/ 臂 B\n\n- rep 2：EACCES scratch\n- rep 2：second failure/);
  assert.match(md, /### 其他\n\n- worker crashed/);
  assert.match(md, /任务 t2 \/ 臂 B：只记录了 1\/2 次重复/);
  assert.doesNotMatch(md, /任务 t1 \/ 臂/);
  const b = computeReport(records, meta).arms.find((a) => a.arm === "B")!;
  assert.equal(b.runs, 3, "failed runs have no outcome and are not counted");
  assert.deepEqual(renderBenchErrors([], [...records, rec("t2", "B", 2)], meta), []);
});
