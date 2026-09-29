import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChoiceEvidence, ChoiceQuestion, JevCallOptions, JevResult, NoulEvidence, NoulQuestion } from "../../../src/jev/index.ts";
import {
  ACCEPTANCE_QUESTION_ID,
  FOREMAN_DIMENSIONS,
  FOREMAN_DIMENSION_IDS,
  assessAcceptance,
  assessCheckpoint,
  chooseAssessment,
  decideForeman,
  validateForemanScores,
  type ChoiceAsk,
  type CompletionEvidence,
  type CompletionTask,
  type CompletionTaskKind,
  type ForemanScores,
} from "../../../src/harness/completion.ts";
import type { Evidence } from "../../../src/harness/evidence.ts";
import type { NoulAsk } from "../../../src/harness/review-types.ts";

const MODEL = "jev-1.13.0";
const attempt = { attemptId: "att-1", decisionId: "dec-1", startedAt: 0, durationMs: 1, status: "ok" as const, requestBytes: 1, responseBytes: 1 };

function check(overrides: Partial<Evidence> = {}): Evidence {
  return {
    actionId: "act-test",
    toolCallId: "call-test",
    toolName: "bash",
    outcome: "ok",
    exitCode: 0,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    output: { sha256: "a".repeat(64), bytes: 10, lines: 1, head: ["# pass 3"], headTruncated: false, nonTextBlocks: 0 },
    artifactRef: null,
    ...overrides,
  };
}

const change = { path: "src/a.ts", change: "modified" as const, before: "b".repeat(64), after: "c".repeat(64) };
const implTask: CompletionTask = { kind: "implementation", goal: "Make b equal 3.", criteria: ["b is 3", "tests pass"] };
const questionTask: CompletionTask = { kind: "question", goal: "What does foo() return?", criteria: [] };
const multiTask: CompletionTask = { kind: "multi_step", goal: "Build the importer.", criteria: ["importer reads CSV"] };
const fullEvidence: CompletionEvidence = { changes: [change], checks: [check()], summary: "Done, all good." };

function choiceAsk(respond: (q: readonly ChoiceQuestion[], o: JevCallOptions) => JevResult<ChoiceEvidence[]> | Promise<JevResult<ChoiceEvidence[]>>) {
  const calls: { questions: readonly ChoiceQuestion[]; options: JevCallOptions }[] = [];
  const ask: ChoiceAsk = async (questions, options) => {
    calls.push({ questions, options });
    return respond(questions, options);
  };
  return { ask, calls };
}

const choiceOk = (choice: "accepted" | "rejected"): JevResult<ChoiceEvidence[]> => ({
  ok: true,
  attempt,
  evidence: [
    {
      questionId: ACCEPTANCE_QUESTION_ID,
      model: MODEL,
      choice,
      confidence: 0.9,
      probabilities: choice === "accepted" ? { accepted: 0.9, rejected: 0.1 } : { accepted: 0.1, rejected: 0.9 },
    },
  ],
});

function noulAsk(respond: (q: readonly NoulQuestion[]) => JevResult<NoulEvidence[]>) {
  const calls: { questions: readonly NoulQuestion[]; options: JevCallOptions }[] = [];
  const ask: NoulAsk = async (questions, options) => {
    calls.push({ questions, options });
    return respond(questions);
  };
  return { ask, calls };
}

const FINISH_SCORES: ForemanScores = {
  implementation_complete: 0.95,
  tests_sufficient: 0.9,
  requirements_satisfied: 0.9,
  needs_verification: 0.1,
  meaningful_progress: 0.9,
  worker_stuck: 0.05,
  work_off_track: 0.05,
  agents_md_drift: 0.05,
  ready_to_finish: 0.95,
  needs_human: 0.05,
};

const noulOk = (scores: Partial<ForemanScores>): JevResult<NoulEvidence[]> => ({
  ok: true,
  attempt,
  evidence: Object.entries(scores).map(([questionId, yes]) => ({ questionId, model: MODEL, yes: yes as number })),
});

// --- chooseAssessment ---------------------------------------------------------

test("chooseAssessment picks exactly one assessment per task kind", () => {
  assert.equal(chooseAssessment("question"), "acceptance");
  assert.equal(chooseAssessment("implementation"), "acceptance");
  assert.equal(chooseAssessment("multi_step"), "foreman");
  assert.throws(() => chooseAssessment("other" as CompletionTaskKind), /Unknown task kind/);
});

