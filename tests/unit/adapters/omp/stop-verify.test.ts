/**
 * Verifier edge cases for L3; harness copied from stop.test.ts. against a fake OMP host and a fake Jev: completion acceptance at
 * `session_stop`, bounded continuation (exactly 0 / 1 / 2), no continuation with pending work or in
 * a child session, the registered tools, every `/jev` subcommand, legacy config mapping, and config
 * `mode: "on"` being effective. No network, no file writes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runJevCommand } from "../../../../src/adapters/omp/commands.ts";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { loadLegacyConfig, mapLegacyMode } from "../../../../src/adapters/omp/legacy-config.ts";
import { transcriptEvidence } from "../../../../src/adapters/omp/stop.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.omp");
const PROMPT = "Explain what the parser module does";
const MESSAGES = [
  { role: "user", content: [{ type: "text", text: PROMPT }] },
  { role: "assistant", content: [{ type: "text", text: "It parses things." }] },
];

interface JevScript {
  accept: boolean;
  requests: number;
}

/** Fake Jev: choice → accepted/rejected per script; noul done=0.1, autonomous=0.95. */
function fakeJev(script: JevScript) {
  return (async (_input: unknown, init?: RequestInit) => {
    script.requests++;
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { type: "noul", noul: id === "done" ? 0.1 : 0.95 }];
      const options = Object.keys(q.criteria ?? {});
      const pick = options.includes("accepted") ? (script.accept ? "accepted" : "rejected") : options[0]!;
      const rest = 0.1 / Math.max(1, options.length - 1);
      return [id, { type: "choice", choice: pick, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 0.9 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

interface HostOptions {
  parentSession?: string;
}

function fakeHost(options: HostOptions = {}) {
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: OmpContext) => unknown; description?: string }>();
  const tools = new Map<string, OmpToolDefinition>();
  const setterCalls: string[] = [];
  const notes: Array<{ message: string; level?: string }> = [];
  const pending = { messages: false, jobs: 0 };
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: {
      getHeader: () => (options.parentSession ? { parentSession: options.parentSession } : {}),
      getBranch: () => MESSAGES.map((message, i) => ({ type: "message", id: `e${i}`, message })),
      getSessionId: () => "sess-1",
      getLeafId: () => "leaf-1",
    },
    getContextUsage: () => undefined,
    ui: { notify: (message, level) => { notes.push({ message, ...(level ? { level } : {}) }); } },
    hasPendingMessages: () => pending.messages,
    getAsyncJobSnapshot: () => ({ running: Array.from({ length: pending.jobs }, (_, i) => ({ id: `job${i}` })), recent: [] }),
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: "18.3.5" },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name, command) { commands.set(name, { handler: command.handler, description: command.description }); },
    getCommands: () => [...commands.entries()].map(([name, c]) => ({ name, source: "extension" as const, description: c.description })),
    registerTool(tool) { tools.set(tool.name, tool); },
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
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  const jev = async (args: string) => {
    notes.length = 0;
    await commands.get("jev")!.handler(args, ctx);
    return notes.at(-1)!;
  };
  return { api, ctx, handlers, tools, setterCalls, pending, emit, jev };
}

interface SetupOptions extends HostOptions {
  accept?: boolean;
  legacyFiles?: Record<string, string>;
  key?: boolean;
}

function setup(config: Record<string, unknown>, options: SetupOptions = {}) {
  const host = fakeHost(options);
  const script: JevScript = { accept: options.accept ?? false, requests: 0 };
  const events: TelemetryInput[] = [];
  const registry: Record<symbol, unknown> = {};
  const reads: string[] = [];
  createExtension({
    env: options.key === false ? {} : { TYPESAFE_API_KEY: "stop-test-key-0123456789" },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify({ effort: "off", ...config }) /* C12 effort (L6) off: these count C4/C5 traffic */ }),
    loadLegacyConfig: () => loadLegacyConfig("/legacy", async (path) => {
      reads.push(path);
      const name = path.split("/").at(-1)!;
      const text = options.legacyFiles?.[name];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    }),
    readPluginsLock: () => undefined,
    fetch: fakeJev(script),
    now: () => 0,
    newId: () => crypto.randomUUID(),
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry)(host.api);
  const claim = () => (registry[CLAIM] as { host: { statusText(): string; settled(): Promise<void> } }).host;
  const stop = async (payload: Record<string, unknown> = {}) =>
    (await host.emit("session_stop", { messages: MESSAGES, turn_id: 1, session_id: "sess-1", stop_hook_active: false, signal: new AbortController().signal, ...payload }))[0];
  return { host, script, events, reads, claim, stop };
}

