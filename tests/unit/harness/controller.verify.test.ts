// verification: edge cases for src/harness/controller.ts beyond the builder tests.
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

test("verify controller: double before_settle after a stop without settled reuses the result, assess and decide once", async () => {
  const { controller, assessCalls, decideCalls } = setup();
  const first = await controller.handle({ type: "before_settle" });
  const second = await controller.handle({ type: "before_settle" });
  assert.deepEqual(first, { continue: false, phase: "completed", reason: "already_done" });
  assert.deepEqual(second, first);
  assert.equal(assessCalls.length, 1);
  assert.equal(decideCalls.length, 1);
  assert.equal(controller.snapshot().assessments, 1);
});

test("verify controller: double before_settle after a continue is a new checkpoint and the cap still holds", async () => {
  const { controller, assessCalls } = setup({ completion: incomplete, decision: cont });
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await controller.handle({ type: "before_settle" }));
  assert.deepEqual(results.map((r) => r.continue), [true, true, false, false]);
  assert.equal(controller.snapshot().continuations, 2);
  // The capped stop is cached for its checkpoint; the 4th call does not reassess.
  assert.equal(assessCalls.length, 3);
  assert.equal(controller.snapshot().phase, "incomplete");
});

test("verify controller: cancel while assess is in flight discards it, never calls decide, ends cancelled", async () => {
  const gate = deferred<CompletionResult>();
  const { controller, decideCalls } = setup({ assess: () => gate.promise, decision: cont });
  const pending = controller.handle({ type: "before_settle" });
  await controller.handle({ type: "cancel" });
  gate.resolve(incomplete);
  const r = await pending;
  assert.equal(r.continue, false);
  assert.equal(decideCalls.length, 0);
  const snap = controller.snapshot();
  assert.equal(snap.phase, "cancelled");
  assert.equal(snap.continuations, 0);
  assert.equal(snap.discarded.length, 1);
  assert.equal(snap.discarded[0]!.reason, "stale:cancel");
  assert.equal(snap.lastCompletion, null);
});

test("verify controller: before_settle after cancel does not assess or continue", async () => {
  const { controller, assessCalls } = setup({ completion: incomplete, decision: cont });
  await controller.handle({ type: "cancel" });
  const r = await controller.handle({ type: "before_settle" });
  assert.deepEqual(r, { continue: false, phase: "cancelled", reason: "phase:cancelled" });
  assert.equal(assessCalls.length, 0);
});

test("verify controller: mode_change to shadow while decide is in flight discards the continue and records why", async () => {
  const gate = deferred<ContinuationDecision>();
  const { controller } = setup({ completion: incomplete, decide: () => gate.promise });
  const pending = controller.handle({ type: "before_settle" });
  await Promise.resolve();
  await Promise.resolve();
  await controller.handle({ type: "mode_change", mode: "shadow" });
  gate.resolve(cont);
  const r = await pending;
  assert.equal(r.continue, false);
  const snap = controller.snapshot();
  assert.equal(snap.mode, "shadow");
  assert.equal(snap.phase, "running");
  assert.equal(snap.continuations, 0);
  assert.equal(snap.discarded.at(-1)!.reason, "stale:mode_change:shadow");
  // Next checkpoint in shadow still assesses but never continues.
  const next = await controller.handle({ type: "before_settle" });
  assert.equal(next.continue, false);
  assert.equal((next as { reason?: string }).reason, "guard:shadow_mode");
});

test("verify controller: mode_change to shadow while assess is in flight discards before decide", async () => {
  const gate = deferred<CompletionResult>();
  const { controller, decideCalls } = setup({ assess: () => gate.promise, decision: cont });
  const pending = controller.handle({ type: "before_settle" });
  await controller.handle({ type: "mode_change", mode: "shadow" });
  gate.resolve(incomplete);
  const r = await pending;
  assert.equal(r.continue, false);
  assert.equal(decideCalls.length, 0);
});

test("verify controller: settled while before_settle is in flight discards it and never continues", async () => {
  const gate = deferred<ContinuationDecision>();
  const { controller } = setup({ completion: incomplete, decide: () => gate.promise });
  const pending = controller.handle({ type: "before_settle" });
  await Promise.resolve();
  await Promise.resolve();
  const settled = await controller.handle({ type: "settled" });
  gate.resolve(cont);
  const r = await pending;
  assert.equal(settled.continue, false);
  assert.equal(r.continue, false);
  assert.equal(controller.snapshot().continuations, 0);
  assert.equal(controller.snapshot().phase, "verification_unavailable");
});

