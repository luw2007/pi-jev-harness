// Adapted from jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:src/routing/route.ts (MIT)
// Adapted from jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:src/contract/review.ts (MIT)
/**
 * Jev wire format: whitelisted request bodies and strict response parsing.
 * Parsers never clamp, normalize or fill values; anything off-contract is a typed error.
 * Pure: no environment, filesystem, network or clock access.
 */
import type {
  ChoiceEvidence,
  ChoiceQuestion,
  JevState,
  NoulEvidence,
  NoulQuestion,
  IdentityPolicy,
  WireErrorKind,
  WireResult,
} from "./types.ts";

/** Legacy plugin tolerance: providers round to 4 decimals (bjev sums 0.9999 / 1.0001). Accepted sums are renormalized to 1. */
export const PROBABILITY_SUM_TOLERANCE = 0.01;

type Data = Record<string, unknown>;
const record = (value: unknown): Data | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
const unit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;
const fail = <T>(kind: WireErrorKind, questionId?: string): WireResult<T> => ({
  ok: false,
  error: questionId === undefined ? { kind } : { kind, questionId },
});

/** Non-empty unique question ids, non-empty text, at least two unique options each. */
export function validChoiceQuestions(questions: readonly ChoiceQuestion[]): boolean {
  return (
    Array.isArray(questions) &&
    questions.length > 0 &&
    unique(questions.map((q) => q.id)) &&
    questions.every(
      (q) =>
        nonEmpty(q.id) &&
        nonEmpty(q.question) &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        unique(q.options.map((o: ChoiceQuestion["options"][number]) => o.id)) &&
        q.options.every((o: ChoiceQuestion["options"][number]) => nonEmpty(o.id) && typeof o.description === "string"),
    )
  );
}

export function validNoulQuestions(questions: readonly NoulQuestion[]): boolean {
  return (
    Array.isArray(questions) &&
    questions.length > 0 &&
    unique(questions.map((q) => q.id)) &&
    questions.every((q) => nonEmpty(q.id) && nonEmpty(q.question))
  );
}

/** Serializes only model, state and the whitelisted question fields. */
export function choiceBody(model: string, state: JevState, questions: readonly ChoiceQuestion[]): string {
  return JSON.stringify({
    model,
    state,
    questions: Object.fromEntries(
      questions.map((q) => [
        q.id,
        {
          type: "choice",
          instructions: q.question,
          criteria: Object.fromEntries(q.options.map((o) => [o.id, o.description])),
        },
      ]),
    ),
  });
}

export function noulBody(model: string, state: JevState, questions: readonly NoulQuestion[]): string {
  return JSON.stringify({
    model,
    state,
    questions: Object.fromEntries(questions.map((q) => [q.id, { type: "noul", instructions: q.question }])),
  });
}

/** True when the reported model satisfies `policy` for `expected`. `none` accepts any model. */
export function modelMatches(reported: string, expected: string, policy: IdentityPolicy): boolean {
  if (policy === "none") return true;
  return policy === "prefix" ? reported.startsWith(expected) : reported === expected;
}

/** Model identity and the answer for `questionId`, or the first structural failure. */
function answerFor(
  raw: unknown,
  questionId: string,
  expectedModel: string,
  type: string,
  only: boolean,
  identity: IdentityPolicy,
): WireResult<Data & { model: string }> {
  const response = record(raw);
  if (!response) return fail("not_object");
  if (identity !== "none" && !nonEmpty(response.model)) return fail("model_missing");
  const model = nonEmpty(response.model) ? response.model : "";
  if (!modelMatches(model, expectedModel, identity)) return fail("model_mismatch");
  const answers = record(response.answers);
  if (!answers) return fail("answers_missing");
  if (!Object.hasOwn(answers, questionId)) return fail("question_id_mismatch", questionId);
  if (only && Object.keys(answers).length !== 1) return fail("question_id_mismatch");
  const answer = record(answers[questionId]);
  if (!answer || answer.type !== type) return fail("answer_type", questionId);
  return { ok: true, value: { ...answer, model } };
}

