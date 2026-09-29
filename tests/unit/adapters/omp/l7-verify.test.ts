/**
 * verification (verifier-owned). Harness copied from ./t105-int-verify.test.ts: real OMP
 * entry (`createExtension`), fake OMP host, fake Jev (injected fetch). No ~/.omp, ~/.pi, network.
 * Tests whose name starts with "DEFECT:" reproduce defects found by the L7 verifier.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { PACKAGE_ROOT } from "../../../../src/adapters/omp/legacy.ts";
import type { OmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition, OmpToolInfo } from "../../../../src/adapters/omp/types.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.omp");
const KEY = "t105-int-verify-key-0123456789";
const PROMPT = "Create the file notes.txt with a short greeting";
const NATIVE = ["read", "bash", "write", "edit", "grep", "web_search", "browser"];
const BUILTINS: OmpToolInfo[] = NATIVE.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }));
const sorted = (xs: readonly string[]) => [...xs].sort();

type Body = { model: string; state?: unknown; questions: Record<string, { type: string; criteria?: Record<string, string> }> };

/** Which capability a request body belongs to, from its question ids (content-free). */
function classify(body: Body): string {
  const ids = Object.keys(body.questions);
  if (ids.includes("effort")) return "effort";
  if (ids.includes("irreversible")) return "approval";
  if (ids.includes("naturalBreak")) return "proactive";
  if (ids.includes("done") && ids.includes("autonomous")) return "continuation";
  if (ids.some((id) => /^(addresses_task|evidence_supports|unrelated_changes|needs_clarification)$/.test(id))) return "enforce";
  if (ids.some((id) => id.startsWith("tool"))) return "route";
  if (ids.includes("mode")) return "plan";
  return `other:${ids.slice(0, 3).join(",")}`;
}

interface FakeJev {
  fetch: typeof globalThis.fetch;
  log: Array<{ url: string; kind: string; at: number }>;
  hang: Set<string>;
}

let seq = 0;
function fakeJev(pick: Record<string, string> = {}, noul: Record<string, number> = {}): FakeJev {
  const log: FakeJev["log"] = [];
  const hang = new Set<string>();
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const kind = classify(body);
    log.push({ url: String(input), kind, at: ++seq });
    if (hang.has(kind) || hang.has("*")) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { type: "noul", noul: noul[id] ?? 0.5 }];
      const options = Object.keys(q.criteria ?? {});
      const choice = options.includes(pick[id] ?? "") ? pick[id]! : options.includes(pick["*"] ?? "") ? pick["*"]! : options[0]!;
      const rest = 0.05 / Math.max(1, options.length - 1);
      return [id, { type: "choice", choice, confidence: 0.95, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.95 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, log, hang };
}

interface HostOptions { child?: boolean; usage?: number; hasUI?: boolean }

async function fakeHost(options: HostOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-l7v-"));
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { name: string; source: "extension"; description?: string; handler: (args: string, ctx: OmpContext) => unknown }>();
  const tools = new Map<string, OmpToolDefinition>();
  let active = [...NATIVE];
  const setters: string[] = [];
  const order: string[] = [];
  const notes: string[] = [];
  const confirms: string[] = [];
  let usage = options.usage;
  const ctx = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: {
      getHeader: () => (options.child ? { parentSession: "/parent.jsonl" } : {}),
      getSessionId: () => "s-l7v", getLeafId: () => "leaf-1", getBranch: () => [], getCwd: () => cwd,
    },
    cwd,
    hasUI: options.hasUI ?? true,
    getContextUsage: () => (usage === undefined ? undefined : { percent: usage }),
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: (o?: { onComplete?: () => void }) => { order.push("host.compact"); o?.onComplete?.(); },
    ui: {
      notify: (message: string) => { notes.push(message); },
      confirm: async (title: string) => { confirms.push(title); return true; },
    },
  } as unknown as OmpContext;
  const own = (name: string): OmpToolInfo => ({ name, description: name, parameters: { type: "object", properties: {} }, sourceInfo: { path: join(PACKAGE_ROOT, "src/adapters/omp/index.ts"), source: "extension" } });
  const api = {
    pi: { VERSION: "18.4.1" },
    on: (event: string, handler: OmpHandler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name: string, command: { description?: string; handler: (args: string, ctx: OmpContext) => unknown }) => {
      commands.set(name, { name, source: "extension", description: command.description, handler: command.handler });
    },
    registerTool: (tool: OmpToolDefinition) => { tools.set(tool.name, tool); },
    getCommands: () => [...commands.values()].map(({ name, source, description }) => ({ name, source, description })),
    getAllTools: () => [...BUILTINS, ...[...tools.keys()].map(own)],
    getActiveTools: () => [...active],
    getThinkingLevel: () => "medium",
    setActiveTools: async (names: string[]) => { setters.push("setActiveTools"); order.push(`setActiveTools:${names.length}`); active = [...names]; },
    sendMessage: () => { setters.push("sendMessage"); },
    setModel: () => { setters.push("setModel"); return true; },
    setThinkingLevel: (level: unknown) => { setters.push(`setThinkingLevel:${String(level)}`); },
  } as unknown as OmpExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  return {
    api, ctx, cwd, tools, setters, order, notes, confirms, emit,
    active: () => [...active],
    setUsage: (percent: number | undefined) => { usage = percent; },
    handlerNames: () => [...handlers.keys()],
    async command(args: string) {
      notes.length = 0;
      await commands.get("jev")!.handler(args, ctx);
      return notes.join("\n");
    },
    tool: (name: string, input: unknown) => emit("tool_call", { toolCallId: `c-${++seq}`, toolName: name, input }),
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

async function setup(config: Record<string, unknown>, options: HostOptions & { jev?: FakeJev; env?: Record<string, string>; overrides?: Partial<OmpHostDeps> } = {}) {
  const host = await fakeHost(options);
  const jev = options.jev ?? fakeJev({ "*": "write", effort: "high" }, { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05, irreversible: 0.05, naturalBreak: 0.9, done: 0.05, autonomous: 0.9 });
  const storeDir = join(host.cwd, ".store");
  const file = { ...config, ...(config.context ? { context: { storeDir, ...(config.context as object) } } : {}) };
  const registry: Record<symbol, { host: { settled(): Promise<void>; statusText(): string } }> = {};
  createExtension({
    env: options.env ?? { TYPESAFE_API_KEY: KEY },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify(file) }),
    fetch: jev.fetch,
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: () => ({ record: async () => true, flush: async () => {} }) as never,
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    legacyProvidersPath: "/fake/omp/agent/jev-providers.json",
    ...options.overrides,
  }, registry)(host.api);
  await host.emit("session_start");
  const claim = () => registry[CLAIM]!.host;
  return {
    host, jev,
    status: () => claim().statusText(),
    settled: () => claim().settled(),
    async done() {
      await host.emit("session_shutdown");
      await host.cleanup();
    },
  };
}

