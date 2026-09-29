/**
 * against a fake OMP host and a fake Jev: completion acceptance at
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

/** Stops until one does not continue; returns the number of continuations. */
async function continuations(s: ReturnType<typeof setup>, limit = 5): Promise<number> {
  let count = 0;
  for (let i = 0; i < limit; i++) {
    // Real OMP 18.3.5 order: session_stop, then that settle's agent_end.
    const result = (await s.stop({ stop_hook_active: count > 0 })) as { continue?: boolean; additionalContext?: string } | undefined;
    await s.host.emit("agent_end", { messages: MESSAGES, ...(result?.continue ? { willContinue: true } : {}) });
    if (!result?.continue) break;
    assert.match(result.additionalContext ?? "", /^Automatic continuation \d of \d/);
    count++;
  }
  return count;
}

// ---- bounded continuation ----------------------------------------------------------------

test("mode on, acceptance rejected: continues exactly 2 times, then stops", async () => {
  const s = setup(ON);
  await start(s);
  assert.equal(await continuations(s), 2);
  assert.match(s.claim().statusText(), /continuations this task: 2\/2/);
  assert.deepEqual(s.host.setterCalls, []);
});

test("continuation max 1: continues exactly once", async () => {
  const s = setup({ ...ON, harness: { continuation: { enabled: true, max: 1 } } });
  await start(s);
  assert.equal(await continuations(s), 1);
});

test("acceptance passed: continues 0 times", async () => {
  const s = setup(ON, { accept: true });
  await start(s);
  assert.equal(await continuations(s), 0);
});

test("a new user task resets the per-task count", async () => {
  const s = setup(ON);
  await start(s);
  assert.equal(await continuations(s), 2);
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  assert.equal(await continuations(s), 2);
});

test("no continuation (and no Jev request at stop) with pending messages, async jobs, child session or another hook's continuation", async () => {
  const cases: Array<[string, SetupOptions, (s: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ["pending messages", {}, async (s) => { s.host.pending.messages = true; return s.stop(); }],
    ["async jobs", {}, async (s) => { s.host.pending.jobs = 1; return s.stop(); }],
    ["child session", { parentSession: "/parent.jsonl" }, async (s) => s.stop()],
    ["foreign stop_hook_active", {}, async (s) => s.stop({ stop_hook_active: true })],
    ["aborted signal", {}, async (s) => { const c = new AbortController(); c.abort(); return s.stop({ signal: c.signal }); }],
  ];
  for (const [name, options, run] of cases) {
    const s = setup({ ...ON, router: { tools: "off" } }, options);
    await start(s);
    const before = s.script.requests;
    assert.equal(await run(s), undefined, name);
    assert.equal(s.script.requests, before, `${name}: no Jev request`);
  }
});

test("shadow: session_stop returns undefined synchronously and records would-continue", async () => {
  const s = setup({ ...ON, mode: "shadow" });
  await start(s);
  const handler = s.host.handlers.get("session_stop")![0]!;
  const result = handler({ type: "session_stop", messages: MESSAGES, turn_id: 1, session_id: "sess-1", stop_hook_active: false, signal: new AbortController().signal }, s.host.ctx);
  assert.equal(result, undefined);
  await s.claim().settled();
  assert.match(s.claim().statusText(), /would-continue: 1/);
  assert.ok(s.events.some((e) => e.kind === "continuation" && e.outcome === "withheld"), JSON.stringify(s.events));
});

test("autorun off: assessment only, one Jev request, no continuation question", async () => {
  const s = setup({ ...ON, router: { tools: "off" } });
  await start(s);
  await s.host.jev("autorun off");
  assert.equal(await s.stop(), undefined);
  assert.equal(s.script.requests, 1);
  assert.ok(s.events.some((e) => e.kind === "completion"));
});

test("outbound not authorized: no Jev request, no continuation", async () => {
  const s = setup({ ...ON, outbound: { taskIntent: false } });
  await start(s);
  assert.equal(await continuations(s), 0);
  assert.equal(s.script.requests, 0);
});

test("credential in the task: completion is withheld, no continuation", async () => {
  const s = setup({ ...ON, router: { tools: "off" } });
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: "use key stop-test-key-0123456789 now" });
  assert.equal(await continuations(s), 0);
  assert.equal(s.script.requests, 0);
});

