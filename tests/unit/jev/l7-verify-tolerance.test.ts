/**
 * T105 L7 verification (verifier-owned): PROBABILITY_SUM_TOLERANCE 0.01 + renormalisation.
 * Tests whose name starts with "DEFECT:" reproduce defects found by the L7 verifier.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PROBABILITY_SUM_TOLERANCE, parseChoice, type ChoiceQuestion } from "../../../src/jev/index.ts";

const MODEL = "jev-1.13.0";
const q = (ids: string[]): ChoiceQuestion => ({ id: "q", question: "?", options: ids.map((id) => ({ id, description: id })) });
const parse = (probabilities: Record<string, number>, choice: string) =>
  parseChoice({ model: MODEL, answers: { q: { type: "choice", choice, confidence: 0.5, probabilities } } }, q(Object.keys(probabilities)), MODEL);
const kind = (r: { ok: boolean; error?: { kind: string } }) => (r.ok ? "ok" : r.error!.kind);
const sum = (r: ReturnType<typeof parse>) => (r.ok ? Object.values(r.value.probabilities).reduce((a, b) => a + b, 0) : NaN);

test("tolerance constant is 0.01", () => assert.equal(PROBABILITY_SUM_TOLERANCE, 0.01));

test("sums just inside [0.99, 1.01] are accepted and renormalised to exactly 1", () => {
  for (const p of [{ a: 0.6, b: 0.3901 }, { a: 0.6, b: 0.4099 }, { a: 0.5, b: 0.4999 }, { a: 0.5001, b: 0.5 }]) {
    const r = parse(p, "a");
    assert.equal(kind(r), "ok", JSON.stringify(p));
    assert.equal(sum(r), 1, JSON.stringify(p));
    assert.ok(r.ok && Object.values(r.value.probabilities).every((v) => v >= 0 && v <= 1));
  }
});

test("sums just outside [0.99, 1.01] are rejected", () => {
  for (const p of [{ a: 0.6, b: 0.3899 }, { a: 0.6, b: 0.4101 }, { a: 1, b: 0.02 }]) assert.equal(kind(parse(p, "a")), "probability_sum", JSON.stringify(p));
});

test("negative, >1, NaN probabilities rejected; all zeros rejected without dividing by zero", () => {
  assert.equal(kind(parse({ a: 1.005, b: -0.005 }, "a")), "probability_invalid");
  assert.equal(kind(parse({ a: 1.001, b: 0 }, "a")), "probability_invalid");
  assert.equal(kind(parse({ a: Number.NaN, b: 1 }, "b")), "probability_invalid");
  assert.equal(kind(parse({ a: 0, b: 0 }, "a")), "probability_sum");
});

test("renormalisation preserves a strict argmax and still rejects a non-argmax choice", () => {
  assert.equal(kind(parse({ a: 0.2, b: 0.7001, c: 0.1 }, "b")), "ok");
  assert.equal(kind(parse({ a: 0.2, b: 0.7001, c: 0.1 }, "a")), "choice_not_argmax");
  assert.equal(kind(parse({ a: 0.1, b: 0.2, c: 0.6999 }, "c")), "ok");
});

test("an exact sum of 1 is passed through unchanged", () => {
  const r = parse({ a: 0.7, b: 0.2, c: 0.1 }, "a");
  assert.ok(r.ok);
  assert.deepEqual(r.value.probabilities, { a: 0.7, b: 0.2, c: 0.1 });
});

// The last option absorbs float residue (wire.ts), so a tie between the choice and the last option
// can become a strict loss: a valid tied argmax answer is rejected.
test("DEFECT: renormalisation breaks a tie with the last option (tied argmax choice rejected as choice_not_argmax)", () => {
  assert.equal(kind(parse({ a: 0.0147, b: 0.4927, c: 0.4927 }, "b")), "ok");
});