test("assessAcceptance refuses a foreman task kind without asking (no stacking)", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: multiTask, evidence: fullEvidence, ask, decisionId: "d" });
  assert.equal(r.validation.ok, false);
  assert.notEqual(r.completionStatus, "passed");
  assert.equal(calls.length, 0);
});

test("assessCheckpoint refuses an acceptance task kind without asking (no stacking)", async () => {
  const { ask, calls } = noulAsk(() => noulOk(FINISH_SCORES));
  const r = await assessCheckpoint({ task: implTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask, decisionId: "d", activeWorker: false });
  assert.equal(r.validation.ok, false);
  assert.equal(calls.length, 0);
});

// --- assessAcceptance -------------------------------------------------------------

test("acceptance: Jev unavailable gives unavailable with stopAllowed true, never passed", async () => {
  const { ask, calls } = choiceAsk(() => ({ ok: false, error: { kind: "http_error", httpStatus: 503 }, attempt: { ...attempt, status: "http_error" } }));
  const r = await assessAcceptance({ task: implTask, evidence: fullEvidence, ask, decisionId: "d" });
  assert.equal(calls.length, 1);
  assert.equal(r.completionStatus, "unavailable");
  assert.equal(r.stopAllowed, true);
  assert.equal(r.validation.ok, true);
  assert.ok(r.evidenceRefs.includes("check:act-test"), "host check evidence is kept");
  assert.ok(r.evidenceRefs.includes("jev-attempt:att-1"));
});

test("acceptance: ask that throws or returns malformed evidence is unavailable", async () => {
  const thrown = await assessAcceptance({
    task: implTask,
    evidence: fullEvidence,
    ask: async () => {
      throw Error("socket hang up");
    },
    decisionId: "d",
  });
  assert.equal(thrown.completionStatus, "unavailable");
  assert.equal(thrown.stopAllowed, true);
  const { ask } = choiceAsk(() => ({ ok: true, attempt, evidence: [] }));
  const malformed = await assessAcceptance({ task: implTask, evidence: fullEvidence, ask, decisionId: "d" });
  assert.equal(malformed.completionStatus, "unavailable");
  assert.equal(malformed.model, null);
});

test("acceptance: code changes without check evidence are incomplete with a 缺少验证 gap", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: implTask, evidence: { changes: [change], checks: [], summary: "Tests pass, done." }, ask, decisionId: "d" });
  assert.equal(r.completionStatus, "incomplete");
  assert.equal(r.stopAllowed, false);
  const gap = r.gaps.find((g) => g.code === "missing_verification");
  assert.ok(gap);
  assert.match(gap.message, /缺少验证/);
  assert.equal(calls.length, 0, "Jev cannot override a deterministic host gap");
});

test("acceptance: model summary alone cannot pass an implementation task", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({
    task: implTask,
    evidence: { changes: [], checks: [], summary: "Implemented everything and all tests pass." },
    ask,
    decisionId: "d",
  });
  assert.equal(r.completionStatus, "incomplete");
  assert.deepEqual(r.gaps.map((g) => g.code).sort(), ["missing_changes", "missing_verification"]);
  assert.equal(calls.length, 0);
});

test("acceptance: a failing check is a concrete gap", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: implTask, evidence: { changes: [change], checks: [check({ outcome: "error", exitCode: 1 })] }, ask, decisionId: "d" });
  assert.equal(r.completionStatus, "incomplete");
  const gap = r.gaps.find((g) => g.code === "check_failed");
  assert.ok(gap);
  assert.match(gap.message, /退出码 1/);
  assert.equal(calls.length, 0);
});

test("acceptance: question task can pass on the answer alone", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: questionTask, evidence: { changes: [], checks: [], answer: "foo() returns 42." }, ask, decisionId: "d" });
  assert.equal(r.completionStatus, "passed");
  assert.equal(r.stopAllowed, true);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.model, MODEL);
  assert.equal(calls.length, 1);
});

test("acceptance: question task without an answer is incomplete", async () => {
  const { ask } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: questionTask, evidence: { changes: [], checks: [], answer: "  " }, ask, decisionId: "d" });
  assert.equal(r.completionStatus, "incomplete");
  assert.equal(r.gaps[0]?.code, "missing_answer");
});

