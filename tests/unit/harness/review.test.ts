import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAVORABLE,
  JEV_MODEL,
  REVIEW_CONFIDENCE_THRESHOLD,
  REVIEW_QUESTIONS,
  REVIEW_QUESTION_IDS,
  decide,
  type JevReview,
  type ReviewAnswer,
  type ReviewAnswers,
  type ValidationResult,
} from "../../../vendor/jev-harness/src/contract/index.ts";
import type { JevResult, NoulEvidence, NoulQuestion, JevCallOptions } from "../../../src/jev/index.ts";
import { createHash } from "node:crypto";
import {
  buildActionReviewPayload,
  decideActionReview,
  reviewAction,
  toReviewableAction,
  validateReviewableAction,
} from "../../../src/harness/review.ts";
import type { ActionEnvelope } from "../../../src/harness/types.ts";
import { HOST_ACTION_QUESTIONS_V1 } from "../../../src/harness/review-questions.ts";
import type {
  ActionReview,
  ActionReviewMode,
  AllowedReviewContext,
  NoulAsk,
  ReviewableAction,
} from "../../../src/harness/review-types.ts";

const EDIT_DIFF = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "",
].join("\n");
const edit: ReviewableAction = {
  actionId: "act-edit",
  toolName: "edit",
  kind: "edit",
  targetPath: "src/a.ts",
  diff: EDIT_DIFF,
  preimageDigest: "sha256:aaa",
  rationale: "Task asks b to be 3.",
};
const create: ReviewableAction = {
  actionId: "act-create",
  toolName: "write",
  kind: "create",
  targetPath: "src/new.ts",
  content: "export const x = 1;\n",
};
const overwrite: ReviewableAction = {
  actionId: "act-overwrite",
  toolName: "write",
  kind: "overwrite",
  targetPath: "src/a.ts",
  content: "const a = 1;\nconst b = 3;\n",
  preimageDigest: "sha256:aaa",
};
const PREIMAGE = "const a = 1;\nconst b = 2;\n";
const contextFor = (action: ReviewableAction): AllowedReviewContext =>
  action.kind === "create" ? { task: "Add x." } : { task: "Set b to 3.", preimage: PREIMAGE };

function favorableEvidence(questions: readonly NoulQuestion[], model = JEV_MODEL): NoulEvidence[] {
  return questions.map((q) => ({
    questionId: q.id,
    model,
    yes: FAVORABLE[q.id as keyof typeof FAVORABLE] === "yes" ? 0.95 : 0.05,
  }));
}

interface Recorder {
  ask: NoulAsk;
  calls: { questions: readonly NoulQuestion[]; options: JevCallOptions }[];
}
function recorder(
  reply: (questions: readonly NoulQuestion[], options: JevCallOptions) => Promise<JevResult<NoulEvidence[]>> | JevResult<NoulEvidence[]>,
): Recorder {
  const calls: Recorder["calls"] = [];
  return {
    calls,
    ask: async (questions, options) => {
      calls.push({ questions, options });
      return reply(questions, options);
    },
  };
}
const attempt = {
  attemptId: "att-1",
  decisionId: "d",
  startedAt: 0,
  durationMs: 1,
  status: "ok" as const,
  requestBytes: 1,
  responseBytes: 1,
};
const favorableAsk = () => recorder((questions) => ({ ok: true, evidence: favorableEvidence(questions), attempt }));