const ON = { mode: "on", outbound: { taskIntent: true }, harness: { continuation: { enabled: true } } };

async function start(s: ReturnType<typeof setup>) {
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  await s.claim().settled();
}

// ---- Verifier additions -----------------------------------------------------------
// OMP v18.3.5 agent-session.ts:4114-4115 emits `session_stop` FIRST and the settle's `agent_end`
// notification AFTER it, with `willContinue: true` when a session_stop continuation was scheduled.
// Paths that schedule their own continuation (todo reminder, rewind, plan mode, async wake) emit
// `agent_end {willContinue: true}` WITHOUT a session_stop; the next settle then emits session_stop.

type StopResult = { continue?: boolean; additionalContext?: string } | undefined;

test("verify: real OMP order (session_stop, then agent_end willContinue) still allows the 2nd continuation", async () => {
  const s = setup(ON);
  await start(s);
  let count = 0;
  for (let i = 0; i < 5; i++) {
    const result = (await s.stop({ stop_hook_active: count > 0 })) as StopResult;
    // Host emits agent_end after session_stop, tagged willContinue when the stop continued.
    await s.host.emit("agent_end", { messages: MESSAGES, willContinue: result?.continue === true });
    if (!result?.continue) break;
    count++;
  }
  assert.equal(count, 2, s.claim().statusText());
});

test("verify: after a host todo-reminder continuation, the next real session_stop is still assessed", async () => {
  const s = setup({ ...ON, router: { tools: "off" } });
  await start(s);
  // Host todo reminder: agent_end willContinue without a session_stop, then the next settle.
  await s.host.emit("agent_end", { messages: MESSAGES, willContinue: true });
  const before = s.script.requests;
  const result = (await s.stop()) as StopResult;
  assert.ok(s.script.requests > before, `stop not assessed: ${s.claim().statusText()}`);
  assert.equal(result?.continue, true);
});

test("verify: result shape is exactly {continue, additionalContext} (OMP SessionStopEventResult)", async () => {
  const s = setup(ON);
  await start(s);
  const result = (await s.stop()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(result).sort(), ["additionalContext", "continue"]);
  assert.equal(result.continue, true);
  assert.equal(typeof result.additionalContext, "string");
  assert.ok((result.additionalContext as string).length > 0, "OMP drops a continuation with empty context");
});

test("verify: mode off: zero Jev requests across stop and all three tools; no setters", async () => {
  const s = setup({ ...ON, mode: "off" });
  await start(s);
  assert.equal(await s.stop(), undefined);
  for (const name of ["jev_acceptance_gate", "foreman_assess", "jev_route"])
    await s.host.tools.get(name)!.execute("t", { intent: "Read a file", answer: "x" }, undefined, undefined, s.host.ctx);
  assert.equal(s.script.requests, 0);
  assert.deepEqual(s.host.setterCalls, []);
});

test("verify: /jev mode off mid-task stops everything; /jev autorun on does not reset the count", async () => {
  const s = setup(ON);
  await start(s);
  assert.equal(((await s.stop()) as StopResult)?.continue, true);
  await s.host.jev("autorun on");
  assert.match((await s.host.jev("autorun status")).message, /continues=1\/2/);
  await s.host.jev("mode off");
  const before = s.script.requests;
  assert.equal(await s.stop({ stop_hook_active: true }), undefined);
  assert.equal(s.script.requests, before);
});

test("verify: legacy_conflict at load: no tool name shared with the legacy plugin is registered", async () => {
  const host = fakeHost();
  createExtension({
    env: {}, loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => "{}" }),
    loadLegacyConfig: async () => ({ dir: "" }),
    readPluginsLock: () => JSON.stringify({ plugins: { "@omp-jev/harness": { enabled: true } } }),
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
    now: () => 0, newId: () => crypto.randomUUID(),
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, {})(host.api);
  // The legacy @omp-jev/harness registers foreman_assess (capabilities/assessment.ts:244) and
  // jev_route (capabilities/planning.ts:244) by default; registering them too duplicates the names.
  assert.deepEqual([...host.tools.keys()].sort(), [], "no tool name shared with the legacy plugin");
});

