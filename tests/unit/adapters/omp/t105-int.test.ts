/**
 * integration: C9 provider chain wired into the OMP adapter (config chain, legacy
 * jev-providers.json mapping, single-url fallback), chain secrets in the credential scan, one
 * unit per chain call, jev_plan off, loadMode essential, and the /jev status capability line.
 * Fake OMP host, fake Jev (injected fetch), injected legacy file reader. No ~/.omp, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";
import { createJevAccess } from "../../../../src/adapters/shared/jev-access.ts";
import { defaultConfig } from "../../../../src/adapters/shared/config.ts";

const ENOENT = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
const LEGACY = readFileSync(new URL("../../../fixtures/jev-providers.legacy.json", import.meta.url), "utf8");
const PROMPT = "List the files in src";

function fakeHost() {
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { name: string; source: "extension"; description?: string; handler?: (args: string, ctx: OmpContext) => unknown }>();
  const tools = new Map<string, OmpToolDefinition>();
  const notes: string[] = [];
  const ctx = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getSessionId: () => "s-int", getLeafId: () => "leaf", getBranch: () => [] },
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
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: OmpContext) => unknown }) => {
      commands.set(name, { name, source: "extension", description: options.description, handler: options.handler });
    },
    registerTool: (tool: OmpToolDefinition) => { tools.set(tool.name, tool); },
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["read"],
    getCommands: () => [...commands.values()].map(({ name, source, description }) => ({ name, source, description })),
    getThinkingLevel: () => undefined,
    setActiveTools: async () => {},
    setModel: () => true,
    setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  const status = async () => {
    notes.length = 0;
    await commands.get("jev")!.handler!("status", ctx);
    return notes.join("\n");
  };
  return { api, ctx, tools, emit, status };
}

function setup(config: Record<string, unknown>, options: { env?: Record<string, string>; legacy?: string | "missing" | "none"; status?: (url: string) => number } = {}) {
  const host = fakeHost();
  const urls: string[] = [];
  const fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    urls.push(url);
    const body = JSON.parse(String(init?.body)) as { model: string };
    return new Response(JSON.stringify({ model: body.model, answers: {} }), { status: options.status?.(url) ?? 503 });
  }) as typeof globalThis.fetch;
  const env = { TYPESAFE_API_KEY: "fake-typesafe-key-int", ...options.env };
  const legacyPath = "/fake/omp/agent/jev-providers.json";
  const overrides: Partial<OmpHostDeps> = {
    env,
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify({ effort: "off", ...config }) }),
    fetch,
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
    ...(options.legacy === "none" ? {} : { legacyProvidersPath: legacyPath }),
    readFile: (path: string) => {
      if (path === legacyPath && options.legacy !== "missing" && options.legacy !== undefined) return options.legacy;
      return ENOENT();
    },
  };
  const registry = {};
  createExtension(overrides, registry)(host.api);
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  return { host, urls, settled: () => claim.settled() };
}

const SHADOW = { mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow" } };
const CHAIN = {
  providers: [
    { id: "alpha", url: "https://alpha.example.invalid/v1", model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "FAKE_ALPHA_KEY" },
    { id: "beta", url: "https://beta.example.invalid/v1", model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "FAKE_BETA_KEY" },
  ],
};

test("config jev.providers: routing falls back alpha -> beta as one unit of the per-task counter; status names the chain", async () => {
  const s = setup({ ...SHADOW, budget: { maxRequestsPerTask: 1, waitMs: 2000 }, jev: CHAIN }, { env: { FAKE_ALPHA_KEY: "fake-alpha-secret-1", FAKE_BETA_KEY: "fake-beta-secret-2" } });
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  await s.settled();
  assert.ok(s.urls.length >= 2, JSON.stringify(s.urls));
  assert.equal(s.urls[0], "https://alpha.example.invalid/v1");
  assert.equal(s.urls[1], "https://beta.example.invalid/v1");
  const status = await s.host.status();
  assert.match(status, /jev providers=alpha -> beta source=config/);
  assert.match(status, /capabilities: route=shadow \(config\)[\s\S]*jev=config \(config\)/);
  assert.doesNotMatch(status, /fake-(alpha|beta)-secret/);
  await s.host.emit("session_shutdown");
});

test("a chain key in the prompt is withheld: zero Jev requests", async () => {
  const s = setup({ ...SHADOW, jev: CHAIN }, { env: { FAKE_ALPHA_KEY: "fake-alpha-secret-1", FAKE_BETA_KEY: "fake-beta-secret-2" } });
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: `${PROMPT} with fake-beta-secret-2` });
  await s.settled();
  assert.deepEqual(s.urls, []);
  assert.match(await s.host.status(), /credential detected/);
  await s.host.emit("session_shutdown");
});

test("OMP without jev.providers: the legacy jev-providers.json maps read-only; source shown in status", async () => {
  const s = setup(SHADOW, { legacy: LEGACY });
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  await s.settled();
  assert.equal(s.urls[0], "https://jev.example.invalid/v1/systemone");
  const status = await s.host.status();
  assert.match(status, /jev providers=internal -> typesafe -> openrouter source=legacy:\/fake\/omp\/agent\/jev-providers\.json/);
  assert.match(status, /jev chain compact: typesafe -> openrouter/);
  assert.match(status, /jev=legacy \(\/fake\/omp\/agent\/jev-providers\.json\)/);
  await s.host.emit("session_shutdown");
});

test("OMP legacy file absent or invalid: single-url client on jev.url", async () => {
  for (const legacy of ["missing", "{not json"] as const) {
    const s = setup({ ...SHADOW, jev: { url: "https://single.example.invalid/decide" } }, { legacy });
    await s.host.emit("session_start");
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    await s.settled();
    assert.ok(s.urls.length > 0 && s.urls.every((url) => url === "https://single.example.invalid/decide"), JSON.stringify(s.urls));
    const status = await s.host.status();
    assert.match(status, /jev providers=typesafe source=single-url/);
    assert.match(status, legacy === "missing" ? /absent \(single-url\)/ : /invalid; ignored \(single-url\)/);
    await s.host.emit("session_shutdown");
  }
});

test("jev_plan and jev_recall are essential; jev_plan in mode off says so with zero Jev requests", async () => {
  const s = setup({ mode: "off", outbound: { taskIntent: true } });
  await s.host.emit("session_start");
  assert.equal(s.host.tools.get("jev_plan")?.loadMode, "essential");
  assert.equal(s.host.tools.get("jev_recall")?.loadMode, "essential");
  const result = await s.host.tools.get("jev_plan")!.execute("t1", { task: "split the refactor" }, undefined, undefined, s.host.ctx);
  assert.match(result.content[0]!.text, /pi-jev-harness is off/);
  assert.deepEqual(s.urls, []);
  await s.host.emit("session_shutdown");
});

test("status shows every capability's effective state and source", async () => {
  const s = setup({ mode: "on", outbound: { taskIntent: true }, router: { tools: "shadow" }, approval: { enabled: true } });
  await s.host.emit("session_start");
  const line = (await s.host.status()).split("\n").find((l) => l.startsWith("capabilities: "))!;
  for (const name of ["route", "enforce", "approval", "acceptance", "autorun", "context", "compaction", "proactive", "effort", "plan", "jev"])
    assert.match(line, new RegExp(`\\b${name}=\\S+ \\(`), name);
  assert.match(line, /approval=on \(config\)/);
  assert.match(line, /effort=off \(config\)/);
  await s.host.emit("session_shutdown");
});

test("Pi (no legacy path): single-url unless jev.providers is configured", () => {
  const base = defaultConfig("/h");
  const env = { TYPESAFE_API_KEY: "fake-typesafe-key-int", FAKE_ALPHA_KEY: "fake-alpha-secret-1" };
  assert.equal(createJevAccess({ config: base, env }).source.kind, "single-url");
  const chained = createJevAccess({ config: { ...base, jev: { ...base.jev, chain: CHAIN as never } }, env });
  assert.equal(chained.source.kind, "config");
  assert.deepEqual([...chained.secrets].sort(), ["fake-alpha-secret-1", "fake-typesafe-key-int"]);
  assert.equal(chained.available("route"), true);
});

test("OMP legacy file with inline api-key: chain source, key only in secrets, never in status", () => {
  const KEY = "sk-FAKEACCESSKEY-0123456789";
  const raw = JSON.stringify({ schemaVersion: 1, default: "internal", fallback: ["typesafe"],
    providers: { internal: { url: "https://internal.test/v1", model: "jev-internal", "api-key": KEY } } });
  const access = createJevAccess({ config: defaultConfig("/h"), env: {}, legacyProvidersPath: "/legacy.json",
    readFile: () => raw, fileMode: () => 0o100644 });
  assert.equal(access.source.kind, "legacy");
  assert.ok(access.secrets.includes(KEY));
  const status = access.statusLines().join("\n");
  assert.match(status, /providers=internal -> typesafe/);
  assert.match(status, /looser than 0600/);
  assert.equal(status.includes(KEY), false);
  const bad = createJevAccess({ config: defaultConfig("/h"), env: {}, legacyProvidersPath: "/legacy.json",
    readFile: () => raw.replace('"api-key"', '"apiKeyEnv":"X","api-key"'), fileMode: () => 0o100600 });
  const badStatus = bad.statusLines().join("\n");
  assert.match(badStatus, /mutually exclusive/);
  assert.equal(badStatus.includes(KEY), false);
});