test("acceptance: implementation task with changes, passing checks and Jev accept passes", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: implTask, evidence: fullEvidence, ask, decisionId: "dec-7" });
  assert.equal(r.completionStatus, "passed");
  assert.equal(r.stopAllowed, true);
  assert.deepEqual(r.evidenceRefs, ["change:src/a.ts", "check:act-test", "jev-attempt:att-1"]);
  const state = calls[0]!.options.state as Record<string, unknown>;
  assert.equal(calls[0]!.options.decisionId, "dec-7");
  assert.ok("host_evidence" in state);
  assert.equal(state.worker_summary_untrusted, "Done, all good.");
});

test("acceptance: Jev reject gives incomplete with non-empty specific gaps", async () => {
  const { ask } = choiceAsk(() => choiceOk("rejected"));
  const r = await assessAcceptance({ task: implTask, evidence: fullEvidence, ask, decisionId: "d" });
  assert.equal(r.completionStatus, "incomplete");
  assert.equal(r.stopAllowed, false);
  assert.ok(r.gaps.length > 0);
  assert.deepEqual(
    r.gaps.map((g) => g.message),
    ["未证实满足：b is 3", "未证实满足：tests pass"],
  );
});

test("acceptance: pre-cancelled signal makes 0 ask calls and is unavailable", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const controller = new AbortController();
  controller.abort();
  const r = await assessAcceptance({ task: implTask, evidence: fullEvidence, ask, decisionId: "d", signal: controller.signal });
  assert.equal(calls.length, 0);
  assert.equal(r.completionStatus, "unavailable");
  assert.equal(r.stopAllowed, true);
});

test("acceptance: cancelled after ask returned is unavailable even when Jev accepted", async () => {
  const controller = new AbortController();
  const { ask, calls } = choiceAsk(() => {
    controller.abort();
    return choiceOk("accepted");
  });
  const r = await assessAcceptance({ task: implTask, evidence: fullEvidence, ask, decisionId: "d", signal: controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(r.completionStatus, "unavailable");
  assert.equal(r.model, null);
});

test("acceptance: invalid input returns validation errors without asking", async () => {
  const { ask, calls } = choiceAsk(() => choiceOk("accepted"));
  const r = await assessAcceptance({ task: { ...implTask, goal: "" }, evidence: fullEvidence, ask, decisionId: "d" });
  assert.equal(r.validation.ok, false);
  assert.equal(r.completionStatus, "unavailable");
  assert.equal(calls.length, 0);
});

// --- foreman scores and decide -----------------------------------------------------------

test("validateForemanScores rejects a missing dimension instead of filling 0", () => {
  const { ready_to_finish: _, ...partial } = FINISH_SCORES;
  const v = validateForemanScores(partial);
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.errors.includes("missing dimension ready_to_finish"));
});

test("validateForemanScores rejects out-of-range and non-finite values instead of clamping", () => {
  assert.equal(validateForemanScores({ ...FINISH_SCORES, tests_sufficient: 1.2 }).ok, false);
  assert.equal(validateForemanScores({ ...FINISH_SCORES, tests_sufficient: Number.NaN }).ok, false);
  assert.equal(validateForemanScores({ ...FINISH_SCORES, extra: 0.5 }).ok, false);
  assert.equal(validateForemanScores(FINISH_SCORES).ok, true);
});

test("decideForeman keeps O's decision order and thresholds", () => {
  assert.equal(decideForeman({ ...FINISH_SCORES, needs_human: 0.9 }, { activeWorker: false }).action, "ESCALATE");
  assert.equal(decideForeman({ ...FINISH_SCORES, worker_stuck: 0.9 }).action, "STEER");
  assert.equal(decideForeman(FINISH_SCORES).action, "CONTINUE");
  assert.equal(decideForeman(FINISH_SCORES, { activeWorker: false }).action, "FINISH");
  assert.equal(decideForeman({ ...FINISH_SCORES, needs_verification: 0.7 }, { activeWorker: false }).action, "VERIFY");
});

// --- assessCheckpoint --------------------------------------------------------------------

test("checkpoint: a missing input dimension returns invalid with 0 ask calls", async () => {
  const { ask, calls } = noulAsk(() => noulOk(FINISH_SCORES));
  const r = await assessCheckpoint({
    task: multiTask,
    evidence: fullEvidence,
    dimensions: FOREMAN_DIMENSIONS.filter((d) => d.id !== "tests_sufficient"),
    ask,
    decisionId: "d",
    activeWorker: false,
  });
  assert.equal(r.validation.ok, false);
  assert.ok(r.validation.errors.includes("missing dimension tests_sufficient"));
  assert.notEqual(r.completionStatus, "passed");
  assert.equal(calls.length, 0);
});

test("checkpoint: Jev answer missing one dimension returns invalid, not FINISH", async () => {
  const { needs_verification: _, ...nine } = FINISH_SCORES;
  const { ask, calls } = noulAsk(() => noulOk(nine));
  const r = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask, decisionId: "d", activeWorker: false });
  assert.equal(calls.length, 1);
  assert.equal(r.validation.ok, false);
  assert.ok(r.validation.errors.includes("missing dimension needs_verification"));
  assert.notEqual(r.completionStatus, "passed");
});