test("budget.maxRequestsPerTask 0: no Jev request at stop, no continuation", async () => {
  const s = setup({ ...ON, router: { tools: "off" }, budget: { maxRequestsPerTask: 0 } });
  await start(s);
  assert.equal(await continuations(s), 0);
  assert.equal(s.script.requests, 0);
});

// ---- tools ------------------------------------------------------------------------------

test("tools registered: jev_route, jev_acceptance_gate, foreman_assess; shared completion contract", async () => {
  const s = setup(ON, { accept: true });
  // Plus jev_recall and jev_plan, registered next to the L3 tools.
  assert.deepEqual([...s.host.tools.keys()].sort(), ["foreman_assess", "jev_acceptance_gate", "jev_plan", "jev_recall", "jev_route"]);
  // Before a session: unavailable, no request.
  const off = await s.host.tools.get("jev_acceptance_gate")!.execute("t0", {}, undefined, undefined, s.host.ctx);
  assert.equal((off.details as { completionStatus: string }).completionStatus, "unavailable");
  await start(s);
  const gate = await s.host.tools.get("jev_acceptance_gate")!.execute("t1", { answer: "It parses things." }, undefined, undefined, s.host.ctx);
  const result = JSON.parse(gate.content[0]!.text) as { assessment: string; completionStatus: string; stopAllowed: boolean };
  assert.equal(result.assessment, "acceptance");
  assert.equal(result.completionStatus, "passed");
  assert.equal(result.stopAllowed, true);
  const route = await s.host.tools.get("jev_route")!.execute("t2", { intent: "Read a file" }, undefined, undefined, s.host.ctx);
  const body = JSON.parse(route.content[0]!.text) as { executed: boolean; reused: boolean; tools: { appliedToHost: boolean } };
  assert.equal(body.executed, false);
  assert.equal(body.tools.appliedToHost, false);
  const before = s.script.requests;
  const again = JSON.parse((await s.host.tools.get("jev_route")!.execute("t3", { intent: "Read a file" }, undefined, undefined, s.host.ctx)).content[0]!.text) as { reused: boolean };
  assert.equal(again.reused, true);
  assert.equal(s.script.requests, before, "same intent reuses the earlier route");
  const foreman = await s.host.tools.get("foreman_assess")!.execute("t4", {}, undefined, undefined, s.host.ctx);
  // Same checkpoint: the foreman tool shares the acceptance tool's assessment (Pi semantics).
  assert.deepEqual(foreman.details, gate.details);
  assert.deepEqual(s.host.setterCalls, []);
});

test("jev_route while off: unavailable, no request", async () => {
  const s = setup({ mode: "off" });
  await s.host.emit("session_start");
  const route = await s.host.tools.get("jev_route")!.execute("t", { intent: "x" }, undefined, undefined, s.host.ctx);
  assert.equal((route.details as { status: string }).status, "unavailable");
  assert.equal(s.script.requests, 0);
});

// ---- /jev ------------------------------------------------------------------------------