test("structurally invalid actions or context never call ask and are rejected", async () => {
  const invalid: [unknown, AllowedReviewContext][] = [
    [null, { task: "t" }],
    [{ ...create, kind: "delete" }, { task: "t" }],
    [{ ...create, targetPath: "/etc/passwd" }, { task: "t" }],
    [{ ...create, targetPath: "src/../../x" }, { task: "t" }],
    [{ ...create, preimageDigest: "sha256:x" }, { task: "t" }],
    [{ ...edit, diff: "" }, { task: "t", preimage: PREIMAGE }],
    [{ ...edit, targetPath: "src/b.ts" }, { task: "t", preimage: PREIMAGE }],
    [{ ...overwrite, preimageDigest: undefined }, { task: "t", preimage: PREIMAGE }],
    [create, { task: "" }],
    [create, { task: "t", preimage: "leak" }],
    [overwrite, { task: "t" }],
    [overwrite, { task: "t", preimage: PREIMAGE, preimageLineLimit: 0 }],
  ];
  for (const mode of ["shadow", "enforced"] as const) {
    for (const [action, allowedContext] of invalid) {
      const r = favorableAsk();
      const review = await reviewAction({ action: action as ReviewableAction, allowedContext, ask: r.ask, mode });
      assert.equal(r.calls.length, 0, JSON.stringify(action));
      assert.equal(review.status, "reject");
      assert.equal(review.validation.ok, false);
      assert.ok(review.validation.errors.length > 0);
      assert.equal(review.model, null);
      assert.equal(review.blocked === null, mode === "shadow");
    }
  }
});

test("cancelled before dispatch: zero ask calls, unavailable", async () => {
  const controller = new AbortController();
  controller.abort();
  const r = favorableAsk();
  const review = await reviewAction({ action: edit, allowedContext: contextFor(edit), ask: r.ask, mode: "shadow", signal: controller.signal });
  assert.equal(r.calls.length, 0);
  assert.equal(review.status, "unavailable");
  assert.match(review.reason, /cancelled before dispatch/);
});

test("cancelled while ask was in flight: favorable answers are discarded as unavailable", async () => {
  const controller = new AbortController();
  const r = recorder((questions) => {
    controller.abort();
    return { ok: true, evidence: favorableEvidence(questions), attempt };
  });
  const review = await reviewAction({ action: create, allowedContext: contextFor(create), ask: r.ask, mode: "enforced", signal: controller.signal });
  assert.equal(r.calls.length, 1);
  assert.equal(review.status, "unavailable");
  assert.equal(review.answers, null);
  assert.equal(review.model, null);
  assert.ok(review.blocked);
});

const failures: [string, () => Recorder][] = [
  ["ask throws", () => recorder(() => { throw Error("socket hang up"); })],
  ["ask rejects", () => recorder(() => Promise.reject(Error("boom")))],
  ["timeout result", () => recorder(() => ({ ok: false, error: { kind: "timeout" }, attempt }))],
  ["non-object result", () => recorder(() => null as unknown as JevResult<NoulEvidence[]>)],
  ["missing question", () => recorder((q) => ({ ok: true, evidence: favorableEvidence(q).slice(1), attempt }))],
  ["repeated question", () => recorder((q) => {
    const e = favorableEvidence(q);
    return { ok: true, evidence: [e[0]!, e[0]!, e[2]!, e[3]!], attempt };
  })],
  ["wrong model", () => recorder((q) => ({ ok: true, evidence: favorableEvidence(q, "jev-latest"), attempt }))],
  ["missing model", () => recorder((q) => ({ ok: true, evidence: favorableEvidence(q, undefined as unknown as string).map(({ model, ...rest }) => rest as NoulEvidence), attempt }))],
  ["probability out of range", () => recorder((q) => ({ ok: true, evidence: favorableEvidence(q).map((e) => ({ ...e, yes: 1.5 })), attempt }))],
];

test("ask failure or malformed evidence: shadow records unavailable without blocking", async () => {
  for (const [name, make] of failures) {
    const r = make();
    const review = await reviewAction({ action: edit, allowedContext: contextFor(edit), ask: r.ask, mode: "shadow" });
    assert.equal(r.calls.length, 1, name);
    assert.equal(review.status, "unavailable", name);
    assert.equal(review.blocked, null, name);
    assert.equal(review.answers, null, name);
    assert.equal(review.model, null, name);
  }
});

test("ask failure or malformed evidence: enforced is unavailable and blocked, never unreviewed", async () => {
  for (const [name, make] of failures) {
    const review = await reviewAction({ action: overwrite, allowedContext: contextFor(overwrite), ask: make().ask, mode: "enforced" });
    assert.equal(review.status, "unavailable", name);
    assert.match(review.blocked ?? "", /Enforced review unavailable.*not executed/, name);
  }
});