/** Single-question parse: `answers` must contain exactly `question.id`. */
export function parseChoice(raw: unknown, question: ChoiceQuestion, expectedModel: string): WireResult<ChoiceEvidence> {
  return choiceAnswer(raw, question, expectedModel, true);
}

function choiceAnswer(
  raw: unknown,
  question: ChoiceQuestion,
  expectedModel: string,
  only: boolean,
  identity: IdentityPolicy = "exact",
): WireResult<ChoiceEvidence> {
  const id = question.id;
  const found = answerFor(raw, id, expectedModel, "choice", only, identity);
  if (!found.ok) return found;
  const answer = found.value;
  const ids = question.options.map((o) => o.id);
  if (typeof answer.choice !== "string" || !ids.includes(answer.choice)) return fail("choice_not_in_set", id);
  if (!unit(answer.confidence)) return fail("confidence_invalid", id);
  const scores = record(answer.probabilities);
  if (!scores) return fail("distribution_missing", id);
  if (ids.some((option) => !Object.hasOwn(scores, option))) return fail("distribution_missing_option", id);
  if (Object.keys(scores).some((key) => !ids.includes(key))) return fail("distribution_extra_option", id);
  if (ids.some((option) => !unit(scores[option]))) return fail("probability_invalid", id);
  const given = ids.map((option) => scores[option] as number);
  const total = given.reduce((sum, p) => sum + p, 0);
  if (!(Math.abs(total - 1) <= PROBABILITY_SUM_TOLERANCE)) return fail("probability_sum", id);
  // Argmax on the reported values (ties allowed), then renormalize by plain division.
  if (given[ids.indexOf(answer.choice)] !== Math.max(...given)) return fail("choice_not_argmax", id);
  const scaled = Math.abs(total - 1) <= 1e-9 ? given : given.map((p) => p / total);
  const probabilities = Object.fromEntries(ids.map((option, i) => [option, scaled[i]!]));
  return {
    ok: true,
    value: { questionId: id, model: answer.model, choice: answer.choice, confidence: answer.confidence, probabilities },
  };
}

/** Single-question parse: `answers` must contain exactly `question.id`. */
export function parseNoul(raw: unknown, question: NoulQuestion, expectedModel: string): WireResult<NoulEvidence> {
  return noulAnswer(raw, question, expectedModel, true);
}

function noulAnswer(
  raw: unknown,
  question: NoulQuestion,
  expectedModel: string,
  only: boolean,
  identity: IdentityPolicy = "exact",
): WireResult<NoulEvidence> {
  const found = answerFor(raw, question.id, expectedModel, "noul", only, identity);
  if (!found.ok) return found;
  const yes = found.value.noul;
  if (!unit(yes)) return fail("noul_invalid", question.id);
  return { ok: true, value: { questionId: question.id, model: found.value.model, yes } };
}

/** The response must answer exactly the asked question ids; each answer is parsed with `parse`. */
function parseAll<Q extends { id: string }, E>(
  raw: unknown,
  questions: readonly Q[],
  expectedModel: string,
  parse: (raw: unknown, question: Q, expectedModel: string, only: boolean, identity: IdentityPolicy) => WireResult<E>,
  identity: IdentityPolicy,
): WireResult<E[]> {
  const evidence: E[] = [];
  for (const question of questions) {
    const parsed = parse(raw, question, expectedModel, false, identity);
    if (!parsed.ok) return parsed;
    evidence.push(parsed.value);
  }
  const answers = record(record(raw)?.answers);
  if (!answers) return fail("answers_missing");
  const asked = questions.map((q) => q.id);
  if (Object.keys(answers).some((key) => !asked.includes(key))) return fail("question_id_mismatch");
  return { ok: true, value: evidence };
}

export function parseChoiceResponse(
  raw: unknown,
  questions: readonly ChoiceQuestion[],
  expectedModel: string,
  identity: IdentityPolicy = "exact",
) {
  return parseAll(raw, questions, expectedModel, choiceAnswer, identity);
}

export function parseNoulResponse(
  raw: unknown,
  questions: readonly NoulQuestion[],
  expectedModel: string,
  identity: IdentityPolicy = "exact",
) {
  return parseAll(raw, questions, expectedModel, noulAnswer, identity);
}