test("/jev subcommands: status, help, mode, acceptance, autorun, unknown", async () => {
  const s = setup(ON);
  await s.host.emit("session_start");
  assert.match((await s.host.jev("")).message, /^Jev: on/);
  assert.match((await s.host.jev("status")).message, /acceptance: on \(source: default\)[\s\S]*autorun: on \(source: config\)/);
  assert.match((await s.host.jev("help")).message, /\/jev acceptance on\|off\|dry-run\|status/);
  assert.equal((await s.host.jev("mode dry-run")).message, "Jev: shadow (this session)");
  assert.equal((await s.host.jev("mode on")).message, "Jev: on (this session)");
  assert.equal((await s.host.jev("mode off")).message, "Jev: off (this session)");
  assert.equal((await s.host.jev("mode bogus")).level, "warning");
  assert.equal((await s.host.jev("acceptance dry-run")).message, "acceptance=shadow source=session");
  assert.equal((await s.host.jev("acceptance status")).message, "acceptance=shadow source=session");
  assert.equal((await s.host.jev("acceptance off")).message, "acceptance=off source=session");
  assert.equal((await s.host.jev("autorun dry-run")).message, "autorun=shadow source=session continues=0/2");
  assert.equal((await s.host.jev("autorun on")).message, "autorun=on source=session continues=0/2");
  assert.equal((await s.host.jev("autorun maybe")).level, "warning");
  const unknown = await s.host.jev("frobnicate");
  assert.equal(unknown.level, "warning");
  assert.match(unknown.message, /Unknown \/jev subcommand 'frobnicate'/);
});

test("/jev acceptance off stops the checkpoint; autorun dry-run keeps it but never continues", async () => {
  const s = setup(ON);
  await start(s);
  await s.host.jev("autorun dry-run");
  assert.equal(await continuations(s), 0);
  assert.match(s.claim().statusText(), /would-continue: 1/);
  await s.host.jev("acceptance off");
  const before = s.script.requests;
  assert.equal(await s.stop(), undefined);
  assert.equal(s.script.requests, before);
});

test("runJevCommand without a session", () => {
  const target = { status: () => "S", setMode: () => "Jev: no active session", capability: () => undefined, setCapability: () => false, continuations: () => undefined };
  assert.equal(runJevCommand("acceptance on", target).text, "Jev: no active session");
  assert.equal(runJevCommand("mode on", target).level, "warning");
});

// ---- legacy config --------------------------------------------------------------------------