test("enforced blocks every conclusion but permit, proposal_only included; shadow blocks none", async () => {
  for (const mode of ["shadow", "enforced"] as const) {
    const cases: [ActionReview["status"], unknown, NoulAsk][] = [
      ["permit", edit, favorableAsk().ask],
      ["reject", { ...edit, targetPath: "../escape.ts" }, favorableAsk().ask],
      ["unavailable", edit, failures[0]![1]().ask],
      // Favorable except the first question: a proposal that may be shown but not applied.
      ["proposal_only", edit, recorder((q) => ({
        ok: true,
        evidence: favorableEvidence(q).map((e, i) => (i === 0 ? { ...e, yes: 1 - e.yes } : e)),
        attempt,
      })).ask],
    ];
    for (const [status, action, ask] of cases) {
      const review = await reviewAction({ action: action as ReviewableAction, allowedContext: contextFor(edit), ask, mode });
      assert.equal(review.status, status, `${mode} ${status}`);
      if (mode === "shadow" || status === "permit") assert.equal(review.blocked, null, `${mode} ${status}`);
      else assert.match(review.blocked ?? "", new RegExp(`^Enforced review ${status}: .*not executed\\.$`), `${mode} ${status}`);
    }
  }
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function envelope(overrides: Partial<ActionEnvelope>): ActionEnvelope {
  return {
    actionId: "act-1",
    toolCallId: "call-1",
    kind: "edit",
    toolName: "edit",
    args: null,
    requestedPaths: ["/repo/src/a.ts"],
    targets: ["/repo/src/a.ts"],
    preimage: { path: "/repo/src/a.ts", sha256: sha(PREIMAGE), bytes: PREIMAGE.length },
    change: { format: "replacements", edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }] },
    scope: { grant: { id: "grant-7", kinds: ["edit", "create", "overwrite"], maxFileBytes: 1024 }, roots: ["/repo"] },
    rationale: "Task asks b to be 3.",
    withheld: false,
    issues: [],
    ...overrides,
  };
}

test("toReviewableAction turns an envelope into a valid review action that references the grant id", async () => {
  const fromEdit = toReviewableAction(envelope({}), PREIMAGE);
  assert.deepEqual(fromEdit, {
    actionId: "act-1",
    toolName: "edit",
    kind: "edit",
    targetPath: "src/a.ts",
    rationale: "Task asks b to be 3.",
    grantId: "grant-7",
    diff: EDIT_DIFF,
    preimageDigest: sha(PREIMAGE),
  });
  const review = await reviewAction({ action: fromEdit, allowedContext: contextFor(edit), ask: favorableAsk().ask, mode: "enforced" });
  assert.equal(review.status, "permit");
  assert.ok(review.evidenceRefs.includes("grant:grant-7"));

  const content = "export const x = 1;\n";
  const fromCreate = toReviewableAction(envelope({
    kind: "create", toolName: "write", preimage: null, rationale: null, scope: { grant: null, roots: ["/repo"] },
    targets: ["/repo/src/new.ts"], args: { path: "src/new.ts", content },
    change: { format: "content", sha256: sha(content), bytes: content.length },
  }));
  assert.deepEqual(fromCreate, { actionId: "act-1", toolName: "write", kind: "create", targetPath: "src/new.ts", content });
  assert.equal(validateReviewableAction(fromCreate).ok, true);

  assert.throws(() => toReviewableAction(envelope({}), "const a = 1;\n"), /preimage text does not match/);
  assert.throws(() => toReviewableAction(envelope({ kind: "read" })), /not reviewed/);
  assert.throws(() => toReviewableAction(envelope({ targets: ["/elsewhere/a.ts"] }), PREIMAGE), /outside the allowed roots/);
  assert.throws(() => toReviewableAction(envelope({ withheld: true }), PREIMAGE), /withheld/);
});

type ForbiddenKey<K> = K extends string
  ? Lowercase<K> extends `${string}grant${string}` | `${string}authori${string}` | `${string}approv${string}` | `${string}allow${string}` | `${string}permission${string}`
    ? K
    : never
  : never;
