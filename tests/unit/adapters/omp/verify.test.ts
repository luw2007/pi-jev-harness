/**
 * Verifier edge cases for the OMP adapter, against a fake OMP host.
 * Covers: outbound default, non-blocking event path, telemetry privacy, credential withholding,
 * profile edge inputs, schema conversion edge inputs, /jev mode guards, reload after shutdown.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { detectProfile } from "../../../../src/adapters/omp/profile.ts";
import { hostToolsFromOmp, ompToolSchema } from "../../../../src/adapters/omp/tools.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpModel } from "../../../../src/adapters/omp/types.ts";
import type { LoadedConfig } from "../../../../src/adapters/shared/index.ts";
import { snapshotToolCatalog } from "../../../../src/router/index.ts";
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
  const commands = new Map<string, { (args: string, ctx: OmpContext): unknown; description?: string }>();
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
    registerCommand(name, options) { Object.assign(options.handler, { description: options.description }); commands.set(name, options.handler); },
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
    loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify({ effort: "off", ...config }) /* C12 effort (L6) off: these count C1–C3 traffic */ });
  const extension = createExtension({
    env: options.env ?? { TYPESAFE_API_KEY: KEY },
    loadConfig: async () => load(),
    fetch: options.hang ? hangingFetch(jev, hung) : answeringFetch(jev),
    now: () => 0,
    newId: () => crypto.randomUUID(),
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry);
  const claimHost = () => (registry[CLAIM] as { host: { settled(): Promise<void>; statusText(): string } } | undefined)?.host;
  return { host, jev, hung, events, registry, claimHost, load: () => extension(host.api) };
}

const SHADOW_OUT = { mode: "shadow", outbound: { taskIntent: true } };

test("shadow with default outbound (taskIntent unset): zero Jev requests, only withheld telemetry", async () => {
  const s = setup({ mode: "shadow" });
  s.load();
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  await s.host.emit("session_shutdown");
  assert.equal(s.jev.requests, 0);
  assert.ok(s.events.length > 0);
  assert.ok(s.events.every((event) => event.outcome === "withheld" && event.source === "outbound:not_authorized"), JSON.stringify(s.events));
  assert.deepEqual(s.host.setterCalls, []);
});

test("before_agent_start returns undefined synchronously while Jev hangs; shutdown aborts in-flight work", async () => {
  const s = setup(SHADOW_OUT, { hang: true });
  s.load();
  await s.host.emit("session_start");
  const results = s.host.emitSync("before_agent_start", { prompt: PROMPT });
  assert.deepEqual(results, [undefined], "handler must not return a promise");
  // Wait for the async routing to reach the hanging fetch (event-driven, no sleep).
  await guard(s.hung.first, "first Jev request");
  assert.ok(s.jev.requests > 0, "shadow started a Jev request");
  assert.ok(s.hung.signals.length > 0 && s.hung.signals.every((signal) => !signal.aborted), "request is in flight");
  const stop = s.host.emitSync("session_stop");
  assert.deepEqual(stop, [undefined], "session_stop must not block or continue");
  await guard(s.host.emit("session_shutdown"), "session_shutdown");
  assert.ok(s.hung.signals.every((signal) => signal.aborted && signal.reason === "shutdown"), "shutdown must abort the hanging Jev request");
  assert.deepEqual(s.host.setterCalls, []);
  assert.equal(s.registry[CLAIM], undefined, "claim released on shutdown");
});

test("telemetry carries no task text and no Jev key", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  await s.host.emit("session_shutdown");
  assert.ok(s.jev.requests > 0);
  const text = JSON.stringify(s.events);
  assert.ok(!text.includes("very-unique-task-text-marker"), text);
  assert.ok(!text.includes(KEY), text);
});

test("credential in the prompt: Jev request withheld", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: `use token = ${"x".repeat(12)} and ${KEY}` });
  await s.claimHost()?.settled();
  await s.host.emit("session_shutdown");
  assert.equal(s.jev.requests, 0);
  assert.ok(s.events.every((event) => event.source === "outbound:credential_detected"), JSON.stringify(s.events));
});

test("no Jev key: shadow sends zero requests", async () => {
  const s = setup(SHADOW_OUT, { env: {} });
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  await s.host.emit("session_shutdown");
  assert.equal(s.jev.requests, 0);
});

test("before_agent_start before session_start is a no-op", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  assert.deepEqual(s.host.emitSync("before_agent_start", { prompt: PROMPT }), [undefined]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.jev.requests, 0);
});

test("config mode \"on\" in the file is honored by the OMP adapter (T105 L2); router.tools shadow leaves the host untouched", async () => {
  const s = setup({ ...SHADOW_OUT, mode: "on" });
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  assert.ok(s.jev.requests > 0, "mode on observes tool routing like shadow");
  assert.match(s.claimHost()!.statusText(), /^Jev: on/);
  assert.deepEqual(s.host.setterCalls, []);
  await s.host.emit("session_shutdown");
});

