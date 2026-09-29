/**
 * Verifier edge cases (model routing removed from the OMP adapter; tool routing kept).
 * Harness copied from verify.test.ts so the two files stay independent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpModel } from "../../../../src/adapters/omp/types.ts";
import { MODEL_ROUTING_IGNORED_NOTE, type LoadedConfig } from "../../../../src/adapters/shared/index.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.omp");
const KEY = "verify-secret-key-1234567890";
const PROMPT = "Please refactor the parser in src/very-unique-task-text-marker";
const MODELS: OmpModel[] = [
  { provider: "p", id: "a", reasoning: true, contextWindow: 200_000 },
  { provider: "p", id: "b", reasoning: false, contextWindow: 200_000 },
];

function fakeHost(version: unknown = "18.3.5") {
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: OmpContext) => unknown; description?: string }>();
  const setterCalls: string[] = [];
  const notes: string[] = [];
  const ctx: OmpContext = {
    model: MODELS[0],
    modelRegistry: { getAvailable: () => MODELS, hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getBranch: () => [] },
    getContextUsage: () => ({ tokens: 100 }),
    ui: { notify: (message) => { notes.push(message); } },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: version },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name, options) { commands.set(name, { handler: options.handler, description: options.description }); },
    getCommands: () => [...commands.entries()].map(([name, c]) => ({ name, source: "extension" as const, description: c.description })),
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } },
      { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } },
    ],
    getActiveTools: () => ["read", "bash"],
    getThinkingLevel: () => "medium",
    setActiveTools: () => { setterCalls.push("setActiveTools"); },
    setModel: () => { setterCalls.push("setModel"); return true; },
    setThinkingLevel: () => { setterCalls.push("setThinkingLevel"); },
  };
  const emitSync = (event: string, payload: Record<string, unknown> = {}) =>
    (handlers.get(event) ?? []).map((handler) => handler({ type: event, ...payload }, ctx));
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  return { api, ctx, handlers, commands, setterCalls, notes, emit, emitSync };
}

function answeringFetch(counter: { requests: number }) {
  return (async (_input: unknown, init?: RequestInit) => {
    counter.requests++;
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      const rest = 0.3 / Math.max(1, options.length - 1);
      return [id, { type: "choice", choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Jev fetch that never answers until aborted. */
function hangingFetch(counter: { requests: number }, hung: HungRequests) {
  return ((_input: unknown, init?: RequestInit) => {
    counter.requests++;
    if (init?.signal) hung.signals.push(init.signal);
    hung.notifyFirst();
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
    });
  }) as typeof fetch;
}

/** Test hook: resolves on the first hanging Jev request and records its AbortSignals. */
type HungRequests = { signals: AbortSignal[]; first: Promise<void>; notifyFirst: () => void };
function hungRequests(): HungRequests {
  let notifyFirst = () => {};
  const first = new Promise<void>((resolve) => { notifyFirst = resolve; });
  return { signals: [], first, notifyFirst };
}

/** Rejects if `promise` does not settle in `ms`; a hang guard only, never the assertion. */
function guard<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`guard: ${what} did not settle`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function setup(config: Record<string, unknown>, options: { version?: unknown; env?: Record<string, string>; hang?: boolean } = {}) {
  const host = fakeHost("version" in options ? options.version : "18.3.5");
  const jev = { requests: 0 };
  const hung = hungRequests();
  const events: TelemetryInput[] = [];
  const registry: Record<symbol, unknown> = {};
  const load = (): LoadedConfig | Promise<LoadedConfig> =>
    loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify(config) });
  const extension = createExtension({
    env: options.env ?? { TYPESAFE_API_KEY: KEY },
    loadConfig: async () => load(),
    fetch: options.hang ? hangingFetch(jev, hung) : answeringFetch(jev),
    now: () => 0,
    newId: () => crypto.randomUUID(),
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry);
  const claimHost = () => (registry[CLAIM] as { host: { settled(): Promise<void>; statusText(): string } } | undefined)?.host;
  return { host, jev, hung, events, registry, claimHost, load: () => extension(host.api), loaded: load };
}


const SHADOW_OUT = { mode: "shadow", outbound: { taskIntent: true } };
const isModelEvent = (e: TelemetryInput) => String(e.kind) === "route_model" || String(e.source).startsWith("model:") || String(e.source).includes("model_candidates");

