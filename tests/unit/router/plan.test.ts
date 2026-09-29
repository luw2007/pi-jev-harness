import assert from "node:assert/strict";
import test from "node:test";
import {
  choosePlan,
  DEFAULT_MAX_DAG_STEPS,
  PLAN_QUESTION_ID,
  PLAN_QUESTION_VERSION,
  validatePlan,
} from "../../../src/router/plan.ts";
import type { Plan, PlanAnswer, PlanAskFn, PlanCandidate, PlanIssueCode, PlanKind } from "../../../src/router/plan.ts";
import type { ChoiceQuestion } from "../../../src/jev/types.ts";

const codes = (plan: unknown, options?: Parameters<typeof validatePlan>[1]): PlanIssueCode[] => {
  const result = validatePlan(plan, options);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

const candidate = (id: string, kind: PlanKind, steps?: Plan["steps"]): PlanCandidate => ({
  id,
  plan: {
    kind,
    steps: steps ?? (kind === "parallel"
      ? [{ id: "a", writeScope: ["src/a"] }, { id: "b", writeScope: ["src/b"] }]
      : kind === "dag"
        ? [{ id: "a" }, { id: "b", dependsOn: ["a"] }]
        : [{ id: "only", roots: ["edit"] }]),
  },
});

const direct = candidate("here", "direct");
const single = candidate("sub", "single");
const parallel = candidate("fan", "parallel");
const dag = candidate("graph", "dag");

function answer(choice: string, probabilities: Record<string, number>, extra: Partial<PlanAnswer> = {}): PlanAnswer {
  const confidence = probabilities[choice] ?? 0;
  return { evidence: { questionId: PLAN_QUESTION_ID, model: "jev-test", choice, confidence, probabilities }, ...extra };
}

function countingAsk(respond: (question: ChoiceQuestion) => Promise<PlanAnswer>): { ask: PlanAskFn; calls: () => number; questions: ChoiceQuestion[] } {
  let calls = 0;
  const questions: ChoiceQuestion[] = [];
  return {
    ask: async (question) => {
      calls += 1;
      questions.push(question);
      return respond(question);
    },
    calls: () => calls,
    questions,
  };
}

// ---- validatePlan ----

test("valid direct, single, parallel and dag plans pass", () => {
  for (const c of [direct, single, parallel, dag]) {
    const result = validatePlan(c.plan);
    assert.equal(result.ok, true, c.id);
  }
});

test("non-object and unknown kinds are rejected (closed set)", () => {
  assert.deepEqual(codes(null), ["not_object"]);
  assert.deepEqual(codes([]), ["not_object"]);
  assert.deepEqual(codes({ kind: "swarm", steps: [{ id: "a" }] }), ["unknown_kind"]);
  assert.deepEqual(codes({ kind: "DIRECT", steps: [{ id: "a" }] }), ["unknown_kind"]);
});

test("empty plans are rejected", () => {
  assert.deepEqual(codes({ kind: "dag", steps: [] }), ["empty_plan"]);
  assert.deepEqual(codes({ kind: "direct" }), ["empty_plan"]);
});

test("direct and single need exactly one step; multi-file work is still one step", () => {
  assert.deepEqual(codes({ kind: "direct", steps: [{ id: "a" }, { id: "b" }] }), ["step_count"]);
  assert.deepEqual(codes({ kind: "single", steps: [{ id: "a" }, { id: "b" }] }), ["step_count"]);
  assert.equal(validatePlan({ kind: "single", steps: [{ id: "a", writeScope: ["src/x.ts", "src/y.ts"] }] }).ok, true);
});

test("steps without a non-empty string id, or with non-string lists, are invalid", () => {
  assert.deepEqual(codes({ kind: "dag", steps: [{ id: "" }, { id: "b" }] }), ["invalid_step"]);
  assert.deepEqual(codes({ kind: "dag", steps: [{}, { id: "b" }] }), ["invalid_step"]);
  assert.deepEqual(codes({ kind: "dag", steps: [{ id: "a", dependsOn: [1] }] }), ["invalid_step"]);
  assert.deepEqual(codes({ kind: "dag", steps: [{ id: "a", roots: ["", "read"] }] }), ["invalid_root"]);
});

test("duplicate step ids are rejected", () => {
  assert.deepEqual(codes({ kind: "dag", steps: [{ id: "a" }, { id: "a" }] }), ["duplicate_step_id"]);
});

test("unknown step references are rejected", () => {
  const result = validatePlan({ kind: "dag", steps: [{ id: "a" }, { id: "b", dependsOn: ["ghost"] }] });
  assert.deepEqual(result, { ok: false, issues: [{ code: "unknown_step_ref", stepId: "b", otherId: "ghost" }] });
});

test("unknown tool roots are rejected when the known set is given", () => {
  const plan = { kind: "single", steps: [{ id: "a", roots: ["read", "teleport"] }] };
  assert.equal(validatePlan(plan).ok, true);
  const result = validatePlan(plan, { knownRoots: new Set(["read", "edit"]) });
  assert.deepEqual(result, { ok: false, issues: [{ code: "unknown_root", stepId: "a", otherId: "teleport" }] });
});

test("cycles are rejected, including self-dependency and long cycles", () => {
  assert.deepEqual(codes({ kind: "dag", steps: [{ id: "a", dependsOn: ["a"] }] }), ["cycle"]);
  assert.deepEqual(codes({ kind: "dag", steps: [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }] }), ["cycle"]);
  assert.deepEqual(
    codes({ kind: "dag", steps: [{ id: "a", dependsOn: ["c"] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }] }),
    ["cycle"],
  );
  // Diamond is not a cycle.
  assert.equal(
    validatePlan({ kind: "dag", steps: [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["a"] }, { id: "d", dependsOn: ["b", "c"] }] }).ok,
    true,
  );
});

