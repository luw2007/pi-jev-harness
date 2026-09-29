import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecisionCache } from "../../../src/context/cache.ts";
import type { PiMessage } from "../../../src/context/mapping.ts";
import { RECALL_TOOL_NAME } from "../../../src/context/recall.ts";
import {
  createContextReducer,
  type ContextAsk,
  type ContextAskRequest,
  type ContextLimits,
  type ContextReduceEvent,
  type ContextReducerDeps,
  type ReduceInput,
} from "../../../src/context/reducer.ts";
import { formatHandle, isSpillNotice, spillNotice, type StoreResult } from "../../../src/context/spill.ts";
import type { JevResult, NoulEvidence } from "../../../src/jev/types.ts";

// ---- fixtures ---------------------------------------------------------------------------------

const PNG = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const user = (content: unknown): PiMessage => ({ role: "user", content, timestamp: 1 }) as PiMessage;
const assistant = (content: unknown[]): PiMessage =>
  ({ role: "assistant", content, provider: "anthropic", model: "claude-sonnet-5", stopReason: "toolUse", timestamp: 2 }) as PiMessage;
const say = (text: string): PiMessage => assistant([{ type: "text", text }]);
const call = (id: string, name = "read") => ({ type: "toolCall", id, name, arguments: { path: `${id}.txt` } });
const result = (id: string, content: unknown[], extra: Record<string, unknown> = {}): PiMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 3, ...extra }) as PiMessage;
const textResult = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  result(id, [{ type: "text", text }], extra);
const payload = (id: string, size = 5_000) => `${id}:` + "D".repeat(size);
const turn = (id: string, size = 5_000): PiMessage[] => [
  assistant([{ type: "text", text: `step ${id}` }, call(id)]),
  textResult(id, payload(id, size)),
];
/** `turns` old tool turns, then one closing assistant message (recentTurns 1 covers only it). */
const session = (turns: number, size = 5_000): PiMessage[] => [
  user("fix the failing parsePort test"),
  ...Array.from({ length: turns }, (_, i) => turn(`c${i}`, size)).flat(),
  say("done"),
];

type FakeAsk = ContextAsk & { requests: ContextAskRequest[] };
function fakeAsk(yes = 0.01, overrides: Record<string, number> = {}): FakeAsk {
  const requests: ContextAskRequest[] = [];
  const ask = (async (request: ContextAskRequest): Promise<JevResult<NoulEvidence[]>> => {
    requests.push(request);
    return {
      ok: true,
      evidence: request.questions.map((q) => ({ questionId: q.id, model: "jev-1.13.0", yes: overrides[q.id] ?? yes })),
      attempt: {
        attemptId: "att",
        decisionId: "dec",
        startedAt: 0,
        durationMs: 1,
        status: "ok",
        requestBytes: 1,
        responseBytes: 1,
      },
    };
  }) as FakeAsk;
  ask.requests = requests;
  return ask;
}

type FakeStore = ContextReducerDeps["store"] & { contents: string[]; fail?: StoreResult };
function fakeStore(): FakeStore {
  const contents: string[] = [];
  const store = (async (content: string, sessionId: string): Promise<StoreResult> => {
    contents.push(content);
    if (store.fail) return store.fail;
    const digest = (contents.indexOf(content) + 1).toString(16).padStart(64, "0");
    return { ok: true, handle: formatHandle(sessionId, digest), bytes: content.length };
  }) as FakeStore;
  store.contents = contents;
  return store;
}

function setup(options: { ask?: FakeAsk; limits?: ContextLimits; events?: ContextReduceEvent[] } = {}) {
  const ask = options.ask ?? fakeAsk();
  const store = fakeStore();
  const events = options.events ?? [];
  const reducer = createContextReducer({
    ask,
    store,
    clock: () => 1_000,
    limits: { recentTurns: 1, ...options.limits },
    telemetry: (event) => events.push(event),
  });
  let generation = 0;
  const run = (messages: readonly PiMessage[], extra: Partial<ReduceInput> = {}) =>
    reducer.reduce({ messages, sessionId: "s1", branchId: "b1", generation: ++generation, ...extra });
  return { ask, store, reducer, run, events };
}

