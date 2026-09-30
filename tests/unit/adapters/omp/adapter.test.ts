/**
 * OMP adapter against a fake OMP host (shapes from omp/18.3.5, see src/adapters/omp/types.ts).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOmpConfig, ompHarnessDir, ompProvidersPath } from "../../../../src/adapters/omp/config.ts";
import { defaultOmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { detectProfile } from "../../../../src/adapters/omp/profile.ts";
import { ompToolSchema } from "../../../../src/adapters/omp/tools.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpModel } from "../../../../src/adapters/omp/types.ts";
import type { LoadedConfig } from "../../../../src/adapters/shared/index.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

const MODELS: OmpModel[] = [
  { provider: "p", id: "a", reasoning: true, contextWindow: 200_000 },
  { provider: "p", id: "b", reasoning: false, contextWindow: 200_000 },
];

interface FakeHost {
  api: OmpExtensionAPI;
  ctx: OmpContext;
  handlers: Map<string, OmpHandler[]>;
  commands: string[];
  setterCalls: string[];
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

function fakeHost(version: unknown): FakeHost {
  const handlers = new Map<string, OmpHandler[]>();
  const commandMap = new Map<string, { name: string; source: "extension"; description?: string }>();
  const commands: string[] = [];
  const setterCalls: string[] = [];
  const ctx: OmpContext = {
    model: MODELS[0],
    modelRegistry: { getAvailable: () => MODELS, hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getBranch: () => [] },
    getContextUsage: () => ({ tokens: 100 }),
    ui: { notify: () => {} },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: version },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, options) {
      commands.push(name);
      commandMap.set(name, { name, source: "extension", description: options?.description });
    },
    getCommands: () => [...commandMap.values()],
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
  return {
    api, ctx, handlers, commands, setterCalls,
    async emit(event, payload = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
      return results;
    },
  };
}

function loaded(config: Record<string, unknown>): Promise<LoadedConfig> {
  return loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify(config) });
}

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

/** Jev fake answering every question with its first option; counts requests. */
function fakeJev() {
  const state = { requests: 0 };
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    state.requests++;
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      const rest = 0.3 / (options.length - 1);
      return [id, { type: "choice", choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

interface Setup {
  host: FakeHost;
  jev: ReturnType<typeof fakeJev>;
  events: TelemetryInput[];
  registry: object;
  load: () => void;
}

function setup(config: Record<string, unknown> | (() => Promise<LoadedConfig>), options: { version?: unknown } = {}): Setup {
  const host = fakeHost("version" in options ? options.version : "18.3.5");
  const jev = fakeJev();
  const events: TelemetryInput[] = [];
  const registry = {};
  const extension = createExtension({
    env: { TYPESAFE_API_KEY: "test-key" },
    loadConfig: typeof config === "function" ? config : () => loaded(config),
    fetch: jev.fetch,
    now: () => 0,
    newId,
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry);
  return { host, jev, events, registry, load: () => extension(host.api) };
}

const SHADOW = { mode: "shadow", outbound: { taskIntent: true } };

async function runTask(s: Setup) {
  await s.host.emit("session_start");
  const results = await s.host.emit("before_agent_start", { prompt: "List the files in src", images: [] });
  await s.host.emit("session_stop", { signal: new AbortController().signal });
  // Wait for async routing to finish, then shut down.
  const status = () => (s.registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")];
  await status()?.host.settled();
  await s.host.emit("session_shutdown");
  return results;
}

test("off (default): zero Jev requests, no telemetry", async () => {
  const s = setup({});
  s.load();
  await runTask(s);
  assert.equal(s.jev.state.requests, 0);
  assert.deepEqual(s.events, []);
});

test("shadow: asks Jev, records telemetry, calls no setter and returns nothing", async () => {
  const s = setup(SHADOW);
  s.load();
  const results = await runTask(s);
  assert.ok(s.jev.state.requests > 0);
  assert.deepEqual(s.host.setterCalls, []);
  assert.ok(results.every((result) => result === undefined));
  const kinds = s.events.map((event) => String(event.kind));
  assert.ok(kinds.includes("route_tools") && !kinds.includes("route_model"), JSON.stringify(kinds));
});

test("profile 18.3.5 registers exactly one stop path (session_stop, never agent_before_settle)", () => {
  const s = setup(SHADOW);
  s.load();
  assert.deepEqual([...s.host.handlers.keys()].sort(), ["session_start", "before_agent_start", "session_stop", "session_shutdown", "tool_call", "tool_result", "message_end", "input", "context", "agent_end"].sort());
  for (const list of s.host.handlers.values()) assert.equal(list.length, 1);
});

test("unsupported profile: capabilities off, only session_start registered, one no_profile diagnostic", async () => {
  for (const version of ["18.3.4", undefined]) {
    const s = setup(SHADOW, { version });
    s.load();
    assert.deepEqual([...s.host.handlers.keys()], ["session_start"]);
    assert.deepEqual(s.host.commands, ["jev"]);
    await runTask(s);
    assert.equal(s.jev.state.requests, 0);
    assert.deepEqual(s.events.map((e) => [e.kind, e.source]), [["diagnostic", "adapter:no_profile"]]);
    const profile = detectProfile(s.host.api);
    assert.equal(profile.spec, undefined);
    assert.ok(profile.reason);
  }
});

test("duplicate load registers once", () => {
  const s = setup(SHADOW);
  s.load();
  s.load();
  s.load();
  for (const list of s.host.handlers.values()) assert.equal(list.length, 1);
  assert.deepEqual(s.host.commands, ["jev"]);
});

test("damaged config: off and file left unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-adapter-config-"));
  try {
    const path = join(dir, "config.json");
    const damaged = "{ mode: shadow, broken";
    await writeFile(path, damaged);
    const s = setup(() => loadOmpConfig({ home: dir, path, env: {} }));
    s.load();
    await runTask(s);
    assert.equal(s.jev.state.requests, 0);
    assert.equal(await readFile(path, "utf8"), damaged);
    const result = await loadOmpConfig({ home: dir, path, env: {} });
    assert.equal(result.source, "invalid");
    assert.equal(result.config.mode, "off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default config path and telemetry are under ~/.omp, independent from Pi", async () => {
  const result = await loadOmpConfig({ home: "/h", env: {}, readText: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
  assert.equal(result.path, "/h/.omp/agent/pi-jev-harness/config.json");
  assert.equal(result.config.telemetryDir, "/h/.omp/agent/pi-jev-harness/telemetry");
  assert.equal(result.config.mode, "off");
  const custom = await loadOmpConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ telemetryDir: "/t" }) });
  assert.equal(custom.config.telemetryDir, "/t");
});

test("OMP arktype-style parameters are converted with toJsonSchema; unconvertible become opaque (null)", () => {
  const schema = { type: "object", properties: { path: { type: "string" } } };
  assert.deepEqual(ompToolSchema(Object.assign(() => {}, { toJsonSchema: () => schema })), schema);
  assert.deepEqual(ompToolSchema(schema), schema);
  assert.equal(ompToolSchema(Object.assign(() => {}, { toJsonSchema: () => { throw new Error("x"); } })), null);
  assert.equal(ompToolSchema(() => {}), null);
});

test("router mode on still only observes in OMP", async () => {
  const s = setup({ ...SHADOW, router: { tools: "on" } });
  s.load();
  const results = await runTask(s);
  assert.ok(s.jev.state.requests > 0);
  assert.deepEqual(s.host.setterCalls, []);
  assert.ok(results.every((result) => result === undefined));
});

test("session start fails closed when getCommands is missing on host", async () => {
  const s = setup(SHADOW);
  // Simulate host omitting optional getCommands API
  delete (s.host.api as { getCommands?: unknown }).getCommands;
  s.load();
  await s.host.emit("session_start");
  const status = (s.registry as Record<symbol, { host: { statusText(): string } }>)[Symbol.for("pi-jev-harness.adapter.omp")];
  assert.match(status.host.statusText(), /OMP registry unavailable at session_start/);
});

test("ompProvidersPath prioritizes pi-jev-harness directory over legacy directory", async () => {
  const home = "/test/home";
  const harnessFile = join(ompHarnessDir(home), "jev-providers.json");
  const legacyFile = join(home, ".omp", "agent", "jev-providers.json");

  // When harnessFile exists -> choose harnessFile
  assert.equal(ompProvidersPath(home, (p) => p === harnessFile), harnessFile);

  // When harnessFile does not exist -> fall back to legacyFile
  assert.equal(ompProvidersPath(home, () => false), legacyFile);

  const scratch = await mkdtemp(join(tmpdir(), "omp-providers-path-"));
  try {
    const localFile = join(ompHarnessDir(scratch), "jev-providers.json");
    const fallback = join(scratch, ".omp", "agent", "jev-providers.json");
    assert.equal(defaultOmpHostDeps({ env: { HOME: scratch } }).legacyProvidersPath, fallback);
    await mkdir(ompHarnessDir(scratch), { recursive: true });
    await writeFile(localFile, "{}");
    assert.equal(defaultOmpHostDeps({ env: { HOME: scratch } }).legacyProvidersPath, localFile);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
