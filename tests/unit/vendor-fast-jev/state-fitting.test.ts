// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:tests/oversized-history.test.ts (MIT)
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectToolCalls, fitState, estimateTokens } from "../../../vendor/fast-jev/state.ts";
import type { Message } from "../../../vendor/fast-jev/types.ts";

const LIMIT = 25_000;

/**
 * A history whose Jev state cannot fit at 25k tokens: every stage of shrinking
 * still leaves one line per call, so enough calls overflow the budget.
 */
function oversized(turns: number): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", text: `step ${turn}: ${"reason ".repeat(20)}`, toolUses: [] });
    messages.push({
      role: "assistant",
      text: `calling read for step ${turn}`,
      toolUses: [
        {
          tool_use_id: `u-${turn}`,
          tool: "read",
          input: { path: `/repo/module-${turn}/${"segment/".repeat(40)}file.ts` },
        },
      ],
    });
    messages.push({
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: `u-${turn}`, text: `contents ${turn}: ${"payload ".repeat(100)}` }],
    });
  }
  return messages;
}

function smallTranscript(): Message[] {
  return [
    { role: "user", text: "begin", toolUses: [] },
    {
      role: "assistant",
      text: "reading",
      toolUses: [{ tool_use_id: "u-1", tool: "read", input: { path: "config.json" } }],
    },
    {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "u-1", text: '{"port": 8471}' }],
    },
    { role: "assistant", text: "done", toolUses: [] },
  ];
}

test("estimateTokens counts simple text", () => {
  // "hello" → one 5-letter word → 1 + floor((5-1)/6) = 1
  assert.equal(estimateTokens("hello"), 1);
  // "abcdefgh" → one 8-letter word → 1 + floor(7/6) = 2
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("estimateTokens handles digits", () => {
  // "1234" → each digit 0.5 tokens → ceil(2) = 2
  assert.equal(estimateTokens("1234"), 2);
});

test("estimateTokens handles mixed content", () => {
  // TOKEN_PIECES matches letters, digits, or non-whitespace non-alnum chars.
  // Spaces are skipped entirely, leaving only "hello"(1) + "1234"(2) + "world"(1) = 4
  const result = estimateTokens("hello 1234 world");
  assert.equal(result, 4);
});

test("collectToolCalls pairs tool uses with their results", () => {
  const messages = smallTranscript();
  const calls = collectToolCalls(messages, 6);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, "read");
  assert.equal(calls[0]!.id, "t1");
  assert.equal(calls[0]!.pinned, true); // only message in range, pinned
  assert.equal(calls[0]!.resultChars, '{"port": 8471}'.length);
});

test("collectToolCalls skips calls without results", () => {
  const messages: Message[] = [
    { role: "user", text: "do it", toolUses: [] },
    {
      role: "assistant",
      text: "thinking",
      toolUses: [{ tool_use_id: "u-1", tool: "read", input: { path: "x" } }],
    },
    // No toolResult for u-1
    { role: "assistant", text: "done", toolUses: [] },
  ];
  const calls = collectToolCalls(messages, 6);
  assert.equal(calls.length, 0);
});

test("fitState fits a small transcript without shrinking", () => {
  const messages = smallTranscript();
  const calls = collectToolCalls(messages, 6);
  const fitted = fitState(messages, calls, {
    maxStateTokens: LIMIT,
    preserveRecentMessages: 6,
    goal: "check config",
  });
  assert.equal(fitted.stage, "full");
  assert(fitted.tokens <= LIMIT);
  assert.equal(fitted.representedCalls.size, calls.length);
});

test("fitState throws when even the envelope exceeds the limit", () => {
  const messages = smallTranscript();
  const calls = collectToolCalls(messages, 6);
  assert.throws(
    () => fitState(messages, calls, { maxStateTokens: 0, preserveRecentMessages: 0, goal: "x" }),
    /envelope alone/,
  );
});

test("collectToolCalls marks calls by message position", () => {
  const messages = oversized(10);
  const calls = collectToolCalls(messages, 3);
  // First call at assistant message index 1, not pinned (not index 0, not within last 3)
  assert.equal(calls[0]!.pinned, false);
  // Last call at index 28, pinned by preserveRecentMessages=3 (index >= 27)
  assert.equal(calls.at(-1)!.pinned, true);
});