const textOf = (message: PiMessage | undefined): string =>
  ((message as unknown as { content: { text: string }[] }).content[0] as { text: string }).text;
const asked = (ask: FakeAsk): string[] => ask.requests.flatMap((r) => r.questions.map((q) => q.id));

// ---- behaviour --------------------------------------------------------------------------------

test("a stale text result is replaced by a spill notice; every other object is passed through", async () => {
  const { run, store } = setup();
  const input = session(2);
  const out = await run(input);

  assert.equal(out.changed, true);
  assert.equal(out.reason, "reduced");
  assert.equal(out.messages.length, input.length);
  assert.equal(out.stats.spilled, 2);
  for (const index of [2, 4]) {
    assert.ok(isSpillNotice(textOf(out.messages[index])));
    assert.notEqual(out.messages[index], input[index]);
    assert.equal((out.messages[index] as unknown as { toolCallId: string }).toolCallId, (input[index] as unknown as { toolCallId: string }).toolCallId);
  }
  for (const index of [0, 1, 3, 5]) assert.equal(out.messages[index], input[index]);
  assert.deepEqual(store.contents, [payload("c0"), payload("c1")]);
  assert.equal(textOf(input[2]), payload("c0"), "input is not mutated");
});

test("user instructions, summaries and the global goal are preserved", async () => {
  const { run, ask } = setup();
  const summary = { role: "compactionSummary", summary: "UNIQUE: never touch prod", tokensBefore: 9, timestamp: 0 } as PiMessage;
  const input = [
    summary,
    user("first: keep the public API stable"),
    ...turn("c0"),
    user("also: run the linter"),
    ...turn("c1"),
    say("done"),
  ];
  const out = await run(input);
  assert.equal(out.changed, true);
  for (const index of [0, 1, 4]) assert.equal(out.messages[index], input[index]);
  const goal = (ask.requests[0]?.state as { goal: string }).goal;
  assert.match(goal, /keep the public API stable/);
  assert.match(goal, /run the linter/);
  const history = JSON.stringify(ask.requests[0]?.state);
  assert.match(history, /UNIQUE: never touch prod/, "the summary is visible to Jev as history");
  assert.doesNotMatch(history, /DDDDDDDDDD/, "tool output never enters the Jev state");
});

test("image and mixed image/text results are never touched or asked about", async () => {
  const { run, ask } = setup();
  const input = [
    user("look at the screenshots"),
    assistant([call("img"), call("mix")]),
    result("img", [PNG]),
    result("mix", [{ type: "text", text: "X".repeat(5_000) }, PNG]),
    ...turn("c0"),
    say("done"),
  ];
  const out = await run(input);
  assert.equal(out.messages[2], input[2]);
  assert.equal(out.messages[3], input[3]);
  assert.equal(out.messages[1], input[1]);
  assert.deepEqual(
    out.decisions.filter((d) => d.index <= 3).map((d) => d.reason),
    ["has_image", "has_image"],
  );
  assert.deepEqual(asked(ask), ["result_t3"], "only c0 is a candidate");
});

test("unpaired calls and results stay; a spilled result keeps its call record", async () => {
  const { run } = setup();
  const input = [
    user("go"),
    assistant([call("lonely")]),
    textResult("orphan", "O".repeat(5_000)),
    ...turn("c0"),
    say("done"),
  ];
  const out = await run(input);
  assert.equal(out.messages[1], input[1]);
  assert.equal(out.messages[2], input[2]);
  assert.equal(out.decisions.find((d) => d.toolCallId === "orphan")?.reason, "unpaired_result");
  assert.equal(out.messages[3], input[3], "assistant message holding the paired call is untouched");
  assert.ok(isSpillNotice(textOf(out.messages[4])));
});