/** Capabilities that draw on the per-task counter (budget.ts rule 1). */
const TASK_COUNTER = new Set(["route", "effort", "enforce", "approval"]);
const isTaskUnit = (kind: string) => TASK_COUNTER.has(kind);

const ALL_ON = (effort: "on" | "shadow" | undefined, max: number) => ({
  mode: "on",
  outbound: { taskIntent: true },
  router: { tools: "on" },
  harness: { enforce: ["create", "overwrite"], continuation: { enabled: true } },
  approval: { enabled: true, silentSteer: true, denyTools: [], allowTools: ["read"] },
  context: { request: "on", compaction: "on", proactive: { mode: "on" }, limits: { recentTurns: 1 } },
  budget: { maxRequestsPerTask: max, waitMs: 2000 },
  ...(effort ? { effort } : {}),
});

async function runTask(s: Awaited<ReturnType<typeof setup>>) {
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  await s.host.emit("context", { messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] });
  const write = await s.host.tool("write", { path: "notes.txt", content: "hello" });
  await s.host.emit("tool_result", { toolName: "write" });
  const bash = await s.host.tool("bash", { command: "ls" });
  await s.host.emit("tool_result", { toolName: "bash" });
  await s.host.tool("web_search", { query: "greeting ideas" });
  await s.host.emit("tool_result", { toolName: "web_search" });
  return { write: write[0] as { block?: boolean; reason?: string } | undefined, bash: bash[0] as { block?: boolean; reason?: string } | undefined };
}


const CONTINUE_JEV = () => fakeJev({ "*": "rejected", effort: "high" }, { done: 0.1, autonomous: 0.95 });
const CONT_CONFIG = { mode: "on", outbound: { taskIntent: true }, router: { tools: "on" }, effort: "off", harness: { continuation: { enabled: true } }, budget: { maxRequestsPerTask: 8, waitMs: 2000 } };
const MESSAGES = [{ role: "user", content: [{ type: "text", text: PROMPT }] }, { role: "assistant", content: [{ type: "text", text: "It parses things." }] }];
const NEW_PROMPT = "Rename notes.txt to hello.txt";

async function continueOnce(s: Awaited<ReturnType<typeof setup>>) {
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  await s.settled();
  const [result] = await s.host.emit("session_stop", { messages: MESSAGES, stop_hook_active: false, signal: new AbortController().signal }) as Array<{ continue?: boolean; additionalContext?: string } | undefined>;
  assert.equal(result?.continue, true, "fixture: first stop returns our continuation");
  // OMP emits agent_end(willContinue: true) for the settle that queued the continuation.
  await s.host.emit("agent_end", { messages: MESSAGES, willContinue: true });
  return result!;
}