// Compile-time: ActionReview has no grant/authorization-like key.
const noAuthorizationKeys: [ForbiddenKey<keyof ActionReview>] extends [never] ? true : false = true;

function allKeys(value: unknown, out: string[] = []): string[] {
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      allKeys(child, out);
    }
  return out;
}

test("permit carries review evidence only, no authorization field", async () => {
  assert.equal(noAuthorizationKeys, true);
  for (const mode of ["shadow", "enforced"] as ActionReviewMode[]) {
    const review = await reviewAction({ action: edit, allowedContext: contextFor(edit), ask: favorableAsk().ask, mode });
    assert.equal(review.status, "permit");
    assert.equal(review.blocked, null);
    assert.equal(review.model, JEV_MODEL);
    assert.equal(review.policyVersion, "action-review-v1");
    assert.deepEqual(review.evidenceRefs, ["action:act-edit", "preimage:sha256:aaa", "jev-attempt:att-1"]);
    assert.match(review.reason, /not authorization/);
    // @ts-expect-error ActionReview has no grant field.
    assert.equal(review.grant, undefined);
    const forbidden = allKeys(review).filter((k) => /grant|authori[sz]|approv|allow|permission/i.test(k));
    assert.deepEqual(forbidden, []);
  }
});

test("payload holds only the bounded preimage excerpt; other context never leaves", async () => {
  const total = 5000;
  const big = Array.from({ length: total }, (_, i) => `SECRET-LINE-${i + 1}`).join("\n");
  const linesIn = (payload: unknown) =>
    new Set([...JSON.stringify(payload).matchAll(/SECRET-LINE-(\d+)\b/g)].map((m) => Number(m[1])));
  const extra = { otherFiles: { "src/key.ts": "OTHER-FILE" }, history: ["HISTORY-TURN"] };

  const big_overwrite: ReviewableAction = { ...overwrite, targetPath: "src/big.txt", content: "replacement\n" };
  const r = favorableAsk();
  await reviewAction({
    action: big_overwrite,
    allowedContext: { task: "Replace.", preimage: big, preimageLineLimit: 10, ...extra } as AllowedReviewContext,
    ask: r.ask,
    mode: "shadow",
  });
  assert.equal(r.calls.length, 1);
  const sent = r.calls[0]!.options.state;
  assert.deepEqual([...linesIn(sent)], Array.from({ length: 10 }, (_, i) => i + 1));
  assert.doesNotMatch(JSON.stringify(sent), /OTHER-FILE|HISTORY-TURN/);
  const excerpt = (sent as { preimageExcerpt: { totalLines: number; truncated: boolean } }).preimageExcerpt;
  assert.equal(excerpt.totalLines, total);
  assert.equal(excerpt.truncated, true);

  const bigEdit: ReviewableAction = {
    ...edit,
    targetPath: "src/big.txt",
    diff: ["--- a/src/big.txt", "+++ b/src/big.txt", "@@ -2500,3 +2500,3 @@", " SECRET-LINE-2500", "-SECRET-LINE-2501", "+changed", " SECRET-LINE-2502", ""].join("\n"),
  };
  const payload = buildActionReviewPayload(bigEdit, { task: "Change 2501.", preimage: big, preimageLineLimit: 2, ...extra } as AllowedReviewContext);
  assert.deepEqual([...linesIn(payload)].sort((a, b) => a - b), [2500, 2501, 2502]);
  const state = payload.state as { preimageExcerpt: { segments: unknown; truncated: boolean } };
  assert.deepEqual(state.preimageExcerpt.segments, [{ startLine: 2500, text: "SECRET-LINE-2500\nSECRET-LINE-2501" }]);
  assert.equal(state.preimageExcerpt.truncated, true);
  assert.doesNotMatch(JSON.stringify(payload), /OTHER-FILE|HISTORY-TURN/);

  const createPayload = buildActionReviewPayload(create, contextFor(create));
  assert.equal("preimageExcerpt" in (createPayload.state as object), false);
});

