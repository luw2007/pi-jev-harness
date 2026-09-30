/**
 * T106: provider-chain attempts reach telemetry, a one-time fallback notice, and /jev status.
 * Fake OMP host, fake Jev (injected fetch). No ~/.omp, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler } from "../../../../src/adapters/omp/types.ts";
import { sanitizeEvent } from "../../../../src/telemetry/writer.ts";

const KEY_A = "zz-fake-internal-key-T106-alpha";
const KEY_B = "zz-fake-typesafe-key-T106-beta";
const URL_A = "https://internal-t106.example.invalid/v1/secretpath";
const URL_B = "https://typesafe-t106.example.invalid/v1";
const SECRETS = [KEY_A, KEY_B, URL_A, URL_B, "internal-t106.example", "typesafe-t106.example", "secretpath"];

function fakeHost(options: { ui?: boolean }) {
  const view = { child: false };
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, (args: string, ctx: OmpContext) => unknown>();
  const notes: { message: string; level: string }[] = [];
  const statusNotes: string[] = [];
  const ui = { notify: (message: string, level: string) => { notes.push({ message, level }); } };
  const ctx = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => (view.child ? { parentSession: "parent" } : {}), getSessionId: () => "s-t106", getLeafId: () => "leaf", getBranch: () => [] },
    getContextUsage: () => ({ percent: null }),
    ...(options.ui === false ? {} : { ui }),
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: () => {},
  } as unknown as OmpContext;
  const statusCtx = { ...ctx, ui: { notify: (m: string) => { statusNotes.push(m); } } } as unknown as OmpContext;
  const api = {
    pi: { VERSION: "18.4.1" },
    on: (event: string, handler: OmpHandler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name: string, o: { handler: (args: string, ctx: OmpContext) => unknown }) => { commands.set(name, o.handler); },
    registerTool: () => {},
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["read"],
    getCommands: () => [],
    getThinkingLevel: () => undefined,
    setActiveTools: async () => {},
    setModel: () => true,
    setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  const status = async () => {
    statusNotes.length = 0;
    await commands.get("jev")!("status", statusCtx);
    return statusNotes.join("\n");
  };
  const command = async (args: string) => { await commands.get("jev")!(args, statusCtx); };
  return { api, emit, status, command, notes, view };
}

type Step = number | "network" | (() => Promise<number>);

function setup(mode: string, options: { ui?: boolean } = {}) {
  const host = fakeHost(options);
  const plan: Record<"a" | "b", Step> = { a: 200, b: 200 };
  const events: unknown[] = [];
  const fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const step = plan[String(input) === URL_A ? "a" : "b"];
    if (step === "network") throw new TypeError("fetch failed");
    if (typeof step === "function") return withStatus(init, await step());
    return withStatus(init, step);
  }) as typeof globalThis.fetch;
  const withStatus = (init: { body?: unknown } | undefined, step: number) => {
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      const rest = 0.3 / (options.length - 1);
      return [id, { type: "choice", choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: step, headers: { "content-type": "application/json" } });
  };
  const config = {
    mode, effort: "off", outbound: { taskIntent: true }, router: { tools: "shadow" }, budget: { maxRequestsPerTask: 10, waitMs: 5000 },
    jev: { providers: [
      { id: "internal", url: URL_A, model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "FAKE_T106_A" },
      { id: "typesafe", url: URL_B, model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "FAKE_T106_B" },
    ] },
  };
  const overrides: Partial<OmpHostDeps> = {
    env: { FAKE_T106_A: KEY_A, FAKE_T106_B: KEY_B },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify(config) }),
    fetch,
    createTelemetry: () => ({ record: async (e: unknown) => { events.push(e); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
  };
  const registry = {};
  createExtension(overrides, registry)(host.api);
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  const task = async (prompt = "List the files in src") => {
    await host.emit("before_agent_start", { prompt });
    await claim.settled();
  };
  return { host, plan, events, task };
}

type ChainEvent = { outcome: string; durationMs: number; chain: Record<string, unknown> };
const chainEvents = (events: unknown[]) => events.filter((e) => (e as { chain?: unknown }).chain) as ChainEvent[];
const noSecrets = (text: string) => { for (const s of SECRETS) assert.ok(!text.includes(s), `leaked ${s} in ${text}`); };

test("telemetry: each chain step records providerId, outcome, fellBack, httpStatus, durationMs; sanitizer keeps them", async () => {
  const s = setup("shadow");
  s.plan.a = 503;
  await s.host.emit("session_start");
  await s.task();
  const steps = chainEvents(s.events);
  const fb = steps.find((e) => e.chain.providerId === "internal")!;
  assert.deepEqual(fb.chain, { providerId: "internal", outcome: "http_error", fellBack: true, httpStatus: 503 });
  assert.equal(fb.outcome, "fallback");
  assert.equal(typeof fb.durationMs, "number");
  const ok = steps.find((e) => e.chain.providerId === "typesafe")!;
  assert.deepEqual(ok.chain, { providerId: "typesafe", outcome: "ok", fellBack: false });
  assert.deepEqual((sanitizeEvent(fb, 1) as { chain?: unknown }).chain, fb.chain);
  assert.equal((sanitizeEvent({ ...fb, chain: { ...fb.chain, providerId: URL_A } }, 1) as { chain?: unknown }).chain, undefined);
  noSecrets(JSON.stringify(s.events));
  await s.host.emit("session_shutdown");
});

test("first fallback notifies once; repeated failures don't; recover-then-fail notifies again; status line", async () => {
  const s = setup("shadow");
  s.plan.a = "network";
  await s.host.emit("session_start");
  await s.task();
  assert.deepEqual(s.host.notes, [{ message: "Jev：internal 不可用（network_error），已回退到 typesafe", level: "warning" }]);
  await s.task("Another task please");
  await s.task("Third task please");
  assert.equal(s.host.notes.length, 1);
  s.plan.a = 200;
  await s.task("Recovered task");
  assert.equal(s.host.notes.length, 1);
  s.plan.a = 500;
  await s.task("Fails again");
  assert.equal(s.host.notes.length, 2);
  assert.equal(s.host.notes[1]!.message, "Jev：internal 不可用（http_error 500），已回退到 typesafe");
  const status = await s.host.status();
  assert.match(status, /Jev provider chain: last answered typesafe; fallbacks this session: 4; last fallback: internal: http_error 500/);
  assert.match(status, /fallback reasons \(adapter\/tool routing\): /);
  noSecrets(status);
  for (const n of s.host.notes) noSecrets(n.message);
  noSecrets(JSON.stringify(s.events));
  await s.host.emit("session_shutdown");
});

test("all providers fail: one notice per session until a provider answers", async () => {
  const s = setup("shadow");
  s.plan.a = 503;
  s.plan.b = 502;
  await s.host.emit("session_start");
  await s.task();
  await s.task("again");
  assert.deepEqual(s.host.notes.map((n) => n.message), ["Jev：所有 provider 均不可用（internal: http_error 503; typesafe: http_error 502），本次跳过"]);
  s.plan.b = 200;
  await s.task("recovers");
  s.plan.b = 502;
  await s.task("down again");
  assert.equal(s.host.notes.filter((n) => n.message.includes("所有 provider")).length, 2);
  for (const n of s.host.notes) noSecrets(n.message);
  await s.host.emit("session_shutdown");
});

test("no ctx.ui: fallback does not throw", async () => {
  const s = setup("shadow", { ui: false });
  s.plan.a = 503;
  await s.host.emit("session_start");
  await s.task();
  assert.equal(chainEvents(s.events).length, 2);
  await s.host.emit("session_shutdown");
});

/** internal answers 503 only when released, so the fallback lands after `between` ran. */
async function fallbackAfter(between: (s: ReturnType<typeof setup>) => Promise<void>) {
  const s = setup("shadow");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  s.plan.a = async () => { await held; return 503; };
  await s.host.emit("session_start");
  const running = s.task();
  await new Promise((r) => setTimeout(r, 10));
  await between(s);
  release();
  await running;
  const steps = chainEvents(s.events).map((e) => `${e.chain.providerId}:${e.chain.outcome}`);
  await s.host.emit("session_shutdown");
  return { notes: s.host.notes, steps };
}

test("gate control: the same held fallback does notify when nothing changes", async () => {
  const out = await fallbackAfter(async () => {});
  assert.deepEqual(out.steps, ["internal:http_error", "typesafe:ok"]);
  assert.equal(out.notes.length, 1);
});

test("mode switched off while a call is falling back: Jev was called, no notice", async () => {
  const out = await fallbackAfter(async (s) => { await s.host.command("mode off"); });
  // Mode off aborts the in-flight call; the notice gate is the second line of defence.
  assert.ok(out.steps.length >= 1, JSON.stringify(out.steps));
  assert.deepEqual(out.notes, []);
});

test("child session active when the fallback lands: Jev was called, no notice", async () => {
  const out = await fallbackAfter(async (s) => {
    s.host.view.child = true;
    await s.host.emit("tool_result", {});
  });
  assert.ok(out.steps.includes("internal:http_error"), JSON.stringify(out.steps));
  assert.deepEqual(out.notes, []);
});