async function oneTask(s: ReturnType<typeof setup>, prompt = PROMPT) {
  await s.host.emit("session_start");
  const results = s.host.emitSync("before_agent_start", { prompt });
  await s.claimHost()?.settled();
  const status = s.claimHost()?.statusText() ?? "";
  await s.host.emit("session_shutdown");
  return { results, status };
}

// The shared config loader ignores router.models content; the OMP adapter must stay unaffected.
for (const [label, models] of [
  ["mode on + allow", { mode: "on", allow: ["p/a", "p/b"] }],
  ["legacy enabled true", { enabled: true, allow: ["p/a"] }],
  ["mode shadow, empty allow", { mode: "shadow" }],
] as const) {
  test(`T104 router.models (${label}) is ignored: same Jev traffic as tools-only, no model telemetry, no setter`, async () => {
    const base = setup(SHADOW_OUT);
    base.load();
    await oneTask(base);
    const s = setup({ ...SHADOW_OUT, router: { tools: "shadow", models } });
    assert.equal((await s.loaded()).source, "file", "config with router.models is accepted, not rejected");
    s.load();
    const { results, status } = await oneTask(s);
    assert.deepEqual(results, [undefined]);
    assert.deepEqual(s.host.setterCalls, []);
    assert.equal(s.jev.requests, base.jev.requests, "router.models must not add Jev requests");
    assert.ok(s.events.some((e) => e.kind === "route_tools"));
    assert.ok(!s.events.some(isModelEvent), JSON.stringify(s.events));
    assert.doesNotMatch(status, /model/i);
  });
}

test("T104 router.models alone (tools off) sends zero Jev requests and records nothing model-related", async () => {
  const s = setup({ ...SHADOW_OUT, effort: "off", router: { tools: "off", models: { mode: "on", allow: ["p/a", "p/b"] } } });
  s.load();
  await oneTask(s);
  assert.equal(s.jev.requests, 0);
  assert.ok(!s.events.some((e) => e.kind === "route_tools" || isModelEvent(e) || e.kind === "jev_attempt"), JSON.stringify(s.events));
});

test("T104 any router.models content (even {mode, enabled} together) is ignored: config valid, note added, adapter stays in configured mode", async () => {
  const base = setup(SHADOW_OUT);
  base.load();
  await oneTask(base);
  const s = setup({ ...SHADOW_OUT, router: { models: { mode: "on", enabled: true } } });
  const loaded = await s.loaded();
  assert.equal(loaded.source, "file");
  assert.ok(loaded.notes?.includes(MODEL_ROUTING_IGNORED_NOTE), JSON.stringify(loaded.notes));
  s.load();
  const { results, status } = await oneTask(s);
  assert.deepEqual(results, [undefined]);
  assert.match(status, /^Jev: shadow \(this session\)/);
  assert.doesNotMatch(status, /config: invalid/);
  assert.equal(s.jev.requests, base.jev.requests, "ignored router.models must not change Jev traffic");
  assert.ok(!s.events.some(isModelEvent), JSON.stringify(s.events));
  assert.deepEqual(s.host.setterCalls, []);
});

test("T104 outbound gate ON: route_tools recorded with jev_attempt, never applied", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  const { results } = await oneTask(s);
  assert.deepEqual(results, [undefined]);
  assert.ok(s.jev.requests > 0);
  const tools = s.events.filter((e) => e.kind === "route_tools");
  assert.equal(tools.length, 1, JSON.stringify(s.events));
  assert.match(String(tools[0]!.source), /^tools:/);
  assert.notEqual(tools[0]!.outcome, "withheld");
  assert.ok(s.events.some((e) => e.kind === "jev_attempt" && e.source === "jev:ok"), JSON.stringify(s.events));
  assert.deepEqual(s.host.setterCalls, []);
});

test("T104 outbound gate OFF: route_tools recorded as withheld, zero Jev", async () => {
  const s = setup({ mode: "shadow", outbound: { taskIntent: false } });
  s.load();
  await oneTask(s);
  assert.equal(s.jev.requests, 0);
  const tools = s.events.filter((e) => e.kind === "route_tools");
  assert.equal(tools.length, 1, JSON.stringify(s.events));
  assert.equal(tools[0]!.outcome, "withheld");
  assert.equal(tools[0]!.source, "outbound:not_authorized");
  assert.ok(!s.events.some((e) => e.kind === "jev_attempt"));
});

