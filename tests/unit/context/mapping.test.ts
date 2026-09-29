import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
  fromContextMessages,
  goalFromMessages,
  recentWindow,
  toContextMessages,
  type ContextMessage,
  type PiMessage,
} from "../../../src/context/mapping.ts";

// Compile-time: every Pi AgentMessage is accepted without casts.
const _hostCompat: (messages: ContextEvent["messages"]) => ContextMessage[] = (messages) => toContextMessages(messages);
void _hostCompat;

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const PNG = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

const user = (content: unknown, timestamp = 1): PiMessage => ({ role: "user", content, timestamp }) as PiMessage;
const assistant = (content: unknown[], extra: Record<string, unknown> = {}): PiMessage =>
  ({
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
    ...extra,
  }) as PiMessage;
const call = (id: string, name = "bash", args: Record<string, unknown> = { command: "ls" }) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const result = (toolCallId: string, content: unknown[], extra: Record<string, unknown> = {}): PiMessage =>
  ({ role: "toolResult", toolCallId, toolName: "bash", content, isError: false, timestamp: 3, ...extra }) as PiMessage;
const text = (value: string) => ({ type: "text", text: value });

/** Old paired call/result followed by enough turns to push it out of the recent window. */
function padTurns(count: number): PiMessage[] {
  const out: PiMessage[] = [];
  for (let i = 0; i < count; i++) out.push(assistant([text(`step ${i}`)], { stopReason: "stop" }));
  return out;
}

function assertLossless(messages: PiMessage[]): ContextMessage[] {
  const before = structuredClone(messages);
  const ctx = toContextMessages(messages);
  const back = fromContextMessages(ctx);
  assert.deepStrictEqual(back, before);
  assert.deepStrictEqual(messages, before, "input must not be mutated");
  back.forEach((message, i) => assert.equal(message, messages[i], "original objects are returned"));
  return ctx;
}

test("mixed image and text messages round-trip deep-equal", () => {
  const messages = [
    user([text("fix the chart"), PNG, text("see screenshot")]),
    assistant([call("c1", "read", { path: "a.png" })]),
    result("c1", [text("rendered"), PNG]),
    ...padTurns(3),
  ];
  const ctx = assertLossless(messages);
  assert.equal(ctx[0]?.text, "fix the chart\nsee screenshot");
  assert.equal(ctx[2]?.toolResult?.reducible, false);
  assert.equal(ctx[2]?.toolResult?.reason, "has_image");
  assert.equal(ctx[1]?.toolCalls[0]?.reason, "has_image");
});

test("unknown blocks and unknown roles pass through unchanged and block reduction", () => {
  const weird = { type: "provider_blob", payload: { nested: [1, 2, 3] }, opaque: "x" };
  const messages = [
    user("start"),
    assistant([text("thinking aloud"), weird, call("c1")]),
    result("c1", [text("ok"), weird]),
    { role: "myExtensionRole", data: { a: 1 }, timestamp: 4 } as PiMessage,
    ...padTurns(3),
  ];
  const ctx = assertLossless(messages);
  assert.equal(ctx[1]?.text, "thinking aloud");
  assert.equal(ctx[2]?.toolResult?.reason, "unknown_block");
  assert.equal(ctx[2]?.toolResult?.reducible, false);
  assert.equal(ctx[3]?.role, "myExtensionRole");
  assert.equal(ctx[3]?.text, "");
  assert.deepEqual(ctx[3]?.toolCalls, []);
});

test("toolCall without result is not reducible", () => {
  const messages = [user("go"), assistant([call("orphan-call")]), ...padTurns(4)];
  const ctx = assertLossless(messages);
  const orphan = ctx[1]?.toolCalls[0];
  assert.equal(orphan?.reducible, false);
  assert.equal(orphan?.reason, "unpaired_call");
  assert.equal(orphan?.resultIndex, undefined);
});

test("toolResult without toolCall is not reducible", () => {
  const messages = [user("go"), result("orphan-result", [text("stray")]), ...padTurns(4)];
  const ctx = assertLossless(messages);
  assert.equal(ctx[1]?.toolResult?.reducible, false);
  assert.equal(ctx[1]?.toolResult?.reason, "unpaired_result");
  assert.equal(ctx[1]?.toolResult?.callIndex, undefined);
});

test("toolResult that precedes its toolCall is unpaired", () => {
  const messages = [user("go"), result("c1", [text("early")]), assistant([call("c1")]), ...padTurns(4)];
  const ctx = toContextMessages(messages);
  assert.equal(ctx[1]?.toolResult?.reason, "unpaired_result");
  assert.equal(ctx[2]?.toolCalls[0]?.reason, "unpaired_call");
});

test("duplicate tool call ids are not reducible on either side", () => {
  const messages = [
    user("go"),
    assistant([call("dup")]),
    result("dup", [text("one")]),
    assistant([call("dup")]),
    result("dup", [text("two")]),
    ...padTurns(4),
  ];
  const ctx = toContextMessages(messages);
  for (const i of [2, 4]) assert.equal(ctx[i]?.toolResult?.reason, "duplicate_id");
  for (const i of [1, 3]) assert.equal(ctx[i]?.toolCalls[0]?.reason, "duplicate_id");
});

test("error results are not reducible", () => {
  const messages = [user("go"), assistant([call("c1")]), result("c1", [text("boom")], { isError: true }), ...padTurns(4)];
  const ctx = assertLossless(messages);
  assert.equal(ctx[2]?.toolResult?.isError, true);
  assert.equal(ctx[2]?.toolResult?.reducible, false);
  assert.equal(ctx[2]?.toolResult?.reason, "error");
});

test("only old, paired, plain-text results are reducible", () => {
  const messages = [
    user("go"),
    assistant([call("old"), call("sig")]),
    result("old", [text("line 1"), text("line 2")], { details: { exitCode: 0 } }),
    result("sig", [{ type: "text", text: "signed", textSignature: "opaque" }]),
    ...padTurns(2),
    assistant([call("new")]),
    result("new", [text("fresh")]),
  ];
  const ctx = assertLossless(messages);
  const old = ctx[2]?.toolResult;
  assert.equal(old?.reducible, true);
  assert.equal(old?.reason, "text_only");
  assert.equal(old?.text, "line 1\nline 2");
  assert.equal(old?.callIndex, 1);
  assert.deepEqual(
    ctx[1]?.toolCalls.map((c) => [c.id, c.resultIndex, c.reducible, c.reason]),
    [
      ["old", 2, true, "text_only"],
      ["sig", 3, false, "not_text_only"],
    ],
  );
  assert.equal(ctx[7]?.toolResult?.reason, "recent");
  assert.equal(ctx[7]?.toolResult?.reducible, false);
  assert.equal(ctx[7]?.recent, true);
  assert.equal(ctx[2]?.recent, false);
});

test("thinking blocks and provider metadata survive the round trip", () => {
  const messages = [
    user("go"),
    assistant(
      [
        { type: "thinking", thinking: "plan first", thinkingSignature: "sig-abc" },
        { type: "thinking", thinking: "", thinkingSignature: "enc-xyz", redacted: true },
        { type: "text", text: "answer", textSignature: "tsig" },
        { ...call("c1"), thoughtSignature: "thought-1", namespace: "ns" },
      ],
      {
        responseModel: "claude-sonnet-5-20260901",
        responseId: "resp_1",
        providerThinkingLevel: "high",
        diagnostics: [{ kind: "note", message: "x" }],
        rawStopReason: "tool_use",
        endTurn: false,
      },
    ),
    result("c1", [text("done")], { usage, details: { truncated: false } }),
    ...padTurns(3),
  ];
  const ctx = assertLossless(messages);
  assert.equal(ctx[1]?.text, "answer", "thinking is excluded from the scoring text");
  assert.deepEqual(ctx[1]?.toolCalls[0]?.arguments, { command: "ls" });
  assert.equal(ctx[2]?.toolResult?.reducible, true);
});

test("goal keeps the session-opening instruction across windows", () => {
  const messages: PiMessage[] = [user("Build the importer; never touch prod data.")];
  for (let i = 0; i < 20; i++) {
    messages.push(assistant([call(`c${i}`)]), result(`c${i}`, [text(`out ${i}`)]));
    if (i % 5 === 4) messages.push(user(`follow-up ${i}`));
  }
  const ctx = toContextMessages(messages);
  const window = ctx.slice(30);
  assert.ok(window.every((m) => m.index >= 30), "window keeps global indexes");
  assert.ok(!window.some((m) => m.text.includes("never touch prod")));

  const goal = goalFromMessages(ctx);
  assert.equal(goal, "Build the importer; never touch prod data.\nfollow-up 14\nfollow-up 19");
  assert.ok(!goalFromMessages(window).includes("never touch prod"), "a window alone would lose the goal");
});

test("goal ignores blank users and truncates long instructions", () => {
  const ctx = toContextMessages([user([PNG]), user("   "), user("x".repeat(600)), user("second")]);
  assert.equal(goalFromMessages(ctx, { maxFollowUps: 0 }), `${"x".repeat(499)}…`);
  assert.equal(goalFromMessages(ctx, { maxChars: 6 }), "xxxxx…\nsecond");
  assert.equal(goalFromMessages([]), "");
});

test("recentWindow counts assistant turns over the whole session", () => {
  const messages = [user("go"), ...padTurns(5)];
  assert.equal(recentWindow(messages, 3), 3);
  assert.equal(recentWindow(messages, 0), messages.length);
  assert.equal(recentWindow(messages, 10), 0);
  assert.throws(() => recentWindow(messages, -1), RangeError);
  assert.throws(() => toContextMessages(messages, { recentTurns: 1.5 }), RangeError);

  const ctx = toContextMessages(messages, { recentTurns: 2 });
  assert.deepEqual(
    ctx.map((m) => m.recent),
    [false, false, false, false, true, true],
  );
});

test("malformed tool results are kept but never reducible", () => {
  const messages = [
    user("go"),
    assistant([call("c1"), call("c2")]),
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "not-an-array", isError: false, timestamp: 3 } as PiMessage,
    { role: "toolResult", toolName: "bash", content: [text("no id")], isError: false, timestamp: 3 } as PiMessage,
    ...padTurns(4),
  ];
  const ctx = assertLossless(messages);
  assert.equal(ctx[2]?.toolResult?.reason, "malformed");
  assert.equal(ctx[3]?.toolResult?.reason, "malformed");
  assert.equal(ctx[1]?.toolCalls[1]?.reason, "unpaired_call");
});

test("non-core Pi roles get a text view and stay intact", () => {
  const messages = [
    { role: "compactionSummary", summary: "earlier work", tokensBefore: 100, timestamp: 1 } as PiMessage,
    { role: "branchSummary", summary: "branch A", fromId: null, timestamp: 1 } as PiMessage,
    { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } as PiMessage,
    { role: "custom", customType: "note", content: [text("hi"), PNG], display: true, timestamp: 1 } as PiMessage,
    { role: "system", content: "sys", sections: { a: "b" }, timestamp: 1 } as PiMessage,
  ];
  const ctx = assertLossless(messages);
  assert.deepEqual(
    ctx.map((m) => m.text),
    ["earlier work", "branch A", "$ ls\na\nb", "hi", "sys"],
  );
  assert.ok(ctx.every((m) => m.toolResult === undefined && m.toolCalls.length === 0));
});
