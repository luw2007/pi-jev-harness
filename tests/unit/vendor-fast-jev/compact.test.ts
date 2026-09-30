// Transcript fixture adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:tests/cache-identity.test.ts (MIT); the tests themselves are T023 kernel tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, batchCalls, questionsFor, applyDecisions, messageChars, reductionRatio } from "../../../vendor/fast-jev/compact.ts";
import { collectToolCalls, fitState } from "../../../vendor/fast-jev/state.ts";
import type { JevAsker, JevQuestions, JevState, Message, ToolCall } from "../../../vendor/fast-jev/types.ts";

function testAsker(noul: number): JevAsker & { calls: number; asked: string[] } {
  let calls = 0;
  const asked: string[] = [];
  return {
    get calls() { return calls; },
    get asked() { return asked; },
    async ask(_state: JevState, questions: JevQuestions) {
      calls += 1;
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const name of Object.keys(questions)) {
        asked.push(name);
        answers[name] = { type: "noul", noul };
      }
      return { answers };
    },
  };
}

function singleCallTranscript(): Message[] {
  return [
    { role: "user", text: "check deployment", toolUses: [] },
    {
      role: "assistant",
      text: "reading deploy output",
      toolUses: [
        {
          tool_use_id: "call-1",
          tool: "read",
          input: { path: "/deploy/result.txt" },
        },
      ],
    },
    {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "call-1", text: "service port 8471, status ok" }],
    },
    { role: "assistant", text: "continuing", toolUses: [] },
  ];
}

test("compact drops result when Jev says low keepResult", async () => {
  const jev = testAsker(0.05);
  const result = await compact(singleCallTranscript(), jev, {
    keepThreshold: 0.2,
    preserveRecentMessages: 0,
  });
  assert.equal(result.stats.calls, 1);
  assert.equal(result.decisions[0]!.action, "drop_result");
  assert(result.messages.length > 0);
});

test("compact keeps call when Jev says high keepResult", async () => {
  const jev = testAsker(0.95);
  const result = await compact(singleCallTranscript(), jev, {
    keepThreshold: 0.2,
    preserveRecentMessages: 0,
  });
  assert.equal(result.decisions[0]!.action, "keep");
  assert(result.messages.length > 0);
});

test("batchCalls splits calls into batches under token budget", () => {
  const messages = singleCallTranscript();
  const calls = collectToolCalls(messages, 6);
  const fitted = fitState(messages, calls, {
    maxStateTokens: 25000,
    preserveRecentMessages: 6,
    goal: "test",
  });
  const batches = batchCalls(calls, fitted.tokens, { maxRequestTokens: 30000 });
  assert(batches.length >= 1);
  const flattened = batches.flat();
  assert.equal(flattened.length, calls.length);
});

test("batchCalls throws when state leaves no room for questions", () => {
  const dummyCalls: ToolCall[] = [
    {
      id: "t1",
      tool_use_id: "u-1",
      tool: "read",
      input: {},
      callIndex: 1,
      resultIndex: 2,
      resultChars: 100,
      isError: false,
      pinned: false,
      cacheKey: "abc",
    },
  ];
  assert.throws(() => {
    // maxRequestTokens = 1 means state (0) + overhead (20) already over budget
    batchCalls(dummyCalls, 0, { maxRequestTokens: 10 });
  }, /state leaves no room/);
});

test("questionsFor produces noul questions for one call", () => {
  const call: ToolCall = {
    id: "t1",
    tool_use_id: "u-1",
    tool: "read",
    input: { path: "test.txt" },
    callIndex: 0,
    resultIndex: 1,
    resultChars: 500,
    isError: false,
    pinned: false,
    cacheKey: "abc",
  };
  const q = questionsFor(call);
  assert("call_t1" in q);
  assert("result_t1" in q);
  assert.equal(q.call_t1!.type, "noul");
  assert.equal(q.result_t1!.type, "noul");
});

test("applyDecisions truncates dropped results past the limit and keeps the call record", () => {
  // truncatedResultText only truncates when text.length > headChars + 120.
  const messages = singleCallTranscript();
  const longText = "service port 8471, status ok\n" + "log line ".repeat(100);
  messages[2] = { ...messages[2]!, toolResults: [{ tool_use_id: "call-1", text: longText }] };
  const calls = collectToolCalls(messages, 0);
  const call = calls[0]!;
  const decisions = [
    { id: call.id, tool: call.tool, keepCall: 0.01, keepResult: 0.01, action: "drop_result" as const, reason: "result_dropped" as const },
  ];
  const headChars = 300;
  assert(longText.length > headChars + 120);
  const kept = applyDecisions(messages, decisions, calls, headChars);
  const result = kept.find((m) => (m.toolResults ?? []).length > 0)!.toolResults![0]!;
  assert.equal(
    result.text,
    `${longText.slice(0, headChars)}\n[fast-jev-compaction truncated ${longText.length - headChars} chars of this tool result; re-run the tool if needed]`,
  );
  // The input message is not mutated.
  assert.equal(messages[2]!.toolResults![0]!.text, longText);
  // The call record is still visible.
  const assistantMsg = kept.find((m) => m.role === "assistant" && m.toolUses.length > 0);
  assert(assistantMsg);
  assert.equal(assistantMsg.toolUses[0]!.tool_use_id, "call-1");
});

test("applyDecisions drops call entirely when allowDroppingCalls was used", () => {
  const messages = singleCallTranscript();
  const calls = collectToolCalls(messages, 0);
  const call = calls[0]!;
  const decisions = [
    { id: call.id, tool: call.tool, keepCall: 0.01, keepResult: 0.01, action: "drop_call" as const, reason: "call_dropped" as const },
  ];
  const kept = applyDecisions(messages, decisions, calls, 300);
  const assistantMsg = kept.find((m) => m.role === "assistant");
  assert(assistantMsg);
  assert.equal(assistantMsg.toolUses.length, 0);
  // The tool result message should also be gone
  const resultMsg = kept.find(
    (m) => m.role === "user" && (m.toolResults ?? []).length > 0,
  );
  assert(!resultMsg);
});

test("messageChars counts text, tool input and tool output", () => {
  const msg: Message = {
    role: "assistant",
    text: "hello",
    toolUses: [{ tool_use_id: "u-1", tool: "read", input: { path: "file.txt" } }],
    toolResults: [{ tool_use_id: "u-1", text: "result content" }],
  };
  const count = messageChars(msg);
  assert(count > 0);
  assert(count > "hello".length);
});

test("reductionRatio returns 0 when charsBefore is 0", () => {
  const r = { stats: { charsBefore: 0 as const, charsAfter: 100 as const, messagesBefore: 0, messagesAfter: 0, calls: 0, kept: 0, resultsDropped: 0, callsDropped: 0, pinned: 0, stateTokens: 0, stateStage: "", requests: 0, unscored: 0, ms: 0 } };
  assert.equal(reductionRatio(r), 0);
});

test("reductionRatio computes correct ratio", () => {
  const r = { stats: { charsBefore: 1000 as const, charsAfter: 600 as const, messagesBefore: 0, messagesAfter: 0, calls: 0, kept: 0, resultsDropped: 0, callsDropped: 0, pinned: 0, stateTokens: 0, stateStage: "", requests: 0, unscored: 0, ms: 0 } };
  assert.equal(reductionRatio(r), 0.4);
});