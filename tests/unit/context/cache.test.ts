import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDecisionCache,
  decisionDigest,
  type CachedDecision,
  type DecisionIdentity,
  type DecisionScope,
} from "../../../src/context/cache.ts";

const identity = (overrides: Partial<DecisionIdentity> = {}): DecisionIdentity => ({
  toolCallId: "c1",
  toolName: "read",
  arguments: { path: "a.txt" },
  text: "service port 8471",
  isError: false,
  ...overrides,
});
const scope = (overrides: Partial<DecisionScope> = {}): DecisionScope => ({
  sessionId: "s1",
  branchId: "b1",
  revision: "",
  policy: "p",
  ...overrides,
});
const drop: CachedDecision = { verdict: "drop", keepResult: 0.05, replacement: "notice", handle: "spill:s1:x" };
const keep: CachedDecision = { verdict: "keep", keepResult: 0.9 };

test("same tool call id with a different result gets a different decision key", () => {
  const a = decisionDigest(identity());
  const b = decisionDigest(identity({ text: "service port 9471" }));
  assert.equal(a.length, 64);
  assert.notEqual(a, b);
});

test("digest covers tool name, arguments and error state, and is stable for equal content", () => {
  const base = decisionDigest(identity());
  assert.equal(decisionDigest(identity()), base);
  assert.notEqual(decisionDigest(identity({ toolName: "bash" })), base);
  assert.notEqual(decisionDigest(identity({ arguments: { path: "b.txt" } })), base);
  assert.notEqual(decisionDigest(identity({ isError: true })), base);
  assert.notEqual(decisionDigest(identity({ toolCallId: "c2" })), base);
});

test("decisions are scoped by session, branch, revision and policy", () => {
  const cache = createDecisionCache();
  const digest = decisionDigest(identity());
  cache.set(scope(), digest, drop);
  assert.deepEqual(cache.get(scope(), digest), drop);
  assert.equal(cache.get(scope({ sessionId: "s2" }), digest), undefined);
  assert.equal(cache.get(scope({ branchId: "b2" }), digest), undefined);
  assert.equal(cache.get(scope({ revision: "r2" }), digest), undefined);
  assert.equal(cache.get(scope({ policy: "q" }), digest), undefined);
});

test("branch switch invalidates the session's decisions only", () => {
  const cache = createDecisionCache();
  const digest = decisionDigest(identity());
  assert.equal(cache.enter("s1", "b1"), false);
  assert.equal(cache.enter("s2", "b1"), false);
  cache.set(scope(), digest, drop);
  cache.set(scope({ sessionId: "s2" }), digest, keep);
  assert.equal(cache.enter("s1", "b1"), false);
  assert.deepEqual(cache.get(scope(), digest), drop);

  assert.equal(cache.enter("s1", "b2"), true);
  assert.equal(cache.get(scope(), digest), undefined);
  assert.deepEqual(cache.get(scope({ sessionId: "s2" }), digest), keep);
  assert.equal(cache.size, 1);
});

test("size is bounded with least-recently-used eviction", () => {
  const cache = createDecisionCache({ maxEntries: 2 });
  cache.set(scope(), "d1", keep);
  cache.set(scope(), "d2", keep);
  assert.ok(cache.get(scope(), "d1"), "touch d1 so d2 is the oldest");
  cache.set(scope(), "d3", keep);
  assert.equal(cache.size, 2);
  assert.ok(cache.get(scope(), "d1"));
  assert.equal(cache.get(scope(), "d2"), undefined);
  assert.ok(cache.get(scope(), "d3"));
});

test("tracked sessions are bounded and an evicted session loses its decisions", () => {
  const cache = createDecisionCache({ maxSessions: 1 });
  cache.enter("s1", "b1");
  cache.set(scope(), "d1", keep);
  cache.enter("s2", "b1");
  assert.equal(cache.get(scope(), "d1"), undefined);
  assert.equal(cache.size, 0);
});

test("invalidate drops one branch or a whole session", () => {
  const cache = createDecisionCache();
  cache.set(scope(), "d1", keep);
  cache.set(scope({ branchId: "b2" }), "d1", keep);
  cache.set(scope({ sessionId: "s2" }), "d1", keep);
  assert.equal(cache.invalidate("s1", "b2"), 1);
  assert.ok(cache.get(scope(), "d1"));
  assert.equal(cache.invalidate("s1"), 1);
  assert.equal(cache.size, 1);
});

test("stored and returned decisions are copies", () => {
  const cache = createDecisionCache();
  const input: CachedDecision = { verdict: "keep", keepResult: 0.9 };
  cache.set(scope(), "d1", input);
  input.verdict = "drop";
  const got = cache.get(scope(), "d1") as CachedDecision;
  assert.equal(got.verdict, "keep");
  got.verdict = "drop";
  assert.equal(cache.get(scope(), "d1")?.verdict, "keep");
});
