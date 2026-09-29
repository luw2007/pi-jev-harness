import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPLETION_POLICY_VERSION, type CompletionResult, type CompletionStatus } from "../../../src/harness/completion.ts";
import type { ContinuationDecision } from "../../../src/harness/continuation.ts";
import { createController, type AssessContext, type ControllerOptions, type DecideInput } from "../../../src/harness/controller.ts";

function completion(status: CompletionStatus, stopAllowed: boolean, gaps: string[] = []): CompletionResult {
  return {
    assessment: "acceptance",
    policyVersion: COMPLETION_POLICY_VERSION,
    validation: { ok: true, errors: [] },
    completionStatus: status,
    stopAllowed,
    gaps: gaps.map((message) => ({ code: "criterion_unmet", message })),
    evidenceRefs: [],
    reason: status,
    model: null,
  };
}

const passed = completion("passed", true);
const incomplete = completion("incomplete", false, ["tests"]);
const unavailable = completion("unavailable", true);
const stop: ContinuationDecision = { decision: "stop", reasons: ["already_done"], blockers: [] };
const cont: ContinuationDecision = { decision: "continue", prompt: "Run the tests for foo.", actions: ["tests missing"] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(over: Partial<ControllerOptions> & { completion?: CompletionResult; decision?: ContinuationDecision } = {}) {
  const assessCalls: AssessContext[] = [];
  const decideCalls: DecideInput[] = [];
  let clock = 1_000;
  const controller = createController({
    assess: (ctx) => {
      assessCalls.push(ctx);
      return over.completion ?? passed;
    },
    decide: (input) => {
      decideCalls.push(input);
      return over.decision ?? stop;
    },
    now: () => clock++,
    ...over,
  });
  return { controller, assessCalls, decideCalls };
}

const path = (c: { snapshot(): { transitions: { from: string; to: string }[] } }) => {
  const t = c.snapshot().transitions;
  return t.length === 0 ? [] : [t[0]!.from, ...t.map((x) => x.to)];
};

test("normal flow: running -> checking -> verifying -> completed", async () => {
  const { controller, assessCalls, decideCalls } = setup();
  await controller.handle({ type: "tool_result", evidence: { id: "e1" } });
  const result = await controller.handle({ type: "before_settle" });
  assert.deepEqual(result, { continue: false, phase: "completed", reason: "already_done" });
  assert.deepEqual(path(controller), ["running", "checking", "verifying", "completed"]);
  assert.equal(assessCalls.length, 1);
  assert.deepEqual(assessCalls[0]!.evidence, [{ id: "e1" }]);
  assert.equal(assessCalls[0]!.boundary, "before_settle");
  assert.equal(decideCalls.length, 1);
  assert.equal(decideCalls[0]!.completion.completionStatus, "passed");
});

test("before_settle continue returns to running; third continue is refused by the controller backstop", async () => {
  const { controller, assessCalls, decideCalls } = setup({ completion: incomplete, decision: cont });
  for (let i = 1; i <= 2; i++) {
    await controller.handle({ type: "tool_result", evidence: i });
    const result = await controller.handle({ type: "before_settle" });
    assert.deepEqual(result, { continue: true, prompt: "Run the tests for foo." });
    assert.equal(controller.snapshot().phase, "running");
    assert.equal(controller.snapshot().continuations, i);
  }
  await controller.handle({ type: "tool_result", evidence: 3 });
  const third = await controller.handle({ type: "before_settle" });
  assert.deepEqual(third, { continue: false, phase: "incomplete", reason: "guard:continuation_cap" });
  assert.equal(controller.snapshot().continuations, 2);
  assert.equal(assessCalls.length, 3);
  assert.equal(decideCalls.length, 3);
  assert.deepEqual(
    decideCalls.map((d) => d.continuations),
    [0, 1, 2],
  );
  const hops = controller.snapshot().transitions.filter((t) => t.to === "continuing");
  assert.equal(hops.length, 2);
});

test("settled never starts a continuation, in any phase", async () => {
  const { controller, assessCalls, decideCalls } = setup({ completion: incomplete, decision: cont });
  const fromRunning = await controller.handle({ type: "settled" });
  assert.equal(fromRunning.continue, false);

  await controller.handle({ type: "user_message" });
  await controller.handle({ type: "before_settle" }); // one legitimate continuation
  const afterContinue = await controller.handle({ type: "settled" });
  assert.equal(afterContinue.continue, false);
  assert.equal(controller.snapshot().settled, true);
  assert.equal(controller.snapshot().continuations, 1);
  // settled itself caused no assess/decide calls beyond the one before_settle.
  assert.equal(assessCalls.length, 1);
  assert.equal(decideCalls.length, 1);
  assert.equal(controller.snapshot().transitions.filter((t) => t.event === "settled" && t.to === "continuing").length, 0);
});

test("generation change while assess is in flight discards the decision", async () => {
  const gate = deferred<CompletionResult>();
  const { controller, decideCalls } = setup({ assess: () => gate.promise, decision: cont });
  const pending = controller.handle({ type: "before_settle" });
  await controller.handle({ type: "session_switch", sessionId: "s2" });
  gate.resolve(incomplete);
  const result = await pending;
  assert.equal(result.continue, false);
  assert.equal(decideCalls.length, 0);
  const snap = controller.snapshot();
  assert.equal(snap.continuations, 0);
  assert.equal(snap.discarded.length, 1);
  assert.equal(snap.discarded[0]!.reason, "stale:session_switch");
  assert.equal(snap.discarded[0]!.generation, 0);
  assert.equal(snap.sessionId, "s2");
  assert.equal(snap.phase, "running");
});

test("user message during assessment voids it", async () => {
  const gate = deferred<CompletionResult>();
  const { controller, decideCalls } = setup({ assess: () => gate.promise, decision: cont });
  const pending = controller.handle({ type: "before_settle" });
  assert.equal(controller.snapshot().phase, "checking");
  await controller.handle({ type: "user_message" });
  gate.resolve(incomplete);
  const result = await pending;
  assert.deepEqual(result, { continue: false, phase: "running", reason: "stale:user_message" });
  assert.equal(decideCalls.length, 0);
  assert.equal(controller.snapshot().lastCompletion, null);
});

test("cancel during decide voids the continuation", async () => {
  const gate = deferred<ContinuationDecision>();
  const { controller } = setup({ completion: incomplete, decide: () => gate.promise });
  const pending = controller.handle({ type: "before_settle" });
  await new Promise((r) => setImmediate(r));
  assert.equal(controller.snapshot().phase, "verifying");
  await controller.handle({ type: "cancel" });
  gate.resolve(cont);
  const result = await pending;
  assert.deepEqual(result, { continue: false, phase: "cancelled", reason: "stale:cancel" });
  assert.equal(controller.snapshot().continuations, 0);
});

test("after switching to off, an old decision is not applied and no new one is made", async () => {
  const gate = deferred<ContinuationDecision>();
  const { controller, assessCalls } = setup({ completion: incomplete, decide: () => gate.promise });
  const pending = controller.handle({ type: "before_settle" });
  await new Promise((r) => setImmediate(r));
  await controller.handle({ type: "mode_change", mode: "off" });
  gate.resolve(cont);
  const result = await pending;
  assert.equal(result.continue, false);
  assert.equal(controller.snapshot().continuations, 0);
  assert.equal(controller.snapshot().discarded[0]!.reason, "stale:mode_change:off");

  const assessedBefore = assessCalls.length;
  await controller.handle({ type: "tool_result", evidence: 1 });
  const later = await controller.handle({ type: "before_settle" });
  assert.deepEqual(later, { continue: false, phase: "running", reason: "mode_off" });
  assert.equal(assessCalls.length, assessedBefore);
});

test("shadow mode computes the decision but never continues", async () => {
  const { controller, decideCalls } = setup({ mode: "shadow", completion: incomplete, decision: cont });
  const result = await controller.handle({ type: "before_settle" });
  assert.deepEqual(result, { continue: false, phase: "incomplete", reason: "guard:shadow_mode" });
  assert.equal(decideCalls.length, 1);
});

test("one checkpoint is assessed once: milestone then before_settle, and concurrent before_settle", async () => {
  const { controller, assessCalls, decideCalls } = setup();
  await controller.handle({ type: "tool_result", evidence: 1 });
  await controller.handle({ type: "milestone", label: "impl done" });
  assert.equal(assessCalls.length, 1);
  assert.equal(assessCalls[0]!.milestone, "impl done");
  assert.equal(controller.snapshot().phase, "running");
  const [a, b] = await Promise.all([
    controller.handle({ type: "before_settle" }),
    controller.handle({ type: "before_settle" }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(assessCalls.length, 1);
  assert.equal(decideCalls.length, 1);
  assert.equal(controller.snapshot().assessments, 1);
});

test("new progress opens a new checkpoint and is assessed again", async () => {
  const { controller, assessCalls } = setup();
  await controller.handle({ type: "milestone", label: "a" });
  await controller.handle({ type: "tool_result", evidence: 2 });
  await controller.handle({ type: "before_settle" });
  assert.equal(assessCalls.length, 2);
});

test("unavailable assessment stops as verification_unavailable, never completed", async () => {
  const { controller, decideCalls } = setup({ completion: unavailable, decision: cont });
  const result = await controller.handle({ type: "before_settle" });
  assert.deepEqual(result, { continue: false, phase: "verification_unavailable", reason: "completion_unavailable" });
  assert.equal(decideCalls.length, 0);
  assert.notEqual(controller.snapshot().phase, "completed");
});

test("a throwing assess is treated as unavailable", async () => {
  const { controller } = setup({
    assess: () => {
      throw new Error("jev down");
    },
    decision: cont,
  });
  const result = await controller.handle({ type: "before_settle" });
  assert.equal(result.continue, false);
  const snap = controller.snapshot();
  assert.equal(snap.phase, "verification_unavailable");
  assert.equal(snap.lastCompletion?.completionStatus, "unavailable");
  assert.equal(snap.lastCompletion?.reason, "assess_error: jev down");
  assert.equal(snap.lastCompletion?.stopAllowed, true);
  assert.equal(snap.lastStopReason, "completion_unavailable");
});

test("a throwing decide adds no continuation", async () => {
  const { controller } = setup({
    completion: incomplete,
    decide: () => {
      throw new Error("expired");
    },
  });
  const result = await controller.handle({ type: "before_settle" });
  assert.deepEqual(result, { continue: false, phase: "incomplete", reason: "decide_error: expired" });
  assert.equal(controller.snapshot().lastDecision, null);
  assert.equal(controller.snapshot().lastStopReason, "decide_error: expired");
});

test("continue is refused for blocked or passed completion", async () => {
  const blocked = completion("blocked", true, ["needs a credential"]);
  for (const [result0, phase] of [
    [blocked, "blocked"],
    [passed, "completed"],
  ] as const) {
    const { controller } = setup({ completion: result0, decision: cont });
    const result = await controller.handle({ type: "before_settle" });
    assert.deepEqual(result, { continue: false, phase, reason: `guard:completion_${result0.completionStatus}` });
  }
});

test("snapshot exports state and history as a detached copy with injected timestamps", async () => {
  const { controller } = setup({ completion: incomplete, decision: cont, sessionId: "s1" });
  await controller.handle({ type: "before_settle" });
  const snap = controller.snapshot();
  assert.equal(snap.sessionId, "s1");
  assert.deepEqual(
    snap.transitions.map((t) => [t.from, t.to, t.event]),
    [
      ["running", "checking", "before_settle"],
      ["checking", "verifying", "before_settle"],
      ["verifying", "continuing", "before_settle"],
      ["continuing", "running", "before_settle"],
    ],
  );
  assert.deepEqual(
    snap.transitions.map((t) => t.at),
    [1_000, 1_001, 1_002, 1_003],
  );
  assert.equal(snap.lastDecision?.decision, "continue");
  snap.transitions.length = 0;
  assert.equal(controller.snapshot().transitions.length, 4);
  assert.doesNotThrow(() => JSON.stringify(controller.snapshot()));
});

test("a milestone does not open a new checkpoint: a second milestone and before_settle reuse its assessment", async () => {
  const { controller, assessCalls } = setup({ completion: incomplete, decision: stop });
  await controller.handle({ type: "tool_result", evidence: 1 });
  await controller.handle({ type: "milestone", label: "jev_acceptance_gate" });
  await controller.handle({ type: "milestone", label: "foreman_assess" });
  await controller.handle({ type: "before_settle" });
  assert.equal(assessCalls.length, 1);
  assert.equal(assessCalls[0]!.boundary, "milestone");
});

test("a user message mid-task voids in-flight work but keeps the per-task continuation count", async () => {
  const { controller } = setup({ completion: incomplete, decision: cont });
  assert.equal((await controller.handle({ type: "before_settle" })).continue, true);
  await controller.handle({ type: "user_message" });
  assert.equal(controller.snapshot().continuations, 1);
  assert.equal((await controller.handle({ type: "before_settle" })).continue, true);
  const third = await controller.handle({ type: "before_settle" });
  assert.deepEqual(third, { continue: false, phase: "incomplete", reason: "guard:continuation_cap" });
});

test("progress after a stop reopens the task; cancel and settled stay final", async () => {
  const { controller, assessCalls } = setup({ completion: incomplete, decision: stop });
  await controller.handle({ type: "before_settle" });
  assert.equal(controller.snapshot().phase, "incomplete");
  await controller.handle({ type: "tool_result", evidence: "queued message work" });
  assert.equal(controller.snapshot().phase, "running");
  await controller.handle({ type: "before_settle" });
  assert.equal(assessCalls.length, 2);

  await controller.handle({ type: "cancel" });
  await controller.handle({ type: "tool_result", evidence: "late" });
  assert.equal(controller.snapshot().phase, "cancelled");
});

test("M1: a foreman milestone result never satisfies before_settle; settle assesses once more at its own boundary", async () => {
  const foreman = (ctx: AssessContext): CompletionResult => ({
    ...(ctx.boundary === "milestone" ? incomplete : passed),
    assessment: "foreman",
  });
  const { controller, assessCalls } = setup({ assess: (ctx) => { assessCalls.push(ctx); return foreman(ctx); } });
  await controller.handle({ type: "tool_result", evidence: { id: "e1" } });
  await controller.handle({ type: "milestone", label: "foreman_assess" });
  const [first, second] = await Promise.all([controller.handle({ type: "before_settle" }), controller.handle({ type: "before_settle" })]);
  assert.deepEqual(assessCalls.map((c) => c.boundary), ["milestone", "before_settle"], "one extra assess, shared by concurrent settles");
  assert.equal(first.continue, false);
  assert.equal(second, first);
  assert.equal(controller.snapshot().phase, "completed");
  assert.equal(controller.snapshot().lastCompletion?.completionStatus, "passed");
});

test("M1: an acceptance milestone result is still shared with before_settle (no extra assess)", async () => {
  const { controller, assessCalls } = setup();
  await controller.handle({ type: "tool_result", evidence: { id: "e1" } });
  await controller.handle({ type: "milestone", label: "jev_acceptance_gate" });
  await controller.handle({ type: "before_settle" });
  assert.equal(assessCalls.length, 1);
  assert.equal(controller.snapshot().phase, "completed");
});
