/**
 * T105 L4 verifier edge cases: C7 request reduction + jev_recall, C8 fast-jev compaction,
 * proactive compaction, OMP_JEV_* / OMP_TELEMETRY_* precedence, and safety.
 * Fake OMP host, fake Jev (injected fetch), temp dirs only; no real model, Jev, ~/.omp or ~/.pi.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "../../../../src/adapters/omp/legacy.ts";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { ompContextSettings } from "../../../../src/adapters/omp/context-settings.ts";
import { createOmpContextReducer } from "../../../../src/adapters/omp/context.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

const KEY = "fake-typesafe-key-l4-verify";
const SESSION = "omp-session-l4v";
const ENOENT = async (): Promise<string> => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };

// ---- fixtures ---------------------------------------------------------------------------------

const user = (text: string) => ({ role: "user", content: text });
const assistant = (content: unknown[]) => ({ role: "assistant", content });
const toolCall = (id: string, name = "read") => ({ type: "toolCall", id, name, arguments: { path: `${id}.txt` } });
const toolResult = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false });
/** Unicode edge content: astral emoji, combining marks, CRLF, NUL, lone BOM, RTL. */
const tricky = (id: string, repeat: number) => `${id}:` + "😀é\r\n\u0000﻿שלום€".repeat(repeat) + "\n\ttrailing  ";

type Answer = (id: string, instructions: string) => number;

interface FakeJev {
  state: { requests: number; signals: AbortSignal[] };
  fetch: typeof globalThis.fetch;
}

function fakeJev(answer: Answer | "fail" | "hang" = () => 0.01): FakeJev {
  const state = { requests: 0, signals: [] as AbortSignal[] };
  const fetch = (async (_input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    state.requests++;
    if (init?.signal) state.signals.push(init.signal);
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { instructions: string }> };
    if (answer === "fail") return new Response("down", { status: 503 });
    if (answer === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: "noul", noul: answer(id, q.instructions) }]));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

interface Host {
  api: OmpExtensionAPI;
  ctx: OmpContext;
  tools: Map<string, OmpToolDefinition>;
  commands: Map<string, (args: string, ctx: OmpContext) => unknown>;
  handlers: Map<string, OmpHandler[]>;
  active: string[];
  compacts: number;
  compactImpl: (options?: { onComplete?: () => void; onError?: (error: Error) => void }) => Promise<void> | void;
  setterCalls: string[];
  notes: string[];
  header: { parentSession?: string };
  pending: boolean;
  usage: { percent: number | null | undefined };
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

function fakeHost(): Host {
  const host = {
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    active: ["read"],
    compacts: 0,
    setterCalls: [],
    notes: [],
    header: {},
    pending: false,
    usage: { percent: undefined },
  } as unknown as Host;
  host.compactImpl = (options) => { options?.onComplete?.(); };
  host.ctx = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => host.header, getSessionId: () => SESSION, getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] },
    getContextUsage: () => ({ percent: host.usage.percent ?? null }),
    ui: { notify: (message: string) => { host.notes.push(message); } },
    hasPendingMessages: () => host.pending,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: (options) => { host.compacts++; return host.compactImpl(options); },
  } as OmpContext;
  const commands = new Map<string, { name: string; source: "extension"; description?: string }>();
  host.api = {
    pi: { VERSION: "18.4.1" },
    on: (event, handler) => { host.handlers.set(event, [...(host.handlers.get(event) ?? []), handler]); },
    registerCommand: (name, options) => { host.commands.set(name, options.handler); commands.set(name, { name, source: "extension" as const, description: options.description }); },
    registerTool: (tool) => { host.tools.set(tool.name, tool); },
    // Own tools carry this package as source (T105 L3 legacy check reads sourceInfo).
    getAllTools: () => [...host.tools.values()].map(({ name }) => ({ name, sourceInfo: { path: join(PACKAGE_ROOT, "src/adapters/omp/index.ts"), source: "extension" as const } })),
    getActiveTools: () => [...host.active],
    getCommands: () => [...commands.values()],
    getThinkingLevel: () => undefined,
    setActiveTools: async (names) => { host.active = [...names]; },
    setModel: () => { host.setterCalls.push("setModel"); return true; },
    setThinkingLevel: () => { host.setterCalls.push("setThinkingLevel"); },
  } as OmpExtensionAPI;
  host.emit = async (event, payload = {}) => {
    const results: unknown[] = [];
    for (const handler of host.handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, host.ctx));
    return results;
  };
  return host;
}