test("legacy mapping: dry-run → shadow; per-file sources; jev-harness.json wins; invalid acceptance file → off", async () => {
  assert.equal(mapLegacyMode("dry-run"), "shadow");
  assert.equal(mapLegacyMode("on"), "on");
  assert.equal(mapLegacyMode("maybe"), undefined);
  const files = (map: Record<string, string>) => async (path: string) => {
    const text = map[path.split("/").at(-1)!];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  const a = await loadLegacyConfig("/L", files({ "jev-autorun.json": JSON.stringify({ mode: "dry-run", toolGroups: { web: ["fetch"] } }), "acceptance-gate.json": JSON.stringify({ mode: "on" }) }));
  assert.deepEqual(a.autorun, { mode: "shadow", source: "/L/jev-autorun.json" });
  assert.deepEqual(a.acceptance, { mode: "on", source: "/L/acceptance-gate.json" });
  assert.deepEqual(a.toolGroups, { names: ["web"], source: "/L/jev-autorun.json" });
  const b = await loadLegacyConfig("/L", files({
    "jev-harness.json": JSON.stringify({ schemaVersion: 1, capabilities: { acceptance: { mode: "dry-run" }, continuation: { mode: "off" } } }),
    "jev-autorun.json": JSON.stringify({ mode: "on" }),
    "acceptance-gate.json": JSON.stringify({ mode: "on" }),
  }));
  assert.deepEqual(b.acceptance, { mode: "shadow", source: "/L/jev-harness.json" });
  assert.deepEqual(b.autorun, { mode: "off", source: "/L/jev-harness.json" });
  const c = await loadLegacyConfig("/L", files({ "acceptance-gate.json": "{not json" }));
  assert.deepEqual(c.acceptance, { mode: "off", source: "/L/acceptance-gate.json" });
  assert.equal(c.autorun, undefined);
  const none = await loadLegacyConfig("/L", files({}));
  assert.deepEqual(none, { dir: "/L" });
});

test("legacy files through the host: status shows sources and toolGroups (never applied); dry-run autorun never continues", async () => {
  const s = setup({ mode: "on", outbound: { taskIntent: true } }, {
    legacyFiles: { "jev-autorun.json": JSON.stringify({ mode: "dry-run", toolGroups: { web: ["fetch"], shell: ["bash"] } }), "acceptance-gate.json": JSON.stringify({ mode: "on" }) },
  });
  await start(s);
  const status = s.claim().statusText();
  assert.match(status, /legacy config: mapped read-only from \/legacy/);
  assert.match(status, /acceptance: on \(source: \/legacy\/acceptance-gate\.json\)/);
  assert.match(status, /autorun: shadow \(source: \/legacy\/jev-autorun\.json\)/);
  assert.match(status, /legacy toolGroups: web, shell \(source: \/legacy\/jev-autorun\.json; shown only, never applied\)/);
  assert.equal(await continuations(s), 0);
  assert.deepEqual(s.host.setterCalls, [], "toolGroups never applied");
  assert.ok(s.reads.every((path) => path.startsWith("/legacy/")));
});

test("invalid legacy jev-harness.json is ignored entirely, with a status note", async () => {
  const s = setup({ mode: "on", outbound: { taskIntent: true } }, {
    legacyFiles: {
      "jev-harness.json": JSON.stringify({ schemaVersion: 1, capabilities: { acceptance: { mode: "off" }, continuation: { mode: "sometimes" } } }),
      "jev-autorun.json": JSON.stringify({ mode: "on" }),
    },
  });
  await start(s);
  const status = s.claim().statusText();
  assert.match(status, /legacy \/legacy\/jev-harness\.json invalid; ignored/);
  assert.match(status, /acceptance: on \(source: default\)/, "the valid-looking acceptance entry is not partially applied");
  assert.match(status, /autorun: on \(source: \/legacy\/jev-autorun\.json\)/);
});

test("tools are registered with loadMode essential", () => {
  const s = setup(ON);
  assert.deepEqual([...s.host.tools.values()].map((tool) => tool.loadMode), ["essential", "essential", "essential", "essential", "essential"]);
});

test("own config continuation.enabled wins over a legacy autorun file", async () => {
  const s = setup(ON, { legacyFiles: { "jev-autorun.json": JSON.stringify({ mode: "dry-run" }) } });
  await start(s);
  assert.match(s.claim().statusText(), /autorun: on \(source: config\)/);
  assert.equal(await continuations(s), 2);
});

// ---- mode on effective / evidence --------------------------------------------------------------

test("config mode on is effective at session_start; shadow config is not", async () => {
  const on = setup(ON);
  await on.host.emit("session_start");
  assert.match(on.claim().statusText(), /^Jev: on \(this session\)[\s\S]*continuation applies/);
  const shadow = setup({ ...ON, mode: "shadow" });
  await shadow.host.emit("session_start");
  assert.match(shadow.claim().statusText(), /^Jev: shadow[\s\S]*would-continue recorded only/);
});

test("transcript evidence: edits, check commands and the answer after the task's user message", () => {
  const evidence = transcriptEvidence("Fix the bug", [
    { role: "user", content: "old task" },
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "edit", arguments: { path: "old.ts" } }] },
    { role: "toolResult", toolCallId: "old", toolName: "edit", content: [], isError: false },
    { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/a.ts" } }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "pnpm test" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false },
    { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "pass" }], isError: false },
    { role: "assistant", content: [{ type: "text", text: "Fixed." }] },
  ], 1);
  assert.equal(evidence.mutated, true);
  assert.deepEqual(evidence.changes.map((c) => c.path), ["src/a.ts"]);
  assert.deepEqual(evidence.checks.map((c) => [c.toolName, c.outcome]), [["bash", "ok"]]);
  assert.equal(evidence.answer, "Fixed.");
});
