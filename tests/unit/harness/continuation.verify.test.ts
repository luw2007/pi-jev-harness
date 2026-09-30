// T030 verification: edge cases for src/harness/continuation.ts beyond the T021 builder tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTINUATION_STOP_REASONS,
  decideContinuation,
  type ContinuationInput,
} from "../../../src/harness/continuation.ts";

const SNAPSHOT = { sessionId: "s1", branchId: "b1", generation: 3, mode: "on" };
const ACTION = "Add the missing regression test for parseDuration('0s')";

function passing(overrides: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    assessment: { done: 0.2, autonomous: 0.9 },
    continuationsUsed: 0,
    budgetRemaining: 10,
    cancelled: false,
    pendingUserMessage: false,
    pendingApproval: false,
    externalBlockers: [],
    runningBackgroundTasks: 0,
    before: { ...SNAPSHOT },
    after: { ...SNAPSHOT },
    unfinishedActions: [ACTION],
    ...overrides,
  };
}

test("verify continuation: every stop reason at once is reported in full, in the documented order", () => {
  const everything = passing({
    assessment: { done: 0.95, autonomous: 0.1 },
    continuationsUsed: 2,
    budgetRemaining: 0,
    cancelled: true,
    pendingUserMessage: true,
    pendingApproval: true,
    externalBlockers: ["missing GITHUB_TOKEN"],
    runningBackgroundTasks: 1,
    after: { sessionId: "s2", branchId: "b2", generation: 4, mode: "off" },
    unfinishedActions: [],
  });
  const d = decideContinuation(everything);
  assert.equal(d.decision, "stop");
  if (d.decision !== "stop") return;
  const expected = CONTINUATION_STOP_REASONS.filter((r) => r !== "jev_unavailable" && r !== "invalid_input");
  assert.deepEqual(d.reasons, expected);
  assert.deepEqual(d.blockers, ["pending approval", "missing GITHUB_TOKEN"]);
});

test("verify continuation: with Jev unavailable every host reason is still reported alongside jev_unavailable", () => {
  const d = decideContinuation(
    passing({
      assessment: undefined,
      continuationsUsed: 2,
      budgetRemaining: 0,
      cancelled: true,
      pendingUserMessage: true,
      pendingApproval: true,
      runningBackgroundTasks: 3,
      after: { sessionId: "s2", branchId: "b2", generation: 4, mode: "off" },
      unfinishedActions: ["  "],
    }),
  );
  assert.equal(d.decision, "stop");
  if (d.decision !== "stop") return;
  assert.deepEqual(d.reasons, CONTINUATION_STOP_REASONS.filter((r) => r !== "invalid_input" && r !== "already_done" && r !== "not_autonomous"));
});

test("verify continuation: done exactly 0.8 stops as already_done; 0.8 minus epsilon continues", () => {
  const at = decideContinuation(passing({ assessment: { done: 0.8, autonomous: 0.9 } }));
  assert.deepEqual(at.decision === "stop" ? at.reasons : at, ["already_done"]);
  const below = decideContinuation(passing({ assessment: { done: 0.8 - Number.EPSILON, autonomous: 0.9 } }));
  assert.equal(below.decision, "continue");
});

test("verify continuation: autonomous exactly 0.8 continues; just below stops as not_autonomous", () => {
  assert.equal(decideContinuation(passing({ assessment: { done: 0, autonomous: 0.8 } })).decision, "continue");
  const d = decideContinuation(passing({ assessment: { done: 0, autonomous: 0.8 - Number.EPSILON } }));
  assert.deepEqual(d.decision === "stop" ? d.reasons : d, ["not_autonomous"]);
});

test("verify continuation: budget exactly 0 (and -0) stops as over_budget only", () => {
  for (const budget of [0, -0]) {
    const d = decideContinuation(passing({ budgetRemaining: budget }));
    assert.deepEqual(d.decision === "stop" ? d.reasons : d, ["over_budget"]);
  }
});

test("verify continuation: smallest positive budget continues; NaN budget stops as invalid_input", () => {
  assert.equal(decideContinuation(passing({ budgetRemaining: Number.MIN_VALUE })).decision, "continue");
  const d = decideContinuation(passing({ budgetRemaining: Number.NaN }));
  assert.deepEqual(d.decision === "stop" ? d.reasons : d, ["invalid_input"]);
});

test("verify continuation: NaN counters and generations fail closed", () => {
  const used = decideContinuation(passing({ continuationsUsed: Number.NaN }));
  assert.deepEqual(used.decision === "stop" ? used.reasons : used, ["invalid_input"]);
  const bg = decideContinuation(passing({ runningBackgroundTasks: Number.NaN }));
  assert.deepEqual(bg.decision === "stop" ? bg.reasons : bg, ["background_tasks_running"]);
  const gen = decideContinuation(passing({ before: { ...SNAPSHOT, generation: Number.NaN }, after: { ...SNAPSHOT, generation: Number.NaN } }));
  assert.deepEqual(gen.decision === "stop" ? gen.reasons : gen, ["generation_changed"]);
});

test("verify continuation: maxContinuations 0 refuses the first continuation", () => {
  const d = decideContinuation(passing({ maxContinuations: 0 }));
  assert.deepEqual(d.decision === "stop" ? d.reasons : d, ["limit_reached"]);
});

test("verify continuation: NaN thresholds fail closed", () => {
  const d = decideContinuation(passing({ thresholds: { done: Number.NaN, autonomous: Number.NaN } }));
  assert.deepEqual(d.decision === "stop" ? d.reasons : d, ["already_done", "not_autonomous"]);
});

test("verify continuation: whitespace-only blockers are ignored, whitespace-only actions count as none", () => {
  assert.equal(decideContinuation(passing({ externalBlockers: ["", "   "] })).decision, "continue");
  const d = decideContinuation(passing({ unfinishedActions: ["", " \n "] }));
  assert.deepEqual(d.decision === "stop" ? d.reasons : d, ["no_unfinished_actions"]);
});

test("verify continuation: prompt carries every trimmed action, the attempt counter and no generic filler", () => {
  const d = decideContinuation(passing({ continuationsUsed: 1, unfinishedActions: ["  run pnpm test  ", "", "fix src/x.ts:12"] }));
  assert.equal(d.decision, "continue");
  if (d.decision !== "continue") return;
  assert.deepEqual(d.actions, ["run pnpm test", "fix src/x.ts:12"]);
  assert.match(d.prompt, /Automatic continuation 2 of 2/);
  assert.ok(d.prompt.includes("- run pnpm test\n- fix src/x.ts:12"));
  assert.doesNotMatch(d.prompt, /keep going|继续努力/i);
});

test("verify continuation: the input is not mutated", () => {
  const input = passing({ externalBlockers: [" x "], unfinishedActions: [" a "] });
  const copy = structuredClone(input);
  decideContinuation(input);
  assert.deepEqual(input, copy);
});