test("the latest error result is kept verbatim", async () => {
  const { run, ask } = setup();
  const input = [user("go"), ...turn("c0"), assistant([call("e1")]), textResult("e1", "E".repeat(5_000), { isError: true }), say("done")];
  const out = await run(input);
  assert.equal(out.messages[4], input[4]);
  assert.equal(out.decisions.find((d) => d.toolCallId === "e1")?.reason, "error");
  assert.equal(asked(ask).length, 1);
});

test("results inside the recent window are kept", async () => {
  const { run, ask } = setup({ limits: { recentTurns: 3 } });
  const input = session(3); // assistant turns: c0, c1, c2, done -> window starts at c1
  const out = await run(input);
  assert.ok(isSpillNotice(textOf(out.messages[2])));
  assert.equal(out.messages[4], input[4]);
  assert.equal(out.messages[6], input[6]);
  assert.deepEqual(
    out.decisions.map((d) => d.reason),
    ["spilled", "recent", "recent"],
  );
  assert.equal(asked(ask).length, 1);
});

test("same tool call id with a different result is decided again", async () => {
  const ask = fakeAsk(0.9);
  const { run } = setup({ ask });
  const first = [user("go"), assistant([call("c0")]), textResult("c0", "port 8471".repeat(600)), say("done")];
  const second = [user("go"), assistant([call("c0")]), textResult("c0", "port 9471".repeat(600)), say("done")];
  await run(first);
  await run(first);
  assert.equal(ask.requests.length, 1, "identical content is served from cache");
  const out = await run(second);
  assert.equal(ask.requests.length, 2, "changed content is asked again");
  assert.equal(out.decisions[0]?.source, "jev");
});

test("a branch switch invalidates cached decisions", async () => {
  const { run, ask, reducer } = setup();
  const input = session(2);
  await run(input, { branchId: "b1" });
  assert.ok(reducer.cache.size > 0);
  const asksBefore = ask.requests.length;
  await run(input, { branchId: "b2" });
  assert.equal(ask.requests.length, asksBefore + 1);
  const out = await run(input, { branchId: "b2" });
  assert.equal(ask.requests.length, asksBefore + 1);
  assert.ok(out.decisions.every((d) => d.source === "cache"));
});

test("an archive failure keeps the original text and is retried without asking Jev again", async () => {
  const { run, ask, store } = setup();
  store.fail = { ok: false, reason: "io_error", detail: "EROFS" };
  const input = session(1);
  const out = await run(input);
  assert.equal(out.changed, false);
  assert.equal(out.messages, input);
  assert.equal(out.reason, "nothing_dropped");
  assert.equal(out.decisions[0]?.reason, "spill_failed");
  assert.equal(out.decisions[0]?.spillError, "io_error");
  assert.equal(out.stats.spillFailures, 1);

  delete store.fail;
  const retried = await run(input);
  assert.equal(ask.requests.length, 1);
  assert.equal(retried.changed, true);
  assert.ok(isSpillNotice(textOf(retried.messages[2])));
});

test("recalled content and existing spill notices are never dropped again", async () => {
  const { run, ask, store } = setup();
  const notice = spillNotice(formatHandle("s1", "c".repeat(64)), { chars: 9_000 });
  const input = [
    user("go"),
    assistant([call("r1", RECALL_TOOL_NAME)]),
    textResult("r1", "R".repeat(9_000), { toolName: RECALL_TOOL_NAME }),
    assistant([call("n1")]),
    textResult("n1", notice),
    say("done"),
  ];
  const out = await run(input);
  assert.equal(out.messages, input);
  assert.equal(out.reason, "no_candidates");
  assert.deepEqual(out.decisions.map((d) => d.reason), ["recalled", "already_spilled"]);
  assert.equal(ask.requests.length, 0);
  assert.equal(store.contents.length, 0);
});

test("Jev unavailable returns the input unchanged and caches nothing", async () => {
  const ask = (async (request: ContextAskRequest): Promise<JevResult<NoulEvidence[]>> => {
    ask.requests.push(request);
    return { ok: false, error: { kind: "timeout" } };
  }) as FakeAsk;
  ask.requests = [];
  const { run, reducer, store } = setup({ ask });
  const input = session(2);
  const out = await run(input);
  assert.equal(out.messages, input);
  assert.equal(out.changed, false);
  assert.equal(out.reason, "jev_unavailable");
  assert.equal(out.jevError, "timeout");
  assert.equal(reducer.cache.size, 0);
  assert.equal(store.contents.length, 0);
});

