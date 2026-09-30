import assert from "node:assert/strict";
import test from "node:test";
import {
  TYPESAFE_PROFILE,
  choiceBody,
  noulBody,
  parseChoice,
  parseChoiceResponse,
  parseNoul,
  parseNoulResponse,
  type ChoiceQuestion,
  type NoulQuestion,
} from "../../../src/jev/index.ts";

const MODEL = "jev-1.13.0";
const route: ChoiceQuestion = {
  id: "route",
  question: "Which tool fits?",
  options: [
    { id: "read", description: "Read a file" },
    { id: "edit", description: "Edit a file" },
    { id: "ask", description: "Ask for clarification" },
  ],
};
const choiceAnswer = (answer: Record<string, unknown> = {}) => ({
  type: "choice",
  choice: "read",
  confidence: 0.7,
  probabilities: { read: 0.7, edit: 0.2, ask: 0.1 },
  ...answer,
});
const choiceResponse = (answer: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  answers: { route: choiceAnswer(answer) },
  ...extra,
});
const failureKind = (result: { ok: boolean; error?: { kind: string } }) => (result.ok ? "ok" : result.error!.kind);

test("first profile pins jev-1.13.0", () => {
  assert.equal(TYPESAFE_PROFILE.model, "jev-1.13.0");
});

test("valid choice parses into exact evidence", () => {
  const result = parseChoice(choiceResponse(), route, MODEL);
  assert.deepEqual(result, {
    ok: true,
    value: { questionId: "route", model: MODEL, choice: "read", confidence: 0.7, probabilities: { read: 0.7, edit: 0.2, ask: 0.1 } },
  });
});

test("choice argmax tie with the chosen option is accepted", () => {
  const result = parseChoice(choiceResponse({ choice: "edit", probabilities: { read: 0.4, edit: 0.4, ask: 0.2 } }), route, MODEL);
  assert.equal(failureKind(result), "ok");
});

test("answer under a different question id is rejected", () => {
  const raw = { model: MODEL, answers: { routing: choiceAnswer() } };
  assert.deepEqual(parseChoice(raw, route, MODEL), { ok: false, error: { kind: "question_id_mismatch", questionId: "route" } });
});

test("choice outside the closed set is rejected", () => {
  const result = parseChoice(choiceResponse({ choice: "delete" }), route, MODEL);
  assert.equal(failureKind(result), "choice_not_in_set");
});

test("distribution missing an option is rejected, not filled", () => {
  const result = parseChoice(choiceResponse({ probabilities: { read: 0.8, edit: 0.2 } }), route, MODEL);
  assert.equal(failureKind(result), "distribution_missing_option");
});

test("distribution with an extra option is rejected", () => {
  const result = parseChoice(
    choiceResponse({ probabilities: { read: 0.7, edit: 0.2, ask: 0.05, delete: 0.05 } }),
    route,
    MODEL,
  );
  assert.equal(failureKind(result), "distribution_extra_option");
});

test("absent distribution is rejected", () => {
  const result = parseChoice(choiceResponse({ probabilities: undefined }), route, MODEL);
  assert.equal(failureKind(result), "distribution_missing");
});

test("NaN, infinite, string and out-of-range probabilities are rejected, not clamped", () => {
  for (const read of [Number.NaN, Number.POSITIVE_INFINITY, "0.7", 1.2, -0.1]) {
    const result = parseChoice(choiceResponse({ probabilities: { read, edit: 0.2, ask: 0.1 } }), route, MODEL);
    assert.equal(failureKind(result), "probability_invalid", `read=${String(read)}`);
  }
});

test("distribution off by more than the 0.01 tolerance is rejected", () => {
  const low = parseChoice(choiceResponse({ probabilities: { read: 0.6, edit: 0.2, ask: 0.1 } }), route, MODEL);
  const high = parseChoice(choiceResponse({ probabilities: { read: 0.7, edit: 0.2, ask: 0.1 + 0.011 } }), route, MODEL);
  assert.equal(failureKind(low), "probability_sum");
  assert.equal(failureKind(high), "probability_sum");
});

test("sum within tolerance is accepted", () => {
  const result = parseChoice(choiceResponse({ probabilities: { read: 0.7, edit: 0.2, ask: 0.1 + 5e-7 } }), route, MODEL);
  assert.equal(failureKind(result), "ok");
});

test("choice that is not the argmax is rejected", () => {
  const result = parseChoice(choiceResponse({ choice: "edit" }), route, MODEL);
  assert.equal(failureKind(result), "choice_not_argmax");
});

test("invalid confidence is rejected", () => {
  for (const confidence of [undefined, Number.NaN, 1.5, -0.2, "0.7"]) {
    assert.equal(failureKind(parseChoice(choiceResponse({ confidence }), route, MODEL)), "confidence_invalid");
  }
});

test("missing model is rejected", () => {
  const raw = { answers: { route: choiceAnswer() } };
  assert.equal(failureKind(parseChoice(raw, route, MODEL)), "model_missing");
  assert.equal(failureKind(parseChoice({ ...raw, model: "" }, route, MODEL)), "model_missing");
});