test("T104: no model routing; status has no models line", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  await s.host.emit("session_start");
  s.host.emitSync("before_agent_start", { prompt: PROMPT });
  await s.claimHost()?.settled();
  assert.doesNotMatch(s.claimHost()!.statusText(), /models/);
  await s.host.emit("session_shutdown");
  assert.ok(s.events.every((event) => String(event.kind) !== "route_model" && !String(event.source).startsWith("model:")), JSON.stringify(s.events));
  assert.deepEqual(s.host.setterCalls, []);
});

test("/jev mode guards: no profile or invalid config cannot switch to shadow", async () => {
  const noProfile = setup(SHADOW_OUT, { version: "18.3.4" });
  noProfile.load();
  assert.deepEqual([...noProfile.host.handlers.keys()], ["session_start"]);
  await noProfile.host.commands.get("jev")!("mode shadow", noProfile.host.ctx);
  assert.match(noProfile.host.notes.at(-1)!, /no active session/);
  await noProfile.host.emit("session_start");
  await noProfile.host.commands.get("jev")!("mode shadow", noProfile.host.ctx);
  assert.match(noProfile.host.notes.at(-1)!, /below minimum supported version 18\.3\.5; staying off/);
  await noProfile.host.commands.get("jev")!("status", noProfile.host.ctx);
  assert.match(noProfile.host.notes.at(-1)!, /no profile .*18\.3\.4.*all capabilities off/);

  const s = setup(SHADOW_OUT);
  const brokenHost = s.host;
  const extension = createExtension({
    env: { TYPESAFE_API_KEY: KEY },
    loadConfig: () => loadOmpConfig({ home: "/h", path: "/x", env: {}, readText: async () => "{broken" }),
    fetch: answeringFetch(s.jev),
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, {});
  extension(brokenHost.api);
  await brokenHost.emit("session_start");
  await brokenHost.commands.get("jev")!("mode shadow", brokenHost.ctx);
  assert.match(brokenHost.notes.at(-1)!, /config invalid.*staying off/);
  brokenHost.emitSync("before_agent_start", { prompt: PROMPT });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.jev.requests, 0);
  assert.deepEqual(brokenHost.setterCalls, []);
});

test("detectProfile: 18.3.5 is the minimum supported stable version", () => {
  const throwing = { get pi(): { VERSION?: unknown } { throw new Error("boom"); } } as unknown as OmpExtensionAPI;
  assert.equal(detectProfile(throwing).spec, undefined);
  for (const version of ["18.3.4", "17.99.99", "18.3.5 ", "v18.3.5", "18.3.6-beta.1", "18.3", "", "toString", "__proto__", "constructor", 18.35, null]) {
    const profile = detectProfile({ pi: { VERSION: version } } as unknown as OmpExtensionAPI);
    assert.equal(profile.spec, undefined, `version ${String(version)}`);
    assert.ok(profile.reason);
  }
  for (const version of ["18.3.5", "18.3.6", "18.4.0", "19.0.0", "99.0.0"]) {
    const profile = detectProfile({ pi: { VERSION: version } } as unknown as OmpExtensionAPI);
    assert.deepEqual(profile.spec?.events, ["session_start", "before_agent_start", "session_stop", "session_shutdown", "tool_call", "tool_result", "message_end", "input", "context", "agent_end"], version);
    assert.ok(!profile.spec!.events.includes("agent_before_settle"));
  }
});

test("ompToolSchema: toJsonSchema returning a non-object is treated as opaque (null), not dropped", () => {
  // Doc comment: "Anything unconvertible becomes `null`, which the router treats as an opaque schema instead of dropping the tool."
  for (const returned of [undefined, "not-a-schema", 42]) {
    const parameters = Object.assign(() => {}, { toJsonSchema: () => returned });
    const catalog = snapshotToolCatalog(hostToolsFromOmp([{ name: "read", description: "Read", parameters }], ["read"]));
    assert.deepEqual(catalog.availableIds, ["read"], `toJsonSchema() => ${String(returned)} must not drop the tool`);
  }
});

test("reload after session_shutdown on the same host: handlers are not registered twice", async () => {
  const s = setup(SHADOW_OUT);
  s.load();
  await s.host.emit("session_start");
  await s.host.emit("session_shutdown");
  // Claim was released on shutdown; a second factory call on the same runner re-registers.
  s.load();
  const counts = Object.fromEntries([...s.host.handlers].map(([name, list]) => [name, list.length]));
  assert.deepEqual(counts, { session_start: 1, before_agent_start: 1, session_stop: 1, session_shutdown: 1, tool_call: 1, tool_result: 1, message_end: 1, input: 1, context: 1, agent_end: 1 });
});