test("a pre-cancelled request asks nothing and stores nothing", async () => {
  const { run, ask, store } = setup();
  const controller = new AbortController();
  controller.abort();
  const input = session(3);
  const out = await run(input, { signal: controller.signal });
  assert.equal(out.messages, input);
  assert.equal(out.reason, "cancelled");
  assert.equal(ask.requests.length, 0);
  assert.equal(store.contents.length, 0);
});

test("cancellation during an ask returns unchanged and commits no decisions", async () => {
  const controller = new AbortController();
  const inner = fakeAsk();
  const ask = (async (request: ContextAskRequest) => {
    const answer = await inner(request);
    controller.abort();
    return answer;
  }) as FakeAsk;
  ask.requests = inner.requests;
  const { run, reducer } = setup({ ask });
  const input = session(2);
  const out = await run(input, { signal: controller.signal });
  assert.equal(out.messages, input);
  assert.equal(out.reason, "cancelled");
  assert.equal(reducer.cache.size, 0);
});

test("an older generation finishing after a newer one started does not commit", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = fakeAsk();
  let first = true;
  const ask = (async (request: ContextAskRequest) => {
    if (first) {
      first = false;
      await gate;
    }
    return inner(request);
  }) as FakeAsk;
  ask.requests = inner.requests;
  const { reducer } = setup({ ask });
  const input = session(1);
  const base = { sessionId: "s1", branchId: "b1" };
  const older = reducer.reduce({ ...base, messages: input, generation: 1 });
  const newer = await reducer.reduce({ ...base, messages: input, generation: 2 });
  release();
  const olderOut = await older;
  assert.equal(newer.reason, "reduced");
  assert.equal(olderOut.reason, "stale_generation");
  assert.equal(olderOut.messages, input);

  const late = await reducer.reduce({ ...base, messages: input, generation: 1 });
  assert.equal(late.reason, "stale_generation");
  assert.equal(inner.requests.length, 2, "a generation older than the latest asks nothing");
});

test("an oversized history is bounded by the ask budget and the state limit", async () => {
  const { run, ask } = setup({ limits: { maxWindowChars: 30_000, maxAsks: 2, maxStateTokens: 2_000 } });
  const input = session(40, 20_000);
  const out = await run(input);
  assert.ok(ask.requests.length <= 2);
  assert.ok(out.stats.asks <= 2);
  assert.ok(out.stats.maxStateTokens > 0 && out.stats.maxStateTokens <= 2_000);
  assert.ok(out.stats.unscored > 0);
  const unscored = out.decisions.filter((d) => d.reason === "unscored_budget" || d.reason === "unscored_state");
  assert.ok(unscored.length > 0);
  for (const decision of unscored) assert.equal(out.messages[decision.index], input[decision.index]);
  assert.ok(out.stats.spilled > 0);
});

test("identical input twice gives identical output and no new asks or archive writes", async () => {
  const { run, ask, store } = setup({ ask: fakeAsk(0.01, { result_t2: 0.9 }) });
  const input = session(3);
  const first = await run(input);
  const asks = ask.requests.length;
  const writes = store.contents.length;
  const second = await run(input);
  assert.equal(ask.requests.length, asks);
  assert.equal(store.contents.length, writes);
  assert.equal(JSON.stringify(second.messages), JSON.stringify(first.messages));
  assert.deepEqual(second.decisions.map((d) => d.action), first.decisions.map((d) => d.action));
  assert.ok(second.decisions.every((d) => d.source === "cache"));
});

test("a grown session re-emits a byte-identical prefix and only asks about new results", async () => {
  const { run, ask } = setup();
  const start = session(3);
  const first = await run(start);
  const grown = [...start, ...turn("c9"), say("more")];
  const second = await run(grown);
  assert.equal(JSON.stringify(second.messages.slice(0, start.length)), JSON.stringify(first.messages));
  assert.deepEqual(asked(ask).length, 4, "three from the first request, one for c9");
});

