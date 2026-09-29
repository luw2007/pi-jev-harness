// Verifier edge cases for the vendored fast-jev kernel. Offline only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecisions, compact } from "../../../vendor/fast-jev/compact.ts";
import { collectToolCalls } from "../../../vendor/fast-jev/state.ts";
import { buildJevRequest, noulAnswer, parseJevResponse } from "../../../vendor/fast-jev/request.ts";
import type { CallDecision, JevAsker, JevCacheKeys, JevQuestions, JevState, Message } from "../../../vendor/fast-jev/types.ts";

function transcript(resultText: string, isError = false): Message[] {
  return [
    { role: "user", text: "goal", toolUses: [] },
    { role: "assistant", text: "run", toolUses: [{ tool_use_id: "u-1", tool: "bash", input: { cmd: "ls" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "u-1", text: resultText, isError }] },
    { role: "assistant", text: "done", toolUses: [] },
  ];
}

function drop(messages: Message[], action: CallDecision["action"]): CallDecision[] {
  const [call] = collectToolCalls(messages, 0);
  return [{ id: call!.id, tool: call!.tool, keepCall: 0, keepResult: 0, action, reason: action === "drop_call" ? "call_dropped" : "result_dropped" }];
}

test("applyDecisions truncates a long dropped result to head + note, keeping the call", () => {
  const messages = transcript("x".repeat(1000));
  const out = applyDecisions(messages, drop(messages, "drop_result"), collectToolCalls(messages, 0), 50);
  const result = out.find((m) => (m.toolResults ?? []).length > 0)!.toolResults![0]!;
  assert.ok(result.text.startsWith("x".repeat(50) + "\n"));
  assert.match(result.text, /truncated 950 chars of this tool result; re-run the tool if needed/);
  assert.ok(out.find((m) => m.role === "assistant" && m.toolUses.length === 1));
});

test("applyDecisions marks truncated error results and keeps isError", () => {
  const messages = transcript("e".repeat(1000), true);
  const out = applyDecisions(messages, drop(messages, "drop_result"), collectToolCalls(messages, 0), 10);
  const result = out.find((m) => (m.toolResults ?? []).length > 0)!.toolResults![0]!;
  assert.match(result.text, /\(error\); re-run/);
  assert.equal(result.isError, true);
});

test("applyDecisions leaves short dropped results and untouched messages as identical objects", () => {
  const messages = transcript("short");
  const out = applyDecisions(messages, drop(messages, "drop_result"), collectToolCalls(messages, 0), 300);
  assert.equal(out.length, messages.length);
  out.forEach((m, i) => assert.equal(m, messages[i]));
});

test("collectToolCalls cacheKey changes with same-length result text and error flag, stable otherwise", () => {
  const key = (msgs: Message[]) => collectToolCalls(msgs, 0)[0]!.cacheKey;
  assert.equal(key(transcript("abc")), key(transcript("abc")));
  assert.notEqual(key(transcript("abc")), key(transcript("abd")));
  assert.notEqual(key(transcript("abc")), key(transcript("abc", true)));
});

test("compact does not ask Jev when every call is pinned", async () => {
  let asked = 0;
  const asker: JevAsker = { async ask() { asked += 1; return { answers: {} }; } };
  const result = await compact(transcript("x".repeat(1000)), asker, { preserveRecentMessages: 10 });
  assert.equal(asked, 0);
  assert.equal(result.stats.pinned, 1);
  assert.equal(result.decisions[0]!.action, "keep");
});

test("compact passes per-question cache keys and propagates Jev failures", async () => {
  let seen: JevCacheKeys | undefined;
  const ok: JevAsker = {
    async ask(_s: JevState, q: JevQuestions, keys?: JevCacheKeys) {
      seen = keys;
      return { answers: Object.fromEntries(Object.keys(q).map((n) => [n, { type: "noul" as const, noul: 1 }])) };
    },
  };
  const messages = transcript("x".repeat(1000));
  await compact(messages, ok, { preserveRecentMessages: 0 });
  const cacheKey = collectToolCalls(messages, 0)[0]!.cacheKey;
  assert.deepEqual(seen, { call_t1: `${cacheKey}:call`, result_t1: `${cacheKey}:result` });

  const failing: JevAsker = { async ask() { throw new Error("jev down"); } };
  await assert.rejects(compact(messages, failing, { preserveRecentMessages: 0 }), /jev down/);
  const missing: JevAsker = { async ask() { return { answers: {} }; } };
  await assert.rejects(compact(messages, missing, { preserveRecentMessages: 0 }), /Invalid Jev answer for call_t1/);
});

test("request helpers: build, parse and noul validation", () => {
  const req = buildJevRequest({ apiKey: "k" }, { goal: "g" } as unknown as JevState, {});
  assert.equal(req.method, "POST");
  assert.equal(req.headers.authorization, "Bearer k");
  assert.equal(JSON.parse(req.body).model, "jev-latest");
  assert.throws(() => parseJevResponse(500, false, "boom"), /Jev request failed \(500\): boom/);
  assert.throws(() => parseJevResponse(200, true, "{"), /malformed JSON/);
  assert.throws(() => parseJevResponse(200, true, '{"answers":null}'), /missing answers/);
  assert.deepEqual(parseJevResponse(200, true, '{"answers":{}}'), { answers: {} });
  assert.equal(noulAnswer({ a: { type: "noul", noul: 0.3 } }, "a"), 0.3);
  assert.throws(() => noulAnswer({ a: { type: "noul", noul: Number.NaN } }, "a"), /Invalid Jev answer for a/);
});
