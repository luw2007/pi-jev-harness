// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:tests/keep-call.test.ts (MIT)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCall, resolveOptions } from "../../../vendor/fast-jev/compact.ts";

test("decideCall keeps pinned calls regardless of scores", () => {
  const decision = decideCall(
    { id: "t1", tool: "read", pinned: true },
    { keepCall: 0.01, keepResult: 0.01 },
    { keepThreshold: 0.5 },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "pinned");
});

test("decideCall keeps when score meets threshold", () => {
  const decision = decideCall(
    { id: "t1", tool: "read", pinned: false },
    { keepCall: 0.5, keepResult: 0.95 },
    { keepThreshold: 0.5 },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "kept");
});

test("decideCall drops result when keepCall meets threshold but keepResult does not", () => {
  const decision = decideCall(
    { id: "t1", tool: "read", pinned: false },
    { keepCall: 0.95, keepResult: 0.01 },
    { keepThreshold: 0.5 },
  );
  assert.equal(decision.action, "drop_result");
  assert.equal(decision.reason, "result_dropped");
});

test("resolveOptions returns defaults for empty input", () => {
  const opts = resolveOptions({});
  assert.equal(opts.keepThreshold, 0.5);
  assert.equal(opts.preserveRecentMessages, 6);
  assert.equal(opts.maxStateTokens, 25_000);
  assert.equal(opts.maxRequestTokens, 30_000);
  assert.equal(opts.truncateHeadChars, 300);
  assert.equal(opts.allowDroppingCalls, false);
});

test("resolveOptions clamps preserveRecentMessages to non-negative", () => {
  assert.equal(resolveOptions({ preserveRecentMessages: -5 }).preserveRecentMessages, 0);
  assert.equal(resolveOptions({ preserveRecentMessages: 3 }).preserveRecentMessages, 3);
});

test("resolveOptions clamps maxStateTokens to at least 1", () => {
  assert.equal(resolveOptions({ maxStateTokens: 0 }).maxStateTokens, 1);
});

test("resolveOptions clamps maxRequestTokens to at least 1", () => {
  assert.equal(resolveOptions({ maxRequestTokens: 0 }).maxRequestTokens, 1);
});