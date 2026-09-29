// verification: edge cases for src/context/mapping.ts beyond the builder tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
  fromContextMessages,
  goalFromMessages,
  recentWindow,
  toContextMessages,
  type PiMessage,
} from "../../../src/context/mapping.ts";

type AgentMessage = ContextEvent["messages"][number];

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
const PNG = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

/** One message of every kind in the Pi 0.87.1 SDK types, with every optional field set. Typed so a SDK shape change breaks compilation. */
function everyKind(): AgentMessage[] {
  return [
    {
      role: "system",
      content: [{ type: "text", text: "You are a coding agent.", textSignature: "sig-sys" }],
      sections: { rules: "<rules>be terse</rules>", removed: null },
      toolsAdded: [],
      toolsRemoved: [],
      timestamp: 1,
    } as unknown as AgentMessage,
    { role: "user", content: "Fix the importer; keep the CSV header.", timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "Here is a screenshot." }, PNG], timestamp: 3 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig-think" },
        { type: "thinking", thinking: "", thinkingSignature: "opaque-redacted", redacted: true },
        { type: "text", text: "Looking.", textSignature: "sig-text" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.csv" }, thoughtSignature: "sig-thought", namespace: "fs" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-5",
      responseModel: "claude-sonnet-5-20260901",
      responseId: "msg_1",
      providerThinkingLevel: "high",
      usage,
      stopReason: "toolUse",
      rawStopReason: "tool_use",
      endTurn: false,
      timestamp: 4,
    } as unknown as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "a,b\n1,2" }],
      details: { lines: 2, nested: { ok: true } },
      usage,
      isError: false,
      timestamp: 5,
    } as unknown as AgentMessage,
    {
      role: "bashExecution",
      command: "ls -la",
      output: "total 0",
      exitCode: 0,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/tmp/out.txt",
      timestamp: 6,
      excludeFromContext: true,
    },
    { role: "custom", customType: "jev-note", content: [{ type: "text", text: "note" }, PNG], display: false, details: { k: [1, 2] }, timestamp: 7 },
    { role: "branchSummary", summary: "tried X", fromId: null, timestamp: 8 },
    { role: "compactionSummary", summary: "earlier work", tokensBefore: 12345, timestamp: 9 },
  ];
}

test("verify mapping: every Pi SDK message kind round-trips deep-equal and identical, input unmutated", () => {
  const messages = everyKind();
  const before = structuredClone(messages);
  const ctx = toContextMessages(messages);
  const back = fromContextMessages(ctx);
  assert.deepStrictEqual(back, before);
  assert.deepStrictEqual(messages, before);
  back.forEach((m, i) => assert.equal(m, messages[i]));
  assert.deepEqual(ctx.map((c) => c.role), ["system", "user", "user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
  assert.deepEqual(ctx.map((c) => c.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("verify mapping: text views exclude thinking and images; summaries and bash get a text view", () => {
  const ctx = toContextMessages(everyKind());
  assert.equal(ctx[0]!.text, "You are a coding agent.");
  assert.equal(ctx[2]!.text, "Here is a screenshot.");
  assert.equal(ctx[3]!.text, "Looking.");
  assert.equal(ctx[5]!.text, "$ ls -la\ntotal 0");
  assert.equal(ctx[6]!.text, "note");
  assert.equal(ctx[7]!.text, "tried X");
  assert.equal(ctx[8]!.text, "earlier work");
});

test("verify mapping: round trip survives a JSON (session file) round trip of the same messages", () => {
  const messages = JSON.parse(JSON.stringify(everyKind())) as PiMessage[];
  const copy = structuredClone(messages);
  assert.deepStrictEqual(fromContextMessages(toContextMessages(messages)), copy);
});

test("verify mapping: frozen host messages are accepted and not mutated", () => {
  const deepFreeze = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(deepFreeze);
      Object.freeze(v);
    }
    return v;
  };
  const messages = deepFreeze(everyKind()) as PiMessage[];
  assert.doesNotThrow(() => fromContextMessages(toContextMessages(messages)));
});

test("verify mapping: empty session maps to nothing, window 0, empty goal", () => {
  assert.deepEqual(toContextMessages([]), []);
  assert.deepEqual(fromContextMessages([]), []);
  assert.equal(recentWindow([]), 0);
  assert.equal(recentWindow([], 0), 0);
  assert.equal(goalFromMessages([]), "");
});

test("verify mapping: session with no user text has an empty goal", () => {
  const ctx = toContextMessages([{ role: "user", content: [PNG], timestamp: 1 } as PiMessage, { role: "custom", customType: "x", content: "not a user", display: true, timestamp: 2 } as PiMessage]);
  assert.equal(goalFromMessages(ctx), "");
});

function pairedWith(resultContent: unknown[], extra: Record<string, unknown> = {}): PiMessage[] {
  const old: PiMessage[] = [
    { role: "user", content: "go", timestamp: 1 } as PiMessage,
    { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "screenshot", arguments: {} }], api: "x", provider: "x", model: "m", usage, stopReason: "toolUse", timestamp: 2 } as PiMessage,
    { role: "toolResult", toolCallId: "c9", toolName: "screenshot", content: resultContent, isError: false, timestamp: 3, ...extra } as PiMessage,
  ];
  // Push the pair out of the default recent window (3 turns).
  for (let i = 0; i < 4; i++) old.push({ role: "assistant", content: [{ type: "text", text: `s${i}` }], api: "x", provider: "x", model: "m", usage, stopReason: "stop", timestamp: 10 + i } as PiMessage);
  return old;
}

test("verify mapping: tool result with both image and text (either order) is not reducible on either side and round-trips", () => {
  for (const content of [
    [{ type: "text", text: "captured" }, PNG],
    [PNG, { type: "text", text: "captured" }],
  ]) {
    const messages = pairedWith(content);
    const before = structuredClone(messages);
    const ctx = toContextMessages(messages);
    assert.deepStrictEqual(fromContextMessages(ctx), before);
    const r = ctx[2]!.toolResult!;
    assert.equal(r.reducible, false);
    assert.equal(r.reason, "has_image");
    assert.equal(r.text, "captured");
    assert.equal(ctx[1]!.toolCalls[0]!.reducible, false);
    assert.equal(ctx[1]!.toolCalls[0]!.reason, "has_image");
    assert.equal(ctx[1]!.toolCalls[0]!.resultIndex, 2);
  }
});

test("verify mapping: image plus an unknown block reports the stricter unknown_block", () => {
  const r = toContextMessages(pairedWith([PNG, { type: "audio", data: "x" }]))[2]!.toolResult!;
  assert.equal(r.reducible, false);
  assert.equal(r.reason, "unknown_block");
});

test("verify mapping: text block with a signature is not plain text", () => {
  const r = toContextMessages(pairedWith([{ type: "text", text: "x", textSignature: "s" }]))[2]!.toolResult!;
  assert.equal(r.reducible, false);
  assert.equal(r.reason, "not_text_only");
});

test("verify mapping: an old plain-text result with the same shape is reducible (control for the cases above)", () => {
  const ctx = toContextMessages(pairedWith([{ type: "text", text: "x" }]));
  assert.equal(ctx[2]!.toolResult!.reducible, true);
  assert.equal(ctx[1]!.toolCalls[0]!.reducible, true);
});

test("verify mapping: error with an image reports error, not has_image", () => {
  const r = toContextMessages(pairedWith([PNG], { isError: true }))[2]!.toolResult!;
  assert.equal(r.reason, "error");
  assert.equal(r.reducible, false);
});

test("verify mapping: recentTurns 0 makes every message non-recent; a negative or fractional value throws", () => {
  const ctx = toContextMessages(pairedWith([{ type: "text", text: "x" }]), { recentTurns: 0 });
  assert.ok(ctx.every((c) => !c.recent));
  assert.throws(() => toContextMessages([], { recentTurns: -1 }), RangeError);
  assert.throws(() => toContextMessages([], { recentTurns: 1.5 }), RangeError);
});

test("verify mapping: goal keeps the opening instruction and the newest follow-ups in order", () => {
  const msgs: PiMessage[] = ["first", "second", "third", "fourth"].map((t, i) => ({ role: "user", content: t, timestamp: i }) as PiMessage);
  assert.equal(goalFromMessages(toContextMessages(msgs)), "first\nthird\nfourth");
  assert.equal(goalFromMessages(toContextMessages(msgs), { maxFollowUps: 0 }), "first");
});