test("dag step count is capped by a configurable maximum", () => {
  const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));
  assert.equal(validatePlan({ kind: "dag", steps: steps(DEFAULT_MAX_DAG_STEPS) }).ok, true);
  assert.deepEqual(codes({ kind: "dag", steps: steps(DEFAULT_MAX_DAG_STEPS + 1) }), ["too_many_steps"]);
  assert.deepEqual(codes({ kind: "dag", steps: steps(3) }, { maxDagSteps: 2 }), ["too_many_steps"]);
  assert.equal(validatePlan({ kind: "dag", steps: steps(3) }, { maxDagSteps: 3 }).ok, true);
});

test("parallel steps with overlapping write scopes are rejected", () => {
  const overlap = (a: string[], b: string[]) => codes({ kind: "parallel", steps: [{ id: "a", writeScope: a }, { id: "b", writeScope: b }] });
  assert.deepEqual(overlap(["src/x.ts"], ["src/x.ts"]), ["write_scope_overlap"]);
  assert.deepEqual(overlap(["src"], ["src/router/plan.ts"]), ["write_scope_overlap"]);
  assert.deepEqual(overlap(["./src/"], ["src//a.ts"]), ["write_scope_overlap"]);
  assert.deepEqual(overlap(["."], ["docs/a.md"]), ["write_scope_overlap"]);
  // Sibling with a shared name prefix is not an overlap.
  assert.deepEqual(overlap(["src/a"], ["src/ab"]), []);
  // Read-only steps never overlap.
  assert.deepEqual(overlap([], ["src"]), []);
});

test("parallel steps need a decidable write scope and no dependencies", () => {
  assert.deepEqual(codes({ kind: "parallel", steps: [{ id: "a" }, { id: "b", writeScope: [] }] }), ["write_scope_missing"]);
  assert.deepEqual(codes({ kind: "parallel", steps: [{ id: "a", writeScope: ["../x"] }, { id: "b", writeScope: [] }] }), ["invalid_write_scope"]);
  assert.deepEqual(codes({ kind: "parallel", steps: [{ id: "a", writeScope: ["/etc"] }, { id: "b", writeScope: [] }] }), ["invalid_write_scope"]);
  assert.deepEqual(
    codes({ kind: "parallel", steps: [{ id: "a", writeScope: [] }, { id: "b", writeScope: [], dependsOn: ["a"] }] }),
    ["parallel_dependency"],
  );
});

test("validation does not mutate the input plan", () => {
  const plan = { kind: "dag", steps: [{ id: "a", roots: ["read"] }, { id: "b", dependsOn: ["a"] }] };
  const before = structuredClone(plan);
  const result = validatePlan(plan);
  assert.equal(result.ok, true);
  assert.deepEqual(plan, before);
});

// ---- choosePlan ----

