import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler } from "../../../../src/adapters/omp/types.ts";

const KEY = "fake-credential-never-print-this";

test("OMP debug command toggles session-only compact fallback and resets on restart", async () => {
  const listeners = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: OmpContext) => unknown }>();
  const notes: string[] = [];
  const debug: string[] = [];
  const model = { provider: "p", id: "a", reasoning: true, contextWindow: 200_000 };
  const ctx = {
    model,
    modelRegistry: { getAvailable: () => [model], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getSessionId: () => "debug-session", getLeafId: () => "leaf", getBranch: () => [] },
    getContextUsage: () => ({ percent: null }),
    ui: { notify: (message: string) => notes.push(message) },
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: () => {},
  } as unknown as OmpContext;
  const api = {
    pi: { VERSION: "18.4.1" },
    on: (event: string, handler: OmpHandler) => { listeners.set(event, [...(listeners.get(event) ?? []), handler]); },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: OmpContext) => unknown }) => { commands.set(name, options); },
    registerTool: () => {},
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } },
      { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } },
    ],
    getActiveTools: () => ["read", "bash"],
    getCommands: () => [...commands].map(([name, options]) => ({ name, description: options.description, source: "extension" })),
    getThinkingLevel: () => undefined,
    setActiveTools: () => {}, setModel: () => true, setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  let requests = 0;
  const registry = {};
  createExtension({
    env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: "https://jev.test/v1" },
    legacyProvidersPath: "/nonexistent-home/jev-providers.json",
    readFile: () => { throw new Error("No provider file in offline fixture"); },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/config.json", env: { TYPESAFE_API_KEY: KEY },
      readText: async () => JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow" } }) }),
    fetch: (async (_url, init) => { requests++; const request = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const options = Object.keys(question.criteria);
        const rest = 0.3 / (options.length - 1);
        return [id, { type: "choice", choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.7 : rest])) }];
      }));
      return new Response(JSON.stringify({ model: request.model, answers }), { status: 200 }); }) as typeof fetch,
    writeDebug: (text: string) => { debug.push(text); },
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: () => ({ record: async () => true, flush: async () => {}, diagnostics: () => ({}) as never }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
  }, registry)(api);
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(event) ?? []) await listener({ type: event, ...payload }, ctx);
  };
  const command = async (args: string) => { notes.length = 0; await commands.get("jev")!.handler(args, ctx); return notes.join("\n"); };
  const settled = () => (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host.settled();

  await emit("session_start");
  assert.match(await command("debug status"), /debug.*off/i);
  await emit("before_agent_start", { prompt: "before debug" });
  await settled();
  assert.ok(requests > 0, "shadow route dispatched");
  assert.equal(debug.length, 0);

  assert.match(await command("debug on"), /debug.*on/i);
  await emit("before_agent_start", { prompt: "debug payload visible" });
  await settled();
  assert.ok(debug.some((line: string) => line.includes("Jev REQ")));
  assert.ok(debug.some((line: string) => line.includes("Jev RESP") && line.includes("HTTP 200") && line.includes("ms")));
  assert.ok(debug.every((line: string) => !line.includes("\n") && !line.includes("debug payload visible") && !line.includes('"answers"')));
  assert.ok(!debug.join("\n").includes(KEY), "authorization key is not emitted");

  await command("debug off");
  const count = debug.length;
  await emit("before_agent_start", { prompt: "after debug" });
  await settled();
  assert.equal(debug.length, count);
  await emit("session_shutdown");
  await emit("session_start");
  assert.match(await command("debug status"), /debug.*off/i);
  await emit("session_shutdown");
});

test("OMP TUI shows separate REQ/RESP in non-steering content-empty messages", async () => {
  const listeners = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: OmpContext) => unknown }>();
  const messages: Array<{ message: { customType: string; content: string | []; details?: { summary: string; expanded: string }; display: boolean }; options: unknown }> = [];
  let renderer: ((message: { details?: { summary: string; expanded: string } }, options: { expanded: boolean }) => { render(width: number): string[] } | undefined) | undefined;
  const notes: string[] = [];
  const model = { provider: "p", id: "a", reasoning: true, contextWindow: 200_000 };
  const ctx = { model, modelRegistry: { getAvailable: () => [model], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getSessionId: () => "debug-session", getLeafId: () => "leaf", getBranch: () => [] },
    getContextUsage: () => ({ percent: null }), ui: { notify: (text: string) => notes.push(text) },
    hasUI: true, mode: "tui", hasPendingMessages: () => false, getAsyncJobSnapshot: () => ({ running: [], recent: [] }), isIdle: () => true,
  } as unknown as OmpContext;
  const api = { pi: { VERSION: "18.4.1" }, on: (event: string, listener: OmpHandler) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: OmpContext) => unknown }) => { commands.set(name, options); },
    registerMessageRenderer: (_type: string, fn: typeof renderer) => { renderer = fn; },
    sendMessage: (message: typeof messages[number]["message"], options: unknown) => { messages.push({ message, options }); }, registerTool: () => {},
    getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["read"], getCommands: () => [...commands].map(([name, options]) => ({ name, description: options.description, source: "extension" })),
    getThinkingLevel: () => undefined, setActiveTools: () => {}, setModel: () => true, setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  const fallback: string[] = [];
  const registry = {};
  createExtension({ env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: "https://jev.test/v1" }, legacyProvidersPath: "/nonexistent-home/jev-providers.json",
    readFile: () => { throw Error("No offline provider file"); },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/config.json", env: { TYPESAFE_API_KEY: KEY },
      readText: async () => JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow" } }) }),
    fetch: (async (_url, init) => { const request = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => { const ids = Object.keys(question.criteria);
        return [id, { type: "choice", choice: ids[0], confidence: 0.9, probabilities: Object.fromEntries(ids.map((name, index) => [name, index ? 0.3 / (ids.length - 1) : 0.7])) }]; }));
      return new Response(JSON.stringify({ model: request.model, answers }), { status: 200 }); }) as typeof fetch,
    writeDebug: (text: string) => fallback.push(text), createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: () => ({ record: async () => true, flush: async () => {}, diagnostics: () => ({}) as never }), readPluginsLock: () => undefined, loadLegacyConfig: async () => ({ dir: "" }),
  }, registry)(api);
  const emit = async (name: string, payload: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(name) ?? []) await listener({ type: name, ...payload }, ctx);
  };
  await emit("session_start");
  await commands.get("jev")!.handler("debug on", ctx);
  await emit("before_agent_start", { prompt: "omp secret body" });
  await (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host.settled();
  assert.equal(fallback.length, 0);
  assert.ok(messages.some(({ message }) => message.details?.summary.includes("Jev REQ")));
  assert.ok(messages.some(({ message }) => message.details?.summary.includes("Jev RESP")));
  assert.ok(messages.every(({ message, options }) => message.customType === "jev-debug" && message.display && Array.isArray(message.content) && message.content.length === 0 &&
    !JSON.stringify(message.content).includes("omp secret body") && JSON.stringify(options) === '{"deliverAs":"aside","triggerTurn":false}'));
  assert.ok(!JSON.stringify(messages).includes(KEY));
  const req = messages.find(({ message }) => message.details?.summary.includes("Jev REQ"))!.message;
  assert.equal(renderer!(req, { expanded: false })!.render(1000).length, 1);
  assert.ok(renderer!(req, { expanded: true })!.render(1000).join("\n").includes("omp secret body"));
  await emit("session_shutdown");
});