test("checkpoint: asks all ten dimensions in one call and passes on FINISH with host evidence", async () => {
  const { ask, calls } = noulAsk(() => noulOk(FINISH_SCORES));
  const r = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask, decisionId: "d", activeWorker: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.questions.map((q) => q.id), [...FOREMAN_DIMENSION_IDS]);
  assert.equal(r.assessment, "foreman");
  assert.equal(r.completionStatus, "passed");
  assert.equal(r.stopAllowed, true);
  assert.equal(r.model, MODEL);
});

test("checkpoint: FINISH without check evidence is incomplete with 缺少验证", async () => {
  const { ask } = noulAsk(() => noulOk(FINISH_SCORES));
  const r = await assessCheckpoint({ task: multiTask, evidence: { changes: [change], checks: [] }, dimensions: FOREMAN_DIMENSIONS, ask, decisionId: "d", activeWorker: false });
  assert.equal(r.completionStatus, "incomplete");
  assert.equal(r.stopAllowed, false);
  assert.match(r.gaps.find((g) => g.code === "missing_verification")?.message ?? "", /缺少验证/);
});

test("checkpoint: Jev unavailable gives unavailable with stopAllowed true", async () => {
  const { ask } = noulAsk(() => ({ ok: false, error: { kind: "timeout" } }));
  const r = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask, decisionId: "d", activeWorker: false });
  assert.equal(r.completionStatus, "unavailable");
  assert.equal(r.stopAllowed, true);
});

test("checkpoint: pre-cancelled makes 0 ask calls; cancel after return is unavailable", async () => {
  const pre = new AbortController();
  pre.abort();
  const first = noulAsk(() => noulOk(FINISH_SCORES));
  const r1 = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask: first.ask, decisionId: "d", activeWorker: false, signal: pre.signal });
  assert.equal(first.calls.length, 0);
  assert.equal(r1.completionStatus, "unavailable");

  const post = new AbortController();
  const second = noulAsk(() => {
    post.abort();
    return noulOk(FINISH_SCORES);
  });
  const r2 = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask: second.ask, decisionId: "d", activeWorker: false, signal: post.signal });
  assert.equal(second.calls.length, 1);
  assert.equal(r2.completionStatus, "unavailable");
});

test("checkpoint: ESCALATE is blocked with a needs_human gap", async () => {
  const { ask } = noulAsk(() => noulOk({ ...FINISH_SCORES, needs_human: 0.95 }));
  const r = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask, decisionId: "d", activeWorker: false });
  assert.equal(r.completionStatus, "blocked");
  assert.equal(r.stopAllowed, true);
  assert.equal(r.gaps[0]?.code, "needs_human");
});

test("checkpoint: CONTINUE and VERIFY are incomplete with non-empty gaps", async () => {
  const cont = noulAsk(() => noulOk({ ...FINISH_SCORES, tests_sufficient: 0.3, ready_to_finish: 0.4 }));
  const r1 = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask: cont.ask, decisionId: "d", activeWorker: false });
  assert.equal(r1.completionStatus, "incomplete");
  assert.equal(r1.stopAllowed, false);
  assert.ok(r1.gaps.length >= 2);
  assert.ok(r1.gaps.every((g) => g.message.length > 0));

  const active = noulAsk(() => noulOk(FINISH_SCORES));
  const r2 = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask: active.ask, decisionId: "d" });
  assert.equal(r2.completionStatus, "incomplete");
  assert.ok(r2.gaps.length > 0);

  const verify = noulAsk(() => noulOk({ ...FINISH_SCORES, needs_verification: 0.9 }));
  const r3 = await assessCheckpoint({ task: multiTask, evidence: fullEvidence, dimensions: FOREMAN_DIMENSIONS, ask: verify.ask, decisionId: "d", activeWorker: false });
  assert.equal(r3.completionStatus, "incomplete");
  assert.equal(r3.gaps[0]?.code, "needs_verification");
});