function answer(p: number): ReviewAnswer {
  return { probability: p, answer: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p) };
}
function favorable(confidence = 0.95): ReviewAnswers {
  const out = {} as ReviewAnswers;
  for (const id of REVIEW_QUESTION_IDS) out[id] = answer(FAVORABLE[id] === "yes" ? confidence : 1 - confidence);
  return out;
}

test("H decide cases map to the same conclusion and reason", () => {
  const ok: ValidationResult = { ok: true, errors: [] };
  const bad: ValidationResult = { ok: false, errors: ["path escapes the fixture root"] };
  const hReview = (answers: ReviewAnswers | null, error?: string): JevReview | null =>
    answers === null
      ? error === undefined ? null : { model: JEV_MODEL, answers: null, error, latencyMs: 0, source: "jev" }
      : { model: JEV_MODEL, answers, error: null, latencyMs: 0, source: "jev" };
  const oneBad = REVIEW_QUESTION_IDS.map((id) => {
    const a = favorable();
    a[id] = answer(FAVORABLE[id] === "yes" ? 0.1 : 0.9);
    return a;
  });
  const lowConfidence = { ...favorable(), addresses_task: answer(0.65) };
  const nan = { ...favorable(), evidence_supports: { probability: Number.NaN, answer: "yes" as const, confidence: Number.NaN } };
  const partial = { ...favorable() } as Partial<ReviewAnswers>;
  delete partial.needs_clarification;
  const cases: { validation: typeof ok; answers: ReviewAnswers | null; error?: string; threshold?: number; expected: string }[] = [
    { validation: bad, answers: null, expected: "reject" },
    { validation: bad, answers: favorable(), expected: "reject" },
    { validation: ok, answers: null, expected: "unavailable" },
    { validation: ok, answers: null, error: "timeout after 45s", expected: "unavailable" },
    { validation: ok, answers: favorable(0.9), expected: "permit" },
    { validation: ok, answers: favorable(REVIEW_CONFIDENCE_THRESHOLD), expected: "permit" },
    ...oneBad.map((answers) => ({ validation: ok, answers, expected: "proposal_only" })),
    { validation: ok, answers: lowConfidence, expected: "proposal_only" },
    { validation: ok, answers: lowConfidence, threshold: 0.6, expected: "permit" },
    { validation: ok, answers: nan, expected: "proposal_only" },
    { validation: ok, answers: partial as ReviewAnswers, expected: "proposal_only" },
  ];
  for (const c of cases) {
    const h = decide(c.validation, hReview(c.answers, c.error), c.threshold);
    const mapped = decideActionReview(c.answers, { validation: c.validation, error: c.error, threshold: c.threshold });
    assert.equal(h.verdict, c.expected);
    assert.deepEqual(mapped, { status: h.verdict, reason: h.reason });
  }
  assert.throws(() => decideActionReview(favorable(), { threshold: 0.49 }), /between 0.5 and 1/);
});

test("create and overwrite use host-action-v1; edit uses H question set v4", async () => {
  const sent = async (action: ReviewableAction) => {
    const r = favorableAsk();
    const review = await reviewAction({ action, allowedContext: contextFor(action), ask: r.ask, mode: "shadow" });
    return { review, questions: Object.fromEntries(r.calls[0]!.questions.map((q) => [q.id, q.question])) };
  };
  const v4 = Object.fromEntries(REVIEW_QUESTION_IDS.map((id) => [id, REVIEW_QUESTIONS[id].instructions]));
  const v1 = Object.fromEntries(REVIEW_QUESTION_IDS.map((id) => [id, HOST_ACTION_QUESTIONS_V1[id].instructions]));
  assert.notDeepEqual(v1, v4);

  const e = await sent(edit);
  assert.equal(e.review.questionSetVersion, "h-proposal-v4");
  assert.deepEqual(e.questions, v4);
  for (const action of [create, overwrite]) {
    const w = await sent(action);
    assert.equal(w.review.questionSetVersion, "host-action-v1");
    assert.deepEqual(w.questions, v1);
  }
});