// OMP 18.4.x agent-session.ts: the continuation turn is a scheduled post-prompt task; abort()
// (#cancelPostPromptTasks, #clearPendingSessionStopContinuations) drops it before it starts, so no
// before_agent_start and no further agent_end reach the extension. The next prompt is the user's.
test("DEFECT: continuation pending, user abort before the continuation turn starts, then a new prompt: must be a new task (route + counter reset)", async () => {
  const s = await setup(CONT_CONFIG, { jev: CONTINUE_JEV() });
  try {
    await continueOnce(s);
    assert.match(s.status(), /tasks: 1;/);
    await s.host.emit("input", { source: "interactive" });
    const mark = s.jev.log.length;
    await s.host.emit("before_agent_start", { prompt: NEW_PROMPT });
    await s.settled();
    assert.ok(s.jev.log.slice(mark).some((r) => r.kind === "route"), `new prompt routed: ${JSON.stringify(s.jev.log.slice(mark).map((r) => r.kind))}`);
    assert.match(s.status(), /tasks: 2;/, "the user's new prompt counts as a new task");
    assert.match(s.status(), /continuations this task: 0\//, "continuation count reset for the new task");
  } finally {
    await s.done();
  }
});

test("continuation turn aborted mid-turn (agent_end without willContinue), then a new prompt: new task", async () => {
  const s = await setup(CONT_CONFIG, { jev: CONTINUE_JEV() });
  try {
    const cont = await continueOnce(s);
    await s.host.emit("before_agent_start", { prompt: cont.additionalContext });
    await s.settled();
    assert.match(s.status(), /tasks: 1;/, "our continuation turn is the same task");
    await s.host.emit("agent_end", { messages: MESSAGES, willContinue: false });
    await s.host.emit("input", { source: "interactive" });
    const mark = s.jev.log.length;
    await s.host.emit("before_agent_start", { prompt: NEW_PROMPT });
    await s.settled();
    assert.ok(s.jev.log.slice(mark).some((r) => r.kind === "route"));
    assert.match(s.status(), /tasks: 2;/);
  } finally {
    await s.done();
  }
});

test("our continuation turn: no second route, no task increment, continuation count kept", async () => {
  const s = await setup(CONT_CONFIG, { jev: CONTINUE_JEV() });
  try {
    const cont = await continueOnce(s);
    const mark = s.jev.log.length;
    await s.host.emit("before_agent_start", { prompt: cont.additionalContext });
    await s.settled();
    assert.deepEqual(s.jev.log.slice(mark).filter((r) => r.kind === "route" || r.kind === "effort"), []);
    assert.match(s.status(), /tasks: 1;/);
    assert.match(s.status(), /continuations this task: 1\//);
  } finally {
    await s.done();
  }
});

// ---- shadow isolation --------------------------------------------------------------------------

for (const max of [1, 2, 3]) {
  test(`shadow session, every switch on, maxRequestsPerTask=${max}: shadow observations never exceed their own limit`, async () => {
    const s = await setup({ ...ALL_ON("on", max), mode: "shadow" });
    try {
      const mark = s.jev.log.length;
      await runTask(s);
      for (let i = 0; i < 3; i++) await s.host.tool("write", { path: `n${i}.txt`, content: "x" });
      await s.settled();
      const units = s.jev.log.slice(mark).filter((r) => isTaskUnit(r.kind));
      assert.ok(units.length <= max, `shadow units ${units.length} > ${max}: ${JSON.stringify(units.map((u) => u.kind))}`);
    } finally {
      await s.done();
    }
  });
}

test("mode on, router shadow + effort shadow + enforce on, max 2: shadow ≤ 2, on-mode ≤ 2, enforce not starved", async () => {
  const s = await setup({ mode: "on", outbound: { taskIntent: true }, router: { tools: "shadow" }, effort: "shadow", harness: { enforce: ["create", "overwrite"] }, budget: { maxRequestsPerTask: 2, waitMs: 2000 } });
  try {
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    await s.settled();
    const [write] = await s.host.tool("write", { path: "notes.txt", content: "hello" }) as Array<{ block?: boolean; reason?: string } | undefined>;
    await s.host.tool("write", { path: "b.txt", content: "x" });
    await s.host.tool("write", { path: "c.txt", content: "x" });
    await s.settled();
    const kinds = s.jev.log.map((r) => r.kind);
    const shadow = kinds.filter((k) => k === "route" || k === "effort").length;
    const on = kinds.filter((k) => k === "enforce" || k === "approval").length;
    assert.ok(shadow >= 1 && shadow <= 2, `shadow ${shadow}: ${JSON.stringify(kinds)}`);
    assert.ok(on >= 1 && on <= 2, `on ${on}: ${JSON.stringify(kinds)}`);
    assert.notEqual(write?.block, true, `first write not starved: ${write?.reason}`);
  } finally {
    await s.done();
  }
});

// ---- agent_end isolation -----------------------------------------------------------------------

test("agent_end: a throwing session header (proactive child check) never skips the tool give-back", async () => {
  const s = await setup(ALL_ON("off" as never, 4), { usage: 95 });
  try {
    const baseline = s.host.active();
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    assert.notDeepEqual(sorted(s.host.active()), sorted(baseline), "routing applied");
    const sm = (s.host.ctx as unknown as { sessionManager: Record<string, unknown> }).sessionManager;
    sm.getHeader = () => { throw new Error("header boom"); };
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    assert.deepEqual(sorted(s.host.active()), sorted(baseline), "tools given back");
    await s.settled();
  } finally {
    await s.done();
  }
});