test("Jev keeping everything leaves the request unchanged", async () => {
  const { run } = setup({ ask: fakeAsk(0.95) });
  const input = session(2);
  const out = await run(input);
  assert.equal(out.messages, input);
  assert.equal(out.reason, "nothing_dropped");
  assert.deepEqual(out.decisions.map((d) => d.reason), ["kept", "kept"]);
});

test("a result shorter than its notice is not archived", async () => {
  const { run, store } = setup();
  const input = [user("go"), assistant([call("c0")]), textResult("c0", "tiny"), say("done")];
  const out = await run(input);
  assert.equal(out.messages, input);
  assert.equal(out.decisions[0]?.reason, "no_saving");
  assert.equal(store.contents.length, 0);
});

test("below minChars the request is left alone without asking", async () => {
  const { run, ask } = setup({ limits: { minChars: 1_000_000 } });
  const input = session(2);
  const out = await run(input);
  assert.equal(out.messages, input);
  assert.equal(out.reason, "below_min_chars");
  assert.equal(ask.requests.length, 0);
});

test("stats report exact chars and separate token estimates; telemetry carries no content", async () => {
  const events: ContextReduceEvent[] = [];
  const { run } = setup({ events });
  const input = session(1);
  const out = await run(input);
  const notice = textOf(out.messages[2]);
  const before = ["fix the failing parsePort test", "step c0", payload("c0"), "done"].reduce((s, t) => s + t.length, 0);
  assert.deepEqual(out.stats.chars, { before, after: before - payload("c0").length + notice.length });
  assert.ok(out.stats.estimatedTokens.after < out.stats.estimatedTokens.before);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.reason, "reduced");
  assert.equal(events[0]?.durationMs, 0);
  const serialized = JSON.stringify(events[0]);
  assert.doesNotMatch(serialized, /DDDD|parsePort|spill:/);
});

test("an injected cache is used and shared", async () => {
  const cache = createDecisionCache();
  const ask = fakeAsk();
  const deps = { ask, store: fakeStore(), clock: () => 0, limits: { recentTurns: 1 }, cache };
  const input = session(1);
  await createContextReducer(deps).reduce({ messages: input, sessionId: "s1", branchId: "b1", generation: 1 });
  const out = await createContextReducer(deps).reduce({ messages: input, sessionId: "s1", branchId: "b1", generation: 1 });
  assert.equal(ask.requests.length, 1);
  assert.equal(out.decisions[0]?.source, "cache");
});

test("a per-call maxAsks below the limit reduces partially; 0 asks nothing but still applies cached decisions", async () => {
  const { run, ask } = setup({ limits: { maxWindowChars: 30_000, maxAsks: 4 } });
  const input = session(6, 20_000);
  const partial = await run(input, { maxAsks: 1 });
  assert.equal(ask.requests.length, 1);
  assert.equal(partial.stats.asks, 1);
  assert.equal(partial.reason, "reduced");
  assert.ok(partial.stats.spilled > 0 && partial.stats.unscored > 0);
  assert.ok(partial.decisions.some((d) => d.reason === "unscored_budget"));
  const none = await run(input, { maxAsks: 0 });
  assert.equal(ask.requests.length, 1, "no ask at maxAsks 0");
  assert.equal(none.reason, "reduced");
  assert.equal(none.stats.spilled, partial.stats.spilled, "cached verdicts still apply");
  assert.equal(none.stats.cacheHits, partial.stats.spilled);
});

test("a different revision never reuses a decision; the same revision does", async () => {
  const { run, ask } = setup();
  const input = session(2);
  await run(input, { revision: "task-1" });
  const asks = ask.requests.length;
  await run(input, { revision: "task-1" });
  assert.equal(ask.requests.length, asks);
  await run(input, { revision: "task-2" });
  assert.equal(ask.requests.length, asks * 2);
});