test("verify controller: transition history export is a consistent, JSON-serialisable chain with injected timestamps", async () => {
  const { controller } = setup({ completion: incomplete, decision: cont });
  await controller.handle({ type: "tool_result", evidence: { id: "e1" } });
  await controller.handle({ type: "milestone", label: "m1" });
  await controller.handle({ type: "before_settle" });
  await controller.handle({ type: "user_message" });
  await controller.handle({ type: "mode_change", mode: "shadow" });
  await controller.handle({ type: "before_settle" });
  await controller.handle({ type: "settled" });
  const snap = controller.snapshot();
  const t = snap.transitions;
  assert.ok(t.length >= 6);
  for (let i = 1; i < t.length; i++) {
    assert.equal(t[i]!.from, t[i - 1]!.to, `transition ${i} starts where ${i - 1} ended`);
    assert.ok(t[i]!.at > t[i - 1]!.at, "timestamps come from the injected clock, strictly increasing");
  }
  assert.ok(t.every((x) => x.from !== x.to));
  assert.equal(t[0]!.from, "running");
  assert.equal(t.at(-1)!.to, snap.phase);
  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round, snap);
  // Detached: mutating the export does not change the controller.
  const count = t.length;
  snap.transitions.length = 0;
  snap.discarded.push({ at: 0, boundary: "milestone", generation: 0, checkpoint: 0, reason: "x" });
  assert.equal(controller.snapshot().transitions.length, count);
  assert.equal(controller.snapshot().discarded.length, 0);
});

test("verify controller: assess context gets a detached evidence copy", async () => {
  const seen: AssessContext[] = [];
  const { controller } = setup({ assess: (ctx) => (seen.push(ctx), passed) });
  const ev = { id: "e1" };
  await controller.handle({ type: "tool_result", evidence: ev });
  await controller.handle({ type: "before_settle" });
  await controller.handle({ type: "user_message" });
  await controller.handle({ type: "tool_result", evidence: { id: "e2" } });
  assert.deepEqual(seen[0]!.evidence, [ev]);
});

test("verify controller: decide returning continue with an empty prompt is guarded and adds no continuation", async () => {
  const { controller } = setup({ completion: incomplete, decision: { decision: "continue", prompt: "", actions: [] } });
  const r = await controller.handle({ type: "before_settle" });
  assert.deepEqual(r, { continue: false, phase: "incomplete", reason: "guard:missing_prompt" });
  assert.equal(controller.snapshot().continuations, 0);
});

test("verify controller: starting in off mode never assesses at any boundary", async () => {
  const { controller, assessCalls } = setup({ mode: "off", completion: incomplete, decision: cont });
  await controller.handle({ type: "milestone" });
  const r = await controller.handle({ type: "before_settle" });
  assert.deepEqual(r, { continue: false, phase: "running", reason: "mode_off" });
  assert.equal(assessCalls.length, 0);
});

// new progress during an in-flight before_settle invalidates its decision.
test("verify controller: a tool_result while decide is in flight discards the continue and records stale:checkpoint", async () => {
  const gate = deferred<ContinuationDecision>();
  const { controller, assessCalls } = setup({ completion: incomplete, decide: () => gate.promise });
  const pending = controller.handle({ type: "before_settle" });
  await Promise.resolve();
  await Promise.resolve();
  await controller.handle({ type: "tool_result", evidence: { id: "late" } });
  gate.resolve(cont);
  const r = await pending;
  assert.equal(r.continue, false);
  const snap = controller.snapshot();
  assert.equal(snap.continuations, 0);
  assert.equal(snap.phase, "running", "new progress returned the task to running; the stale decision does not move it");
  assert.equal(snap.discarded.at(-1)!.reason, "stale:checkpoint");
  // The new evidence gets its own assessment at the next boundary.
  await controller.handle({ type: "before_settle" });
  assert.equal(assessCalls.length, 2);
  assert.deepEqual(assessCalls[1]!.evidence, [{ id: "late" }]);
});

test("verify controller: a milestone while before_settle is in flight discards the stale decision instead of landing it", async () => {
  const gate = deferred<ContinuationDecision>();
  const { controller } = setup({ completion: passed, decide: () => gate.promise });
  const pending = controller.handle({ type: "before_settle" });
  await Promise.resolve();
  await Promise.resolve();
  await controller.handle({ type: "milestone", label: "m" });
  gate.resolve(stop);
  const r = await pending;
  assert.equal(r.continue, false);
  const snap = controller.snapshot();
  assert.equal(snap.phase, "running", "the milestone's state stands; the stale stop does not land completed");
  assert.equal(snap.discarded.at(-1)!.reason, "stale:checkpoint");
});
