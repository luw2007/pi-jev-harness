import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTINUATION_AUTONOMOUS_THRESHOLD,
  CONTINUATION_DONE_THRESHOLD,
  DEFAULT_MAX_CONTINUATIONS,
  decideContinuation,
  type ContinuationDecision,
  type ContinuationInput,
  type ContinuationStopReason,
} from "../../../src/harness/continuation.ts";

const SNAPSHOT = { sessionId: "s1", branchId: "b1", generation: 3, mode: "on" };
const ACTION = "Run pnpm test for tests/unit/harness/actions.test.ts and fix the failing freshness case";

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

function stopReasons(decision: ContinuationDecision): readonly ContinuationStopReason[] {
  assert.equal(decision.decision, "stop");
  return decision.decision === "stop" ? decision.reasons : [];
}

function assertOnlyStop(overrides: Partial<ContinuationInput>, reason: ContinuationStopReason): void {
  assert.deepEqual(stopReasons(decideContinuation(passing(overrides))), [reason]);
}

test("defaults keep O's uncalibrated starting point", () => {
  assert.equal(CONTINUATION_DONE_THRESHOLD, 0.8);
  assert.equal(CONTINUATION_AUTONOMOUS_THRESHOLD, 0.8);
  assert.equal(DEFAULT_MAX_CONTINUATIONS, 2);
});

test("all conditions met continues with a prompt naming the concrete action", () => {
  const decision = decideContinuation(passing());
  assert.equal(decision.decision, "continue");
  assert.ok(decision.decision === "continue");
  assert.ok(decision.prompt.includes(ACTION), decision.prompt);
  assert.match(decision.prompt, /continuation 1 of 2/);
  assert.doesNotMatch(decision.prompt, /keep going|继续努力|try harder/i);
  assert.deepEqual(decision.actions, [ACTION]);
});

test("prompt lists every unfinished action verbatim", () => {
  const actions = ["Add a test for the ENOTDIR branch in checkFreshness", "Update docs/pi-jev-harness-technical.md §7.3 table"];
  const decision = decideContinuation(passing({ unfinishedActions: actions, continuationsUsed: 1 }));
  assert.ok(decision.decision === "continue");
  for (const action of actions) assert.ok(decision.prompt.includes(`- ${action}`), decision.prompt);
  assert.match(decision.prompt, /continuation 2 of 2/);
});

test("boundary values: done just below and autonomous exactly at threshold continue", () => {
  assert.equal(decideContinuation(passing({ assessment: { done: 0.79, autonomous: 0.8 } })).decision, "continue");
});

test("done at threshold alone stops", () => {
  assertOnlyStop({ assessment: { done: 0.8, autonomous: 0.9 } }, "already_done");
});

test("autonomous below threshold alone stops", () => {
  assertOnlyStop({ assessment: { done: 0.2, autonomous: 0.79 } }, "not_autonomous");
});

test("third continuation is refused", () => {
  assert.equal(decideContinuation(passing({ continuationsUsed: 1 })).decision, "continue");
  assertOnlyStop({ continuationsUsed: 2 }, "limit_reached");
});

test("custom maximum is honoured", () => {
  assertOnlyStop({ continuationsUsed: 0, maxContinuations: 0 }, "limit_reached");
});

test("malformed counters or budget stop as invalid_input, never as under the limit", () => {
  for (const continuationsUsed of [-1, -5, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertOnlyStop({ continuationsUsed }, "invalid_input");
  }
  for (const maxContinuations of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertOnlyStop({ maxContinuations }, "invalid_input");
  }
  assertOnlyStop({ budgetRemaining: Number.NaN }, "invalid_input");
  assertOnlyStop({ budgetRemaining: "10" as unknown as number }, "invalid_input");
  assertOnlyStop({ continuationsUsed: -1, budgetRemaining: Number.NaN }, "invalid_input");
  assertOnlyStop({ budgetRemaining: -1 }, "over_budget");
});

test("exhausted budget alone stops", () => {
  assertOnlyStop({ budgetRemaining: 0 }, "over_budget");
});

test("cancellation alone stops", () => {
  assertOnlyStop({ cancelled: true }, "cancelled");
});

test("pending user message alone stops", () => {
  assertOnlyStop({ pendingUserMessage: true }, "pending_user_message");
});

test("pending approval is an external block, not a retry", () => {
  const decision = decideContinuation(passing({ pendingApproval: true }));
  assert.deepEqual(stopReasons(decision), ["blocked_external"]);
  assert.ok(decision.decision === "stop");
  assert.deepEqual(decision.blockers, ["pending approval"]);
});

test("missing credential is an external block and is reported verbatim", () => {
  const decision = decideContinuation(passing({ externalBlockers: ["missing TYPESAFE_API_KEY"] }));
  assert.deepEqual(stopReasons(decision), ["blocked_external"]);
  assert.ok(decision.decision === "stop");
  assert.deepEqual(decision.blockers, ["missing TYPESAFE_API_KEY"]);
});

test("running background task alone stops", () => {
  assertOnlyStop({ runningBackgroundTasks: 1 }, "background_tasks_running");
});

test("session change after the Jev await stops", () => {
  assertOnlyStop({ after: { ...SNAPSHOT, sessionId: "s2" } }, "session_changed");
});

test("branch change after the Jev await stops", () => {
  assertOnlyStop({ after: { ...SNAPSHOT, branchId: "b2" } }, "branch_changed");
});

test("generation change after the Jev await stops", () => {
  assertOnlyStop({ after: { ...SNAPSHOT, generation: 4 } }, "generation_changed");
});

test("mode change after the Jev await stops", () => {
  assertOnlyStop({ after: { ...SNAPSHOT, mode: "off" } }, "mode_changed");
});

test("empty unfinished action list alone stops", () => {
  assertOnlyStop({ unfinishedActions: [] }, "no_unfinished_actions");
  assertOnlyStop({ unfinishedActions: ["  ", ""] }, "no_unfinished_actions");
});

test("Jev unavailable stops without adding autonomous action", () => {
  assertOnlyStop({ assessment: undefined }, "jev_unavailable");
});

test("malformed Jev probabilities count as unavailable, not clamped", () => {
  assertOnlyStop({ assessment: { done: Number.NaN, autonomous: 0.9 } }, "jev_unavailable");
  assertOnlyStop({ assessment: { done: 0.2, autonomous: 1.5 } }, "jev_unavailable");
});

test("stop reports every unmet condition in a stable order", () => {
  const decision = decideContinuation(passing({
    assessment: { done: 0.95, autonomous: 0.1 },
    continuationsUsed: 2,
    cancelled: true,
    pendingUserMessage: true,
    externalBlockers: ["missing TYPESAFE_API_KEY"],
    after: { ...SNAPSHOT, generation: 9 },
    unfinishedActions: [],
  }));
  assert.deepEqual(stopReasons(decision), [
    "already_done",
    "not_autonomous",
    "limit_reached",
    "cancelled",
    "pending_user_message",
    "blocked_external",
    "generation_changed",
    "no_unfinished_actions",
  ]);
});