test("verify: concurrent tool calls each get their own per-call budget (maxRequestsPerTask 1)", async () => {
  const s = setup({ ...ON, budget: { maxRequestsPerTask: 1 } }, { accept: true });
  await start(s);
  const [gate, route] = await Promise.all([
    s.host.tools.get("jev_acceptance_gate")!.execute("t1", { answer: "It parses things." }, undefined, undefined, s.host.ctx),
    s.host.tools.get("jev_route")!.execute("t2", { intent: "Read a file" }, undefined, undefined, s.host.ctx),
  ]);
  const g = gate.details as { completionStatus: string; reason?: string };
  const r = route.details as { tools: { status: string; reason?: string } };
  assert.equal(g.completionStatus, "passed", JSON.stringify(g));
  assert.notEqual(r.tools.status, "unavailable", JSON.stringify(r));
});

test("verify: own config continuation.enabled=false vs legacy autorun on (precedence)", async () => {
  const s = setup({ ...ON, harness: { continuation: { enabled: false } } }, { legacyFiles: { "jev-autorun.json": JSON.stringify({ mode: "on" }) } });
  await start(s);
  // Explicit own config wins over the legacy file (fix).
  assert.match(s.claim().statusText(), /autorun: shadow \(source: config\)/);
});

test("verify: CHECK_COMMAND is the same regex for Pi harness and core", async () => {
  const pi = await import("../../../../src/adapters/pi/harness.ts");
  const core = await import("../../../../src/adapters/core/checks.ts");
  assert.equal(pi.CHECK_COMMAND, core.CHECK_COMMAND);
  assert.equal(core.CHECK_COMMAND.source, String.raw`(?:^|[\s;&|(])(?:node\s+(?:\S+\s+)*--test\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check)\b|(?:npx\s+|pnpm\s+exec\s+)?(?:tsc|vitest|jest|eslint|pytest|mocha)\b|go\s+(?:test|vet)\b|cargo\s+(?:test|check|clippy)\b|make\s+(?:test|check)\b|deno\s+test\b)`);
});

test("verify: own config without continuation.enabled → legacy autorun file still applies", async () => {
  const s = setup({ mode: "on", outbound: { taskIntent: true } }, { legacyFiles: { "jev-autorun.json": JSON.stringify({ mode: "on" }) } });
  await start(s);
  assert.match(s.claim().statusText(), /autorun: on \(source: \/legacy\/jev-autorun\.json\)/);
});

test("verify: real order 1 → 2 → third stop does not continue; agent_end tagged as OMP does", async () => {
  const s = setup(ON);
  await start(s);
  const seen: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const r = (await s.stop({ stop_hook_active: i > 0 })) as StopResult;
    seen.push(r?.continue === true);
    await s.host.emit("agent_end", { messages: MESSAGES, willContinue: r?.continue === true });
  }
  assert.deepEqual(seen, [true, true, false]);
});

test("verify: pending async wake → no session_stop, agent_end willContinue; the later terminal stop is assessed", async () => {
  const s = setup({ ...ON, router: { tools: "off" } });
  await start(s);
  s.host.pending.jobs = 1;
  await s.host.emit("agent_end", { messages: MESSAGES, willContinue: true });
  s.host.pending.jobs = 0;
  const before = s.script.requests;
  assert.equal(((await s.stop()) as StopResult)?.continue, true);
  assert.ok(s.script.requests > before);
});

// OMP abort() (agent-session.ts ~8797) clears the queued session-stop continuation and
// #emitSessionStopEvent returns early while #abortInProgress: our returned continuation never
// runs and no further session_stop reaches the adapter. The user's next prompt is a NEW task.
test("verify: continuation dropped by a host abort; the next user prompt starts a new task", async () => {
  const s = setup(ON);
  await start(s);
  assert.equal(((await s.stop()) as StopResult)?.continue, true);
  // Host abort: agent_end without willContinue; no session_stop.
  await s.host.emit("agent_end", { messages: MESSAGES, willContinue: false });
  await s.host.emit("before_agent_start", { prompt: "A completely different request" });
  assert.match((await s.host.jev("autorun status")).message, /continues=0\/2/);
});

test("verify: a todo reminder inside our continuation turn (agent_end willContinue) keeps the continuation", async () => {
  const s = setup(ON);
  await start(s);
  assert.equal(((await s.stop()) as StopResult)?.continue, true);
  await s.host.emit("agent_end", { messages: MESSAGES, willContinue: true }); // our stop's agent_end
  await s.host.emit("agent_end", { messages: MESSAGES, willContinue: true }); // todo reminder in the continuation turn
  assert.equal(((await s.stop({ stop_hook_active: true })) as StopResult)?.continue, true);
  assert.match((await s.host.jev("autorun status")).message, /continues=2\/2/);
});