test("different model is rejected, including aliases", () => {
  for (const model of ["jev-latest", "typesafe/jev-1.13", "jev-1.13.1"]) {
    assert.equal(failureKind(parseChoice(choiceResponse({}, { model }), route, MODEL)), "model_mismatch");
  }
});

test("wrong answer type and non-object responses are rejected", () => {
  assert.equal(failureKind(parseChoice(choiceResponse({ type: "noul" }), route, MODEL)), "answer_type");
  assert.equal(failureKind(parseChoice(null, route, MODEL)), "not_object");
  assert.equal(failureKind(parseChoice([], route, MODEL)), "not_object");
  assert.equal(failureKind(parseChoice({ model: MODEL }, route, MODEL)), "answers_missing");
});

test("batch response must answer exactly the asked ids", () => {
  const extra = { model: MODEL, answers: { route: choiceAnswer(), other: choiceAnswer() } };
  assert.deepEqual(parseChoiceResponse(extra, [route], MODEL), { ok: false, error: { kind: "question_id_mismatch" } });
  assert.equal(failureKind(parseChoiceResponse(choiceResponse(), [route], MODEL)), "ok");
});

const noulQuestions: NoulQuestion[] = [
  { id: "safe", question: "Is the change safe?" },
  { id: "done", question: "Is the task done?" },
];

test("valid noul batch parses", () => {
  const raw = { model: MODEL, answers: { safe: { type: "noul", noul: 0.9 }, done: { type: "noul", noul: 0 } } };
  assert.deepEqual(parseNoulResponse(raw, noulQuestions, MODEL), {
    ok: true,
    value: [
      { questionId: "safe", model: MODEL, yes: 0.9 },
      { questionId: "done", model: MODEL, yes: 0 },
    ],
  });
});

test("incomplete noul batch is rejected", () => {
  const raw = { model: MODEL, answers: { safe: { type: "noul", noul: 0.9 } } };
  assert.deepEqual(parseNoulResponse(raw, noulQuestions, MODEL), {
    ok: false,
    error: { kind: "question_id_mismatch", questionId: "done" },
  });
});

test("noul without a valid probability is rejected, not clamped", () => {
  for (const noul of [undefined, Number.NaN, 1.01, -0.01, "0.5", null]) {
    const raw = { model: MODEL, answers: { safe: { type: "noul", noul } } };
    assert.equal(failureKind(parseNoul(raw, noulQuestions[0]!, MODEL)), "noul_invalid", `noul=${String(noul)}`);
  }
  const untyped = { model: MODEL, answers: { safe: { noul: 0.5 } } };
  assert.equal(failureKind(parseNoul(untyped, noulQuestions[0]!, MODEL)), "answer_type");
});

test("noul model missing or different is rejected", () => {
  const answers = { safe: { type: "noul", noul: 0.5 } };
  assert.equal(failureKind(parseNoul({ answers }, noulQuestions[0]!, MODEL)), "model_missing");
  assert.equal(failureKind(parseNoul({ model: "jev-latest", answers }, noulQuestions[0]!, MODEL)), "model_mismatch");
});

test("request bodies serialize only whitelisted fields", () => {
  const leaky = {
    ...route,
    secret: "question-extra",
    options: route.options.map((o) => ({ ...o, cost: 99, note: "option-extra" })),
  } as ChoiceQuestion;
  assert.deepEqual(JSON.parse(choiceBody(MODEL, { task: "t" }, [leaky])), {
    model: MODEL,
    state: { task: "t" },
    questions: {
      route: {
        type: "choice",
        instructions: "Which tool fits?",
        criteria: { read: "Read a file", edit: "Edit a file", ask: "Ask for clarification" },
      },
    },
  });
  const noul = [{ id: "safe", question: "Safe?", secret: "x" } as NoulQuestion];
  assert.deepEqual(JSON.parse(noulBody(MODEL, "state", noul)), {
    model: MODEL,
    state: "state",
    questions: { safe: { type: "noul", instructions: "Safe?" } },
  });
});

test("single-question parsers reject answers carrying extra question ids", () => {
  const extra = { type: "noul", noul: 0.5 };
  const choice = parseChoice({ model: MODEL, answers: { route: choiceAnswer(), other: extra } }, route, MODEL);
  assert.deepEqual(choice, { ok: false, error: { kind: "question_id_mismatch" } });
  const safe: NoulQuestion = { id: "safe", question: "Safe?" };
  const noul = parseNoul({ model: MODEL, answers: { safe: { type: "noul", noul: 0.9 }, other: extra } }, safe, MODEL);
  assert.deepEqual(noul, { ok: false, error: { kind: "question_id_mismatch" } });
});

test("T105 L7: bjev 4-decimal rounding (sum 1.0001) is accepted and renormalized to 1", () => {
  const result = parseChoice(choiceResponse({ probabilities: { read: 0.7001, edit: 0.2, ask: 0.1 } }), route, MODEL);
  assert.ok(result.ok, JSON.stringify(result));
  const sum = Object.values(result.value.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, String(sum));
});

test("T105 L7: a sum of 1.02 is still rejected", () => {
  const result = parseChoice(choiceResponse({ probabilities: { read: 0.72, edit: 0.2, ask: 0.1 } }), route, MODEL);
  assert.equal(failureKind(result), "probability_sum");
});