test("T104 credential gate: route_tools withheld, fallback noted in status", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  const { status } = await oneTask(s, `token ${KEY}`);
  assert.equal(s.jev.requests, 0);
  assert.deepEqual(s.events.filter((e) => e.kind === "route_tools").map((e) => [e.outcome, e.source]), [["withheld", "outbound:credential_detected"]]);
  assert.match(status, /credential detected/);
});

test("T104 per-task budget 0: zero Jev requests, route_tools still recorded", async () => {
  const s = setup({ ...SHADOW_OUT, budget: { maxRequestsPerTask: 0 } });
  s.load();
  await oneTask(s);
  assert.equal(s.jev.requests, 0);
  assert.equal(s.events.filter((e) => e.kind === "route_tools").length, 1, JSON.stringify(s.events));
});

test("T104 per-task budget 1 still allows the (single) tool request per task; budget resets per task", async () => {
  const s = setup({ ...SHADOW_OUT, budget: { maxRequestsPerTask: 1 } });
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  s.host.emitSync("before_agent_start", { prompt: PROMPT + " again" });
  await s.claimHost()?.settled();
  await s.host.emit("session_shutdown");
  assert.equal(s.jev.requests, 2, `one request per task under budget 1; requests=${s.jev.requests}`);
  assert.equal(s.events.filter((e) => e.kind === "route_tools").length, 2);
});

test("T104 wait budget aborts a hanging Jev request; route_tools unavailable, host not blocked", async () => {
  const s = setup({ ...SHADOW_OUT, budget: { waitMs: 30 }, jev: { timeoutMs: 60_000 } }, { hang: true });
  s.load();
  await s.host.emit("session_start");
  assert.deepEqual(s.host.emitSync("before_agent_start", { prompt: PROMPT }), [undefined]);
  await guard(s.hung.first, "first Jev request");
  await guard(s.claimHost()!.settled(), "wait budget");
  const status = s.claimHost()!.statusText();
  await s.host.emit("session_shutdown");
  assert.ok(s.hung.signals.length > 0 && s.hung.signals.every((sig) => sig.aborted));
  const tools = s.events.filter((e) => e.kind === "route_tools");
  assert.deepEqual(tools.map((e) => [e.outcome, e.source]), [["unavailable", "tools:unavailable"]]);
  assert.match(status, /tools: unavailable \(wait_budget\)/);
});

test("T104 shutdown aborts in-flight tool routing with reason shutdown", async () => {
  const s = setup(SHADOW_OUT, { hang: true });
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await guard(s.hung.first, "first Jev request");
  await guard(s.host.emit("session_shutdown"), "shutdown");
  assert.ok(s.hung.signals.every((sig) => sig.aborted && sig.reason === "shutdown"));
  assert.equal(s.events.filter((e) => e.kind === "route_tools").length, 1);
  assert.equal(s.registry[CLAIM], undefined);
});

test("T104 no-profile: only session_start + /jev registered, one no_profile diagnostic, no routing", async () => {
  const s = setup(SHADOW_OUT, { version: "18.3.4" });
  s.load();
  assert.deepEqual([...s.host.handlers.keys()], ["session_start"]);
  await s.host.emit("session_start");
  await s.host.emit("session_start");
  const status = s.claimHost()!.statusText();
  assert.equal(s.jev.requests, 0);
  assert.deepEqual(s.events.map((e) => e.source), ["adapter:no_profile", "adapter:no_profile"]);
  assert.match(status, /no profile/);
  assert.doesNotMatch(status, /model/i);
});

test("T104 duplicate load: second copy registers nothing, status reports it, routing runs once", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  const counts = [...s.host.handlers.values()].map((h) => h.length);
  const other = createExtension({}, s.registry as never);
  other(s.host.api);
  s.load();
  assert.deepEqual([...s.host.handlers.values()].map((h) => h.length), counts);
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  assert.match(s.claimHost()!.statusText(), /duplicate loads ignored: 2/);
  await s.host.emit("session_shutdown");
  assert.equal(s.events.filter((e) => e.kind === "route_tools").length, 1);
});