test("single eligible candidate is chosen without asking", async () => {
  const jev = countingAsk(async () => answer("here", { here: 1 }));
  const decision = await choosePlan({ taskIntent: "fix typo", candidates: [direct, parallel], ask: jev.ask });
  assert.equal(jev.calls(), 0);
  assert.equal(decision.source, "single_candidate");
  assert.equal(decision.selectedId, "here");
  assert.equal(decision.effectiveId, "here");
  assert.equal(decision.kind, "direct");
  assert.equal(decision.executable, true);
  assert.equal(decision.questionVersion, null);
  assert.equal(decision.probabilities, null);
  assert.deepEqual(decision.excluded, [{ id: "fan", reason: "kind_not_allowed" }]);
});

test("jev chooses among allowed candidates only; question offers only allowed ids", async () => {
  const jev = countingAsk(async () => answer("sub", { here: 0.3, sub: 0.7 }, { usage: { requests: 1 } }));
  let clock = 1000;
  const decision = await choosePlan({
    taskIntent: "refactor module",
    candidates: [direct, single, parallel, dag],
    ask: jev.ask,
    now: () => (clock += 5),
  });
  assert.equal(jev.calls(), 1);
  assert.deepEqual(jev.questions[0]!.options.map((option) => option.id), ["here", "sub"]);
  assert.deepEqual(decision, {
    selectedId: "sub",
    effectiveId: "sub",
    kind: "single",
    executable: true,
    reason: "chosen by jev",
    source: "jev",
    questionVersion: PLAN_QUESTION_VERSION,
    probabilities: { here: 0.3, sub: 0.7 },
    confidence: 0.7,
    excluded: [
      { id: "fan", reason: "kind_not_allowed" },
      { id: "graph", reason: "kind_not_allowed" },
    ],
    elapsedMs: 5,
    usage: { requests: 1 },
  });
});

test("disallowed kind picked by jev is an invalid answer and falls back to direct", async () => {
  const jev = countingAsk(async () => answer("fan", { here: 0.1, sub: 0.1, fan: 0.8 }));
  const decision = await choosePlan({ taskIntent: "t", candidates: [direct, single, parallel], ask: jev.ask });
  assert.equal(decision.source, "fallback");
  assert.equal(decision.selectedId, "fan");
  assert.equal(decision.effectiveId, "here");
  assert.equal(decision.kind, "direct");
  assert.match(decision.reason, /outside allowed candidate set/);
});

test("parallel/dag are selectable only when explicitly allowed, and are never executable", async () => {
  const jev = countingAsk(async () => answer("graph", { here: 0.2, graph: 0.8 }));
  const decision = await choosePlan({ taskIntent: "t", candidates: [direct, dag], ask: jev.ask, allowed: ["direct", "dag"] });
  assert.equal(decision.source, "jev");
  assert.equal(decision.kind, "dag");
  assert.equal(decision.executable, false);
});

test("invalid candidate plans are excluded with their issues", async () => {
  const broken = candidate("broken", "dag", [{ id: "a", dependsOn: ["a"] }]);
  const jev = countingAsk(async () => answer("here", { here: 1 }));
  const decision = await choosePlan({ taskIntent: "t", candidates: [broken, direct, direct], ask: jev.ask, allowed: ["direct", "dag"] });
  assert.equal(jev.calls(), 0);
  assert.equal(decision.source, "single_candidate");
  assert.deepEqual(decision.excluded, [
    { id: "broken", reason: "invalid_plan", issues: [{ code: "cycle", stepId: "a" }] },
    { id: "here", reason: "duplicate_candidate_id" },
  ]);
});

test("pre-cancelled signal sends zero asks and falls back to direct", async () => {
  const jev = countingAsk(async () => answer("sub", { here: 0, sub: 1 }));
  const controller = new AbortController();
  controller.abort();
  const decision = await choosePlan({ taskIntent: "t", candidates: [direct, single], ask: jev.ask, signal: controller.signal });
  assert.equal(jev.calls(), 0);
  assert.equal(decision.source, "fallback");
  assert.equal(decision.effectiveId, "here");
  assert.equal(decision.questionVersion, null);
  assert.match(decision.reason, /cancelled before ask/);
});

test("answer arriving after cancellation is not adopted", async () => {
  const controller = new AbortController();
  const jev = countingAsk(async () => {
    controller.abort();
    return answer("sub", { here: 0, sub: 1 });
  });
  const decision = await choosePlan({ taskIntent: "t", candidates: [direct, single], ask: jev.ask, signal: controller.signal });
  assert.equal(decision.source, "fallback");
  assert.equal(decision.selectedId, undefined);
  assert.equal(decision.effectiveId, "here");
});