interface Setup {
  host: Host;
  jev: FakeJev;
  events: TelemetryInput[];
  dir: string;
  storeDir: string;
  settled(): Promise<void>;
  status(): string;
  cleanup(): Promise<void>;
}

async function setup(config: Record<string, unknown>, options: { jev?: FakeJev; env?: Record<string, string> } = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), "omp-l4v-"));
  const storeDir = join(dir, "store");
  // C12 effort (T105 L6, default shadow) would add its own Jev request; these tests count C7/C8 traffic only.
  const file = { effort: "off", ...config, context: { storeDir, limits: { recentTurns: 1 }, ...(config.context as object) } };
  const jev = options.jev ?? fakeJev();
  const events: TelemetryInput[] = [];
  const host = fakeHost();
  const registry = {};
  const env = { TYPESAFE_API_KEY: KEY, ...options.env };
  createExtension({
    env,
    loadConfig: () => loadOmpConfig({ home: dir, env, readText: async () => JSON.stringify(file), readLegacyText: ENOENT }),
    fetch: jev.fetch,
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
  }, registry)(host.api);
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void>; statusText(): string } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  await host.emit("session_start");
  await host.emit("before_agent_start", { prompt: "fix the failing parsePort test" });
  return {
    host, jev, events, dir, storeDir,
    settled: () => claim.settled(),
    status: () => claim.statusText(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const ON = (context: Record<string, unknown> = {}) => ({ mode: "on", outbound: { taskIntent: true }, router: { tools: "off" }, context: { request: "on", ...context } });
const HANDLE_RE = /spill:[a-z0-9._-]+:[0-9a-f]{64}/;
const firstText = (message: unknown) => (message as { content: Array<{ text: string }> }).content[0]!.text;

// ---- C7 ---------------------------------------------------------------------------------------

test("C7 on: large unicode payloads recall byte for byte; result is exactly {messages} of the same shape", async () => {
  const s = await setup(ON());
  try {
    const big = tricky("c0", 60_000); // ~1.2M UTF-16 units, several MB of UTF-8
    const small = tricky("c1", 500);
    const messages = [
      user("fix the failing parsePort test"),
      assistant([{ type: "text", text: "step c0" }, toolCall("c0")]), toolResult("c0", big),
      assistant([{ type: "text", text: "step c1" }, toolCall("c1")]), toolResult("c1", small),
      assistant([{ type: "text", text: "done" }]),
    ];
    const snapshot = structuredClone(messages);
    const [result] = await s.host.emit("context", { messages });
    assert.ok(result && typeof result === "object");
    assert.deepEqual(Object.keys(result as object), ["messages"], "OMP ContextEventResult: only `messages`");
    const reduced = (result as { messages: Array<Record<string, unknown>> }).messages;
    assert.deepEqual(messages, snapshot, "event.messages untouched");
    assert.equal(reduced.length, messages.length);
    reduced.forEach((m, i) => assert.equal(m.role, (messages[i] as { role: string }).role, `role ${i}`));
    // Unchanged messages stay deep-equal (OMP keeps their history index); replaced ones keep ids.
    for (const i of [0, 1, 3, 5]) assert.deepEqual(reduced[i], messages[i]);
    const replaced = [2, 4].filter((i) => firstText(reduced[i]) !== firstText(messages[i]));
    assert.ok(replaced.length >= 1, "something was reduced");
    for (const i of replaced) {
      const original = messages[i] as Record<string, unknown>;
      for (const key of ["role", "toolCallId", "toolName", "isError"]) assert.equal(reduced[i]![key], original[key], key);
      const handle = HANDLE_RE.exec(firstText(reduced[i]))?.[0];
      assert.ok(handle);
      const recalled = await s.host.tools.get("jev_recall")!.execute(`t${i}`, { handle }, undefined, undefined, s.host.ctx);
      const want = firstText(original);
      assert.ok(Buffer.from(recalled.content[0]!.text, "utf8").equals(Buffer.from(want, "utf8")), `byte-identical recall of message ${i}`);
      assert.equal(recalled.content[0]!.text.length, want.length);
    }
    assert.equal(s.jev.state.requests <= 2, true, "per-task budget respected");
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

test("C7 on: jev_recall rejects foreign handles and path-like input", async () => {
  const s = await setup(ON());
  try {
    const recall = s.host.tools.get("jev_recall")!;
    for (const handle of ["../../etc/passwd", `spill:other-session:${"a".repeat(64)}`, `spill:${SESSION}:${"0".repeat(64)}`, 42, undefined])
      await assert.rejects(Promise.resolve().then(() => recall.execute("t", { handle }, undefined, undefined, s.host.ctx)), `handle ${String(handle)}`);
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

test("C7 on: archive write failure keeps the original messages (injected fs)", async () => {
  const jev = fakeJev();
  const loaded = await loadOmpConfig({ home: "/nonexistent-home", env: {}, readText: async () => JSON.stringify(ON({ storeDir: "/nonexistent-store", limits: { recentTurns: 1 } })), readLegacyText: ENOENT });
  const fail = async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
  const reducer = createOmpContextReducer({
    config: loaded.config, settings: ompContextSettings(loaded), runId: "r", env: { TYPESAFE_API_KEY: KEY }, fetch: jev.fetch,
    now: Date.now, newId: () => Math.random().toString(16).slice(2), onJevRequest: () => {}, record: () => {},
    fs: { mkdir: fail, writeFile: fail, readFile: fail, rename: fail, readdir: fail, stat: fail, open: fail, unlink: fail, rm: fail, lstat: fail } as never,
  });
  const ctx = fakeHost().ctx;
  const messages = [
    user("task"), assistant([toolCall("c0")]), toolResult("c0", tricky("c0", 2000)),
    assistant([toolCall("c1")]), toolResult("c1", tricky("c1", 2000)), assistant([{ type: "text", text: "done" }]),
  ];
  assert.equal(await reducer.handle({ type: "context", messages }, ctx, "on"), undefined);
  await reducer.settled();
});

test("C7 on: child session is not reduced and asks Jev nothing", async () => {
  const s = await setup(ON());
  try {
    s.host.header.parentSession = "/parent.jsonl";
    const messages = [user("t"), assistant([toolCall("c0")]), toolResult("c0", tricky("c0", 2000)), assistant([{ type: "text", text: "ok" }])];
    assert.deepEqual(await s.host.emit("context", { messages }), [undefined]);
    assert.equal(s.jev.state.requests, 0);
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

test("C7 shadow: jev_recall is not added to the active tool set (shadow never changes the tool set)", async () => {
  const s = await setup({ ...ON(), mode: "shadow" });
  try {
    assert.deepEqual(s.host.active, ["read"]);
  } finally {
    await s.cleanup();
  }
});

test("/jev mode off aborts an in-flight shadow reduction (no further Jev traffic after off)", async () => {
  const jev = fakeJev("hang");
  const s = await setup({ ...ON(), mode: "shadow" }, { jev });
  try {
    const messages = [user("t"), assistant([toolCall("c0")]), toolResult("c0", tricky("c0", 2000)), assistant([toolCall("c1")]), toolResult("c1", tricky("c1", 2000)), assistant([{ type: "text", text: "ok" }])];
    await s.host.emit("context", { messages });
    for (let i = 0; i < 20 && jev.state.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(jev.state.signals.length > 0, "shadow reduction started");
    await s.host.commands.get("jev")!("mode off", s.host.ctx);
    assert.ok(jev.state.signals.every((signal) => signal.aborted), "in-flight Jev request aborted on mode off");
  } finally {
    await s.host.emit("session_shutdown");
    await s.cleanup();
  }
});

// ---- C8 ---------------------------------------------------------------------------------------

/** A region with five tool calls; Jev keeps c1 and c3 (fast-jev ids t2, t4), drops the rest. */
function region() {
  const messages: unknown[] = [user("port the parser — keep unicode: 😀 שלום é")];
  for (let i = 0; i < 5; i++) {
    messages.push(assistant([{ type: "text", text: `step c${i}` }, toolCall(`c${i}`, i % 2 ? "grep" : "read")]));
    messages.push(toolResult(`c${i}`, tricky(`c${i}`, 300 + i)));
  }
  messages.push(assistant([{ type: "text", text: "summary of work so far" }]));
  return messages;
}
const keepOdd: Answer = (_id, instructions) => (/tool call t[24] /.test(instructions) ? 0.9 : 0.05);
const preparation = (messages = region()) => ({ firstKeptEntryId: "entry-42", tokensBefore: 54_321, messagesToSummarize: messages, turnPrefixMessages: [] });
const compactEvent = (prep: unknown = preparation(), signal = new AbortController().signal) => ({ preparation: prep, branchEntries: [], signal });

test("C8 on: result matches OMP SessionBeforeCompactResult/CompactionResult exactly; no cancel; JSONL-safe", async () => {
  const s = await setup(ON({ request: "off", compaction: "on" }), { jev: fakeJev(keepOdd) });
  try {
    const [result] = await s.host.emit("session_before_compact", compactEvent());
    assert.ok(result, JSON.stringify(s.events));
    assert.deepEqual(Object.keys(result as object), ["compaction"], "only `compaction`, never `cancel`");
    const c = (result as { compaction: Record<string, unknown> }).compaction;
    const allowed = ["summary", "shortSummary", "firstKeptEntryId", "tokensBefore", "details", "preserveData"];
    for (const key of Object.keys(c)) assert.ok(allowed.includes(key), `unexpected CompactionResult key ${key}`);
    assert.equal(typeof c.summary, "string");
    assert.equal(typeof c.shortSummary, "string");
    assert.equal(c.firstKeptEntryId, "entry-42");
    assert.equal(c.tokensBefore, 54_321);
    assert.ok(c.preserveData && typeof c.preserveData === "object" && !Array.isArray(c.preserveData));
    assert.deepEqual(JSON.parse(JSON.stringify(c)), c, "round-trips through JSON (session JSONL)");
    const summary = c.summary as string;
    // Kept history verbatim (unicode intact), dropped results absent, no generated summary prose.
    for (const kept of ["port the parser — keep unicode: 😀 שלום é", "step c0", "step c4", tricky("c1", 301), tricky("c3", 303), "summary of work so far"])
      assert.ok(summary.includes(kept), `verbatim ${JSON.stringify(kept.slice(0, 24))}`);
    for (const dropped of [tricky("c0", 300), tricky("c2", 302), tricky("c4", 304)]) assert.ok(!summary.includes(dropped));
    assert.equal(s.host.compacts, 0);
    assert.deepEqual(s.host.setterCalls, []);
  } finally {
    await s.cleanup();
  }
});


test("C8: wait budget (compactWaitMs) and host abort signal both fall back to native", async () => {
  for (const variant of ["wait", "signal"] as const) {
    const jev = fakeJev("hang");
    const s = await setup({ ...ON({ request: "off", compaction: "on" }), budget: { compactWaitMs: 50 } }, { jev });
    try {
      const controller = new AbortController();
      if (variant === "signal") setTimeout(() => controller.abort(), 10);
      const started = Date.now();
      const [result] = await s.host.emit("session_before_compact", compactEvent(preparation(), controller.signal));
      assert.equal(result, undefined, variant);
      assert.ok(Date.now() - started < 2_000, `${variant}: bounded`);
      assert.ok(jev.state.signals.length > 0 && jev.state.signals.every((sig) => sig.aborted), `${variant}: Jev requests aborted`);
      assert.ok(s.events.some((e) => e.source === "compaction:native"));
    } finally {
      await s.cleanup();
    }
  }
});

test("C8: child session, malformed preparations and missing key all return undefined without Jev", async () => {
  const s = await setup(ON({ request: "off", compaction: "on" }), { jev: fakeJev(keepOdd) });
  try {
    for (const prep of [
      null, "x", { ...preparation(), firstKeptEntryId: "" }, { ...preparation(), tokensBefore: Number.NaN },
      { ...preparation(), messagesToSummarize: "no" }, { ...preparation(), turnPrefixMessages: {} },
      { ...preparation(), messagesToSummarize: [] },
    ]) assert.deepEqual(await s.host.emit("session_before_compact", compactEvent(prep)), [undefined], JSON.stringify(prep)?.slice(0, 60));
    assert.equal(s.jev.state.requests, 0);
    s.host.header.parentSession = "/p.jsonl";
    assert.deepEqual(await s.host.emit("session_before_compact", compactEvent()), [undefined]);
    assert.equal(s.jev.state.requests, 0);
  } finally {
    await s.cleanup();
  }
  const nokey = await setup(ON({ request: "off", compaction: "on" }), { jev: fakeJev(keepOdd), env: { TYPESAFE_API_KEY: "" } });
  try {
    assert.deepEqual(await nokey.host.emit("session_before_compact", compactEvent()), [undefined]);
    assert.equal(nokey.jev.state.requests, 0);
  } finally {
    await nokey.cleanup();
  }
});

test("C8: a credential-shaped region is never sent to Jev", async () => {
  const s = await setup(ON({ request: "off", compaction: "on" }), { jev: fakeJev(keepOdd) });
  try {
    const messages = region();
    // Assistant text is part of the state sent to Jev (tool results are not).
    messages.splice(3, 0, assistant([{ type: "text", text: `use token ${KEY}` }]));
    const [result] = await s.host.emit("session_before_compact", compactEvent(preparation(messages)));
    assert.equal(result, undefined);
    assert.equal(s.jev.state.requests, 0);
  } finally {
    await s.cleanup();
  }
});

test("C8: compaction:on with request:off never activates jev_recall", async () => {
  const s = await setup(ON({ request: "off", compaction: "on", proactive: { mode: "on" } }));
  try {
    assert.deepEqual(s.host.active, ["read"]);
  } finally {
    await s.cleanup();
  }
});

// ---- proactive --------------------------------------------------------------------------------

async function agentEnd(s: Setup, percent: number | null, payload: Record<string, unknown> = {}) {
  s.host.usage.percent = percent;
  await s.host.emit("agent_end", { messages: [], ...payload });
  await s.settled();
}

test("proactive: boundaries 69.99/70/89.99/90, null/NaN usage, child session, pending messages", async () => {
  const s = await setup(ON({ request: "off", proactive: { mode: "on" } }), { jev: fakeJev(() => 0.69) });
  try {
    await agentEnd(s, 69.99);
    await agentEnd(s, null);
    await agentEnd(s, Number.NaN);
    assert.deepEqual([s.jev.state.requests, s.host.compacts], [0, 0]);
    await agentEnd(s, 70);
    assert.deepEqual([s.jev.state.requests, s.host.compacts], [1, 0], "0.69 < 0.7 is not a natural break");
    await agentEnd(s, 89.99);
    assert.deepEqual([s.jev.state.requests, s.host.compacts], [2, 0]);
    s.host.header.parentSession = "/p.jsonl";
    await agentEnd(s, 99);
    assert.deepEqual([s.jev.state.requests, s.host.compacts], [2, 0], "child session: nothing");
    s.host.header.parentSession = undefined;
    s.host.pending = true;
    await agentEnd(s, 99);
    assert.deepEqual([s.jev.state.requests, s.host.compacts], [2, 0], "pending messages: nothing");
    s.host.pending = false;
    await agentEnd(s, 90);
    assert.deepEqual([s.jev.state.requests, s.host.compacts], [2, 1], "hard: no Jev, compacts");
  } finally {
    await s.cleanup();
  }
  const yes = await setup(ON({ request: "off", proactive: { mode: "on" } }), { jev: fakeJev(() => 0.7) });
  try {
    await agentEnd(yes, 75);
    assert.equal(yes.host.compacts, 1, "0.7 is a natural break (>=)");
  } finally {
    await yes.cleanup();
  }
});

test("proactive: no second ctx.compact() while one is running; compact error resets and notifies", async () => {
  const s = await setup(ON({ request: "off", proactive: { mode: "on" } }));
  try {
    let finish: (() => void) | undefined;
    s.host.compactImpl = (options) => new Promise<void>((resolve) => { finish = () => { options?.onComplete?.(); resolve(); }; });
    s.host.usage.percent = 95;
    await s.host.emit("agent_end", { messages: [] });
    for (let i = 0; i < 20 && s.host.compacts === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.host.compacts, 1);
    await s.host.emit("agent_end", { messages: [] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.host.compacts, 1, "no compact while one is running");
    finish!();
    await s.settled();
    s.host.compactImpl = () => { throw new Error("boom"); };
    await agentEnd(s, 95);
    assert.equal(s.host.compacts, 2);
    assert.ok(s.host.notes.some((n) => /boom/.test(n)));
    s.host.compactImpl = (options) => { options?.onComplete?.(); };
    await agentEnd(s, 95);
    assert.equal(s.host.compacts, 3, "flag reset after an error");
  } finally {
    await s.cleanup();
  }
});

test("proactive: two overlapping agent_end at soft threshold compact at most once", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = fakeJev(() => 0.9);
  const jev: FakeJev = { state: base.state, fetch: (async (input: unknown, init?: RequestInit) => { await gate; return base.fetch(input as string, init); }) as typeof fetch };
  const s = await setup(ON({ request: "off", proactive: { mode: "on" } }), { jev });
  try {
    s.host.usage.percent = 80;
    const a = s.host.emit("agent_end", { messages: [] });
    const b = s.host.emit("agent_end", { messages: [] });
    await new Promise((r) => setTimeout(r, 10));
    release!();
    await Promise.all([a, b]);
    await s.settled();
    assert.equal(s.host.compacts, 1);
  } finally {
    await s.cleanup();
  }
});

// ---- safety -----------------------------------------------------------------------------------

test("session off with every L4 switch on: no Jev request, no compact, no tool-set change", async () => {
  const s = await setup({ ...ON({ compaction: "on", proactive: { mode: "on" } }), mode: "off" }, { jev: fakeJev(keepOdd) });
  try {
    await s.host.emit("context", { messages: region() });
    await s.host.emit("session_before_compact", compactEvent());
    await agentEnd(s, 99);
    assert.deepEqual([s.jev.state.requests, s.host.compacts, s.host.active, s.host.setterCalls], [0, 0, ["read"], []]);
  } finally {
    await s.cleanup();
  }
});

test("off registers no session_before_compact handler (OMP disables speculative compaction when one exists)", async () => {
  const s = await setup({ mode: "off" });
  try {
    assert.equal(s.host.handlers.has("session_before_compact"), false);
  } finally {
    await s.cleanup();
  }
});

// ---- env precedence ---------------------------------------------------------------------------

test("env precedence per variable: invalid/empty env falls back to config, not to the default", async () => {
  const cfg = {
    telemetryDir: "/cfg/tel", jev: { url: "http://127.0.0.1:1/cfg", timeoutMs: 999 },
    context: { request: "shadow", storeDir: "/cfg/store", limits: { minChars: 11 }, fastJev: { keepThreshold: 0.3, preserveRecent: 2, minReduction: 0.4, spill: true, cacheCeiling: 0.6, model: "cfg-model" } },
  };
  const load = (env: Record<string, string>, options: { telemetryDir?: string } = {}) =>
    loadOmpConfig({ home: "/h", env, readText: async () => JSON.stringify(cfg), readLegacyText: ENOENT, ...options });
  const bad = await load({
    OMP_JEV_CONTEXT: "", OMP_JEV_KEEP_THRESHOLD: "abc", OMP_JEV_PRESERVE_RECENT: "-1", OMP_JEV_MIN_REDUCTION: "2", OMP_JEV_SPILL: "",
    OMP_JEV_SPILL_DIR: "relative/dir", OMP_JEV_CACHE_CEILING: "NaN", OMP_JEV_TIMEOUT_MS: "0", OMP_JEV_BASE_URL: "ftp://x", OMP_JEV_MODEL: "  ",
    OMP_JEV_MIN_CHARS: "1.5", OMP_TELEMETRY_PATH: "rel/events.jsonl",
  });
  const b = ompContextSettings(bad);
  assert.equal(bad.config.context.request, "shadow");
  assert.deepEqual([b.keepThreshold, b.preserveRecent, b.minReduction, b.spill, b.cacheCeiling, b.model], [0.3, 2, 0.4, true, 0.6, "cfg-model"]);
  assert.deepEqual([bad.config.context.storeDir, bad.config.jev.timeoutMs, bad.config.jev.url, bad.config.telemetryDir, bad.config.context.limits.minChars],
    ["/cfg/store", 999, "http://127.0.0.1:1/cfg", "/cfg/tel", 11]);
  const good = await load({ OMP_JEV_MIN_CHARS: "7", OMP_JEV_SPILL: "1", OMP_TELEMETRY_PATH: "/env/t/x.jsonl" });
  assert.deepEqual([good.config.context.limits.minChars, ompContextSettings(good).spill, good.config.telemetryDir], [7, true, "/env/t"]);
  // PI_JEV_URL (the adapter's own variable) keeps priority over OMP_JEV_BASE_URL; an injected telemetry dir beats OMP_TELEMETRY_PATH.
  assert.equal((await load({ PI_JEV_URL: "http://127.0.0.1:2/pi", OMP_JEV_BASE_URL: "http://127.0.0.1:3/omp" })).config.jev.url, "http://127.0.0.1:2/pi");
  assert.equal((await load({ OMP_TELEMETRY_PATH: "/env/t/x.jsonl" }, { telemetryDir: "/inj" })).config.telemetryDir, "/inj");
});

test("legacy files: invalid autorun thresholds ignored; config beats legacy per field; env beats config for request", async () => {
  const legacy = (autorun: unknown, harness: unknown = { schemaVersion: 1, capabilities: { compaction: { mode: "on" } } }) => async (path: string) =>
    path.endsWith("jev-autorun.json") ? JSON.stringify(autorun) : path.endsWith("jev-harness.json") ? JSON.stringify(harness) : ENOENT();
  const load = (readLegacyText: (p: string) => Promise<string>, file?: unknown, env: Record<string, string> = {}) =>
    loadOmpConfig({ home: "/h", env, readText: file === undefined ? ENOENT : async () => JSON.stringify(file), readLegacyText });
  const invalid = ompContextSettings(await load(legacy({ mode: "on", softContextPercent: 95, hardContextPercent: 90 })));
  assert.deepEqual([invalid.proactive.mode, invalid.proactive.softPercent, invalid.proactive.hardPercent], ["off", 70, 90]);
  const mixed = ompContextSettings(await load(legacy({ mode: "on", softContextPercent: 50, hardContextPercent: 60 }), { context: { proactive: { hardPercent: 95 } } }));
  assert.deepEqual([mixed.proactive.mode, mixed.proactive.softPercent, mixed.proactive.hardPercent], ["on", 50, 95]);
  const wrongSchema = await load(legacy({}, { schemaVersion: 2, capabilities: { compaction: { mode: "on" } } }));
  assert.deepEqual([wrongSchema.config.context.request, ompContextSettings(wrongSchema).compaction], ["off", "off"]);
  const envOff = await load(legacy({}), undefined, { OMP_JEV_CONTEXT: "0" });
  assert.deepEqual([envOff.config.context.request, ompContextSettings(envOff).sources.request], ["off", "env"]);
  // Pi still rejects every OMP-only key.
  const { loadConfig } = await import("../../../../src/adapters/shared/index.ts");
  for (const bad of [{ context: { proactive: { mode: "on" } } }, { context: { fastJev: { spill: false } } }, { budget: { compactWaitMs: 5 } }, { mode: "on" }])
    assert.equal((await loadConfig({ home: "/h", env: {}, readText: async () => JSON.stringify(bad) })).source, "invalid", JSON.stringify(bad));
});

// ---- round 2 ----------------------------------------------------------------------------------

/** One window whose calls need two parallel fast-jev batches (150 calls, 200-char assistant text). */
function twoBatchRegion() {
  const messages: unknown[] = [user("go")];
  for (let i = 0; i < 150; i++) {
    messages.push(assistant([{ type: "text", text: "x".repeat(200) }, { type: "toolCall", id: `k${i}`, name: "read", arguments: { p: i } }]));
    messages.push(toolResult(`k${i}`, "r".repeat(50)));
  }
  return messages.slice(0, 2 * 150 + 1);
}

test("C8: one failed batch aborts the other in-flight batches (not only by the wait budget)", async () => {
  const state = { requests: 0, hanging: [] as AbortSignal[] };
  const fetch = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
    state.requests++;
    if (state.requests === 1) {
      const signal = init!.signal!;
      state.hanging.push(signal);
      return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    }
    // Later batch fails after the first is in flight.
    await new Promise((r) => setTimeout(r, 20));
    return new Response("bad", { status: 400 });
  }) as typeof globalThis.fetch;
  const s = await setup({ ...ON({ request: "off", compaction: "on" }), budget: { compactWaitMs: 20_000 } }, { jev: { state: { requests: 0, signals: [] }, fetch } });
  try {
    const started = Date.now();
    const [result] = await s.host.emit("session_before_compact", compactEvent(preparation(twoBatchRegion())));
    assert.equal(result, undefined);
    assert.ok(state.requests >= 2, `parallel batches issued (${state.requests})`);
    assert.equal(state.hanging.length, 1);
    assert.ok(state.hanging[0]!.aborted, "the in-flight batch saw abort");
    assert.ok(Date.now() - started < 5_000, "returned on the failure, long before the 20 s wait budget");
    await s.settled();
  } finally {
    await s.cleanup();
  }
});

test("C8 wait never exceeds OMP's 30 s handler timeout minus margin", async () => {
  const { compactionWaitMs } = await import("../../../../src/adapters/omp/compaction.ts");
  const base = (await loadOmpConfig({ home: "/h", env: {}, readText: ENOENT, readLegacyText: ENOENT })).config;
  assert.equal(compactionWaitMs(base), 25_000);
  assert.equal(compactionWaitMs({ ...base, budget: { ...base.budget, compactWaitMs: 120_000 } }), 25_000);
  assert.equal(compactionWaitMs({ ...base, budget: { ...base.budget, compactWaitMs: 1_000 } }), 1_000);
});

test("session_before_compact registered only when compaction is effectively possible at first session start", async () => {
  for (const [config, want] of [
    [ON({ compaction: "on" }), true], [{ ...ON({ compaction: "on" }), mode: "shadow" }, true],
    [ON({ compaction: "off" }), false], [{ ...ON({ compaction: "on" }), mode: "off" }, false],
  ] as const) {
    const s = await setup(config as Record<string, unknown>);
    try {
      assert.equal(s.host.handlers.has("session_before_compact"), want, JSON.stringify(config));
      await s.host.emit("session_start");
      assert.equal((s.host.handlers.get("session_before_compact") ?? []).length, want ? 1 : 0, "never registered twice");
      assert.match(s.status(), want ? /session_before_compact: registered/ : /needs an omp restart/);
    } finally {
      await s.cleanup();
    }
  }
});

test("OMP_TELEMETRY=0 (legacy exact '0'): default telemetry writes nothing; other values write", async () => {
  const { defaultOmpHostDeps } = await import("../../../../src/adapters/omp/host.ts");
  const { readdir } = await import("node:fs/promises");
  for (const [value, writes] of [["0", false], ["1", true], ["", true], ["false", true]] as const) {
    const dir = await mkdtemp(join(tmpdir(), "omp-l4v-tel-"));
    try {
      const telemetry = defaultOmpHostDeps({ env: { OMP_TELEMETRY: value, HOME: dir } }).createTelemetry(dir);
      const ok = await telemetry.record({ runId: `run_${crypto.randomUUID()}`, decisionId: `dec_${crypto.randomUUID()}`, kind: "diagnostic", outcome: "skipped", durationMs: 0, source: "adapter:duplicate_load" });
      assert.equal(ok, writes, "record() result");
      assert.equal((await readdir(dir)).length > 0, writes, `OMP_TELEMETRY=${JSON.stringify(value)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("OMP_JEV_ALLOW_DROPPING_CALLS: only exact '1' enables; low-score calls are dropped", async () => {
  for (const [value, want] of [["1", true], ["0", false], ["true", false], ["", false]] as const) {
    const loaded = await loadOmpConfig({ home: "/h", env: { OMP_JEV_ALLOW_DROPPING_CALLS: value }, readText: ENOENT, readLegacyText: ENOENT });
    assert.equal(ompContextSettings(loaded).allowDroppingCalls, want, value);
  }
  const answer: Answer = (_id, q) => (/tool call t[24] /.test(q) ? 0.9 : 0.01);
  const s = await setup(ON({ request: "off", compaction: "on" }), { jev: fakeJev(answer), env: { OMP_JEV_ALLOW_DROPPING_CALLS: "1" } });
  try {
    const [result] = await s.host.emit("session_before_compact", compactEvent());
    const ours = (result as { compaction?: Record<string, unknown> }).compaction;
    assert.ok(!(ours!.summary as string).includes("Tool call: read (c0)"), "low-score call record dropped");
  } finally {
    await s.cleanup();
  }
});
