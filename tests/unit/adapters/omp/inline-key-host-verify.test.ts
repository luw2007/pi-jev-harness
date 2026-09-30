/**
 * Verifier: legacy inline key through the real OMP entry point (createExtension). Fake host, fake
 * Jev fetch, captured telemetry and audit, injected legacy reader. No ~/.omp, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";

const KEY = "FAKEINLINEhost5Qx8Zr2Mv7Kp3";
const TS_KEY = "FAKETSHOSTkey9911bb";
const LEGACY_PATH = "/fake/omp/agent/jev-providers.json";
const legacyFile = (field: string) => JSON.stringify({ schemaVersion: 1, default: "internal", fallback: ["typesafe"],
  providers: { internal: { url: "https://internal.example.invalid/v1", model: "bjev", [field]: KEY } } });

function setup(legacy: string, internal: "throw" | "503") {
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: OmpContext) => unknown }>();
  const tools = new Map<string, OmpToolDefinition>();
  const notes: string[] = [];
  const ctx = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getSessionId: () => "s-inline", getLeafId: () => "leaf", getBranch: () => [] },
    getContextUsage: () => ({ percent: null }),
    ui: { notify: (message: string) => { notes.push(message); } },
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: () => {},
  } as unknown as OmpContext;
  const api = {
    pi: { VERSION: "18.4.1" },
    on: (event: string, handler: OmpHandler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: OmpContext) => unknown }) => { commands.set(name, options); },
    registerTool: (tool: OmpToolDefinition) => { tools.set(tool.name, tool); },
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["read"],
    getCommands: () => [...commands.entries()].map(([name, c]) => ({ name, source: "extension", description: c.description })),
    getThinkingLevel: () => undefined,
    setActiveTools: async () => {},
    setModel: () => true,
    setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  const calls: { host: string; auth: string | null }[] = [];
  const errors: string[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const host = new URL(String(input)).host;
    calls.push({ host, auth: new Headers(init?.headers).get("authorization") });
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (host === "internal.example.invalid") {
      if (internal === "throw") {
        const message = `fetch failed ${JSON.stringify(init?.headers)}`;
        errors.push(message);
        throw new TypeError(message);
      }
      return new Response(`denied ${KEY}`, { status: 503 });
    }
    return new Response(JSON.stringify({ model: body.model, answers: {} }), { status: 200 });
  }) as typeof globalThis.fetch;
  const telemetry: unknown[] = [];
  const audit: unknown[] = [];
  const overrides: Partial<OmpHostDeps> = {
    env: { TYPESAFE_API_KEY: TS_KEY },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {},
      readText: async () => JSON.stringify({ effort: "off", mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow" } }) }),
    fetch,
    createTelemetry: () => ({ record: async (event) => { telemetry.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: () => ({ record: async (input) => { audit.push(input); return true; }, flush: async () => {}, diagnostics: () => ({}) as never }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
    legacyProvidersPath: LEGACY_PATH,
    readFile: (path: string) => {
      if (path === LEGACY_PATH) return legacy;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  const registry = {};
  createExtension(overrides, registry)(api);
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  const status = async () => {
    notes.length = 0;
    await commands.get("jev")!.handler("status", ctx);
    return notes.join("\n");
  };
  return { emit, status, tools, ctx, calls, errors, telemetry, audit, settled: () => claim.settled() };
}

for (const [field, internal] of [["apiKey", "throw"], ["api-key", "503"]] as const) {
  test(`host: ${field}, internal ${internal} -> typesafe; key only to internal; absent from status/telemetry/audit`, async () => {
    const s = setup(legacyFile(field), internal);
    await s.emit("session_start");
    await s.emit("before_agent_start", { prompt: "List the files in src" });
    await s.settled();
    const plan = await s.tools.get("jev_plan")!.execute("t1", { task: "split the refactor" }, undefined, undefined, s.ctx);
    await s.settled();
    assert.ok(s.calls.length >= 2, JSON.stringify(s.calls.map((c) => c.host)));
    assert.equal(s.calls[0]!.host, "internal.example.invalid");
    for (const call of s.calls) {
      if (call.host === "internal.example.invalid") assert.equal(call.auth, `Bearer ${KEY}`);
      else assert.equal(call.auth, `Bearer ${TS_KEY}`, `${call.host} must not get the inline key`);
    }
    assert.ok(s.calls.some((c) => c.host !== "internal.example.invalid"), "typesafe was tried");
    if (internal === "throw") assert.ok(s.errors.some((e) => e.includes(KEY)), "the fake error did echo the key");
    const status = await s.status();
    assert.match(status, /jev providers=internal -> typesafe source=legacy:/);
    await s.emit("session_shutdown");
    await s.settled();
    for (const [label, value] of [["status", status], ["telemetry", s.telemetry], ["audit", s.audit], ["jev_plan result", plan]] as const) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      assert.equal(text.includes(KEY), false, `${label} leaked the key`);
    }
    assert.ok(s.telemetry.length > 0, "telemetry was captured");
  });
}

test("host: inline key in the prompt is withheld with zero Jev requests", async () => {
  const s = setup(legacyFile("api-key"), "503");
  await s.emit("session_start");
  await s.emit("before_agent_start", { prompt: `List the files, token ${KEY}` });
  await s.settled();
  assert.deepEqual(s.calls, []);
  const status = await s.status();
  assert.match(status, /credential detected/);
  assert.equal(status.includes(KEY), false);
  await s.emit("session_shutdown");
  assert.equal(JSON.stringify([s.telemetry, s.audit]).includes(KEY), false);
});

test("host: conflicting spellings fall back to single-url with a key-free note", async () => {
  const raw = legacyFile("apiKey").replace('"apiKey"', `"api-key":"${KEY}","apiKey"`);
  const s = setup(raw, "503");
  await s.emit("session_start");
  const status = await s.status();
  assert.match(status, /both apiKey and api-key set/);
  assert.match(status, /jev providers=typesafe source=single-url/);
  assert.equal(status.includes(KEY), false);
  await s.emit("session_shutdown");
});