test("jev unavailable falls back to direct with a reason and leaves evidence untouched", async () => {
  const candidates = [single, direct];
  const before = structuredClone(candidates);
  const jev = countingAsk(async () => {
    throw new TypeError("network down");
  });
  const decision = await choosePlan({ taskIntent: "t", candidates, ask: jev.ask });
  assert.equal(jev.calls(), 1);
  assert.equal(decision.source, "fallback");
  assert.equal(decision.selectedId, undefined);
  assert.equal(decision.effectiveId, "here");
  assert.equal(decision.kind, "direct");
  assert.match(decision.reason, /jev unavailable \(TypeError\)/);
  assert.equal(decision.probabilities, null);
  assert.equal(decision.questionVersion, PLAN_QUESTION_VERSION);
  assert.deepEqual(candidates, before);
});

test("fallback without a direct candidate still means direct, with no effective candidate", async () => {
  const other = candidate("sub2", "single");
  const jev = countingAsk(async () => {
    throw new Error("down");
  });
  const decision = await choosePlan({ taskIntent: "t", candidates: [single, other], ask: jev.ask });
  assert.equal(decision.effectiveId, undefined);
  assert.equal(decision.kind, "direct");
  assert.equal(decision.executable, true);
});

test("invalid probabilities fall back and keep the raw evidence as reported", async () => {
  const bad: Record<string, number>[] = [
    { here: Number.NaN, sub: 1 },
    { here: 0.3, sub: 0.6 },
    { here: 0.3, sub: 0.7 + 0.02 },
    { here: -0.1, sub: 1.1 },
    { here: Number.POSITIVE_INFINITY, sub: 0 },
    { sub: 1 },
    { here: 0, sub: 0.9, extra: 0.1 },
  ];
  for (const probabilities of bad) {
    const jev = countingAsk(async () => answer("sub", probabilities));
    const decision = await choosePlan({ taskIntent: "t", candidates: [direct, single], ask: jev.ask });
    assert.equal(decision.source, "fallback", JSON.stringify(probabilities));
    assert.match(decision.reason, /invalid probabilities/);
    assert.equal(decision.selectedId, "sub");
    assert.equal(decision.effectiveId, "here");
    assert.deepEqual(decision.probabilities, probabilities);
  }
});

test("probability sum within 1e-6 is accepted", async () => {
  const jev = countingAsk(async () => answer("sub", { here: 0.3, sub: 0.7 + 5e-7 }));
  const decision = await choosePlan({ taskIntent: "t", candidates: [direct, single], ask: jev.ask });
  assert.equal(decision.source, "jev");
});

test("answer for a different question id falls back", async () => {
  const jev = countingAsk(async () => ({
    evidence: { questionId: "route", model: "jev-test", choice: "sub", confidence: 1, probabilities: { here: 0, sub: 1 } },
  }));
  const decision = await choosePlan({ taskIntent: "t", candidates: [direct, single], ask: jev.ask });
  assert.equal(decision.source, "fallback");
  assert.match(decision.reason, /different question/);
});

test("pinned eligible candidate is used without asking; ineligible pin falls back", async () => {
  const jev = countingAsk(async () => answer("here", { here: 1, sub: 0 }));
  const pinned = await choosePlan({ taskIntent: "t", candidates: [direct, single], ask: jev.ask, pinnedId: "sub" });
  assert.equal(pinned.source, "pinned");
  assert.equal(pinned.effectiveId, "sub");
  const blocked = await choosePlan({ taskIntent: "t", candidates: [direct, single, parallel], ask: jev.ask, pinnedId: "fan" });
  assert.equal(blocked.source, "fallback");
  assert.equal(blocked.selectedId, "fan");
  assert.equal(blocked.effectiveId, "here");
  assert.equal(jev.calls(), 0);
});

test("no eligible candidates falls back to direct without asking", async () => {
  const jev = countingAsk(async () => answer("fan", { fan: 1 }));
  const decision = await choosePlan({ taskIntent: "t", candidates: [parallel, dag], ask: jev.ask });
  assert.equal(jev.calls(), 0);
  assert.equal(decision.source, "fallback");
  assert.equal(decision.effectiveId, undefined);
  assert.equal(decision.kind, "direct");
  assert.equal(decision.elapsedMs, null);
  assert.equal(decision.usage, null);
});

test("task intent is passed as state data", async () => {
  let state: unknown;
  const ask: PlanAskFn = async (_question, s) => {
    state = s;
    return answer("here", { here: 0.5, sub: 0.5 });
  };
  await choosePlan({ taskIntent: "rename helper", candidates: [direct, single], ask });
  assert.equal(state, "rename helper");
});
