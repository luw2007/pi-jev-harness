/**
 * integration verification (verifier-owned): every capability on together, including C12
 * effort (on and the default shadow), through the real OMP entry (`createExtension`) against a fake
 * OMP 18.3.5 host and a fake Jev (injected fetch). Checks the per-task budget contract
 * (./src/adapters/omp/budget.ts), the combined agent_end order, `/jev mode off` mid-task, chain
 * wiring per capability, and the safety invariants (off / child / setModel / setThinkingLevel).
 * No ~/.omp, no ~/.pi, no network.
 *
 * Tests whose name starts with "DEFECT:" reproduce defects found by the integration verifier (fixed in L7).
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
  const cwd = await mkdtemp(join(tmpdir(), "omp-t105iv-"));
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
      getSessionId: () => "s-t105iv", getLeafId: () => "leaf-1", getBranch: () => [], getCwd: () => cwd,
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

// ---- 1. every capability on together --------------------------------------------------------------

for (const max of [2, 4, 8]) {
  test(`all capabilities on (effort on, maxRequestsPerTask=${max}): route+effort+enforce+approval units per task ≤ budget; setThinkingLevel once; never setModel`, async () => {
    const s = await setup(ALL_ON("on", max));
    try {
      const mark = s.jev.log.length;
      await runTask(s);
      await s.settled();
      const units = s.jev.log.slice(mark).filter((r) => isTaskUnit(r.kind));
      assert.ok(units.length <= max, `task units ${units.length} > ${max}: ${JSON.stringify(units.map((u) => u.kind))}`);
      assert.equal(s.host.setters.filter((c) => c === "setModel").length, 0);
      assert.ok(s.host.setters.filter((c) => c.startsWith("setThinkingLevel")).length <= 1);
      // A second task gets a fresh counter.
      await s.host.emit("agent_end", { messages: [], willContinue: false });
      const mark2 = s.jev.log.length;
      await s.host.emit("input", { source: "interactive" });
      await s.host.emit("before_agent_start", { prompt: "Another different task: edit notes.txt" });
      await s.host.tool("write", { path: "other.txt", content: "x" });
      await s.settled();
      const units2 = s.jev.log.slice(mark2).filter((r) => isTaskUnit(r.kind));
      assert.ok(units2.length <= max, `task 2 units ${units2.length} > ${max}`);
    } finally {
      await s.done();
    }
  });
}

test("all on, effort on, budget 4: effort level set before the first model request, exactly one setThinkingLevel", async () => {
  const s = await setup(ALL_ON("on", 4));
  try {
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    assert.deepEqual(s.host.setters.filter((c) => c.startsWith("setThinkingLevel")), ["setThinkingLevel:high"]);
    await s.settled();
    assert.equal(s.host.setters.filter((c) => c.startsWith("setThinkingLevel")).length, 1);
  } finally {
    await s.done();
  }
});

test("all on with effort shadow (the default) and effort off: same host behaviour for the write (shadow must not change the host)", async () => {
  const results: Record<string, unknown> = {};
  for (const effort of ["off", "shadow"] as const) {
    const s = await setup({ ...ALL_ON(undefined, 4), effort });
    try {
      const { write } = await runTask(s);
      results[effort] = write?.block === true;
      await s.settled();
      assert.equal(s.host.setters.filter((c) => c.startsWith("setThinkingLevel")).length, 0, `effort ${effort}: no setThinkingLevel`);
    } finally {
      await s.done();
    }
  }
  assert.equal(results.shadow, results.off, JSON.stringify(results));
});

test("DEFECT: default config budget (maxRequestsPerTask 2) + router.tools on + enforce: shadow effort (default) spends the unit enforce needs and the write is blocked", async () => {
  const blocked: Record<string, boolean> = {};
  for (const effort of ["off", "shadow"] as const) {
    const s = await setup({ mode: "on", outbound: { taskIntent: true }, router: { tools: "on" }, harness: { enforce: ["create", "overwrite"] }, effort });
    try {
      await s.host.emit("before_agent_start", { prompt: PROMPT });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [result] = await s.host.tool("write", { path: "notes.txt", content: "hello" }) as Array<{ block?: boolean; reason?: string } | undefined>;
      blocked[effort] = result?.block === true;
      await s.settled();
    } finally {
      await s.done();
    }
  }
  assert.deepEqual(blocked, { off: false, shadow: false }, "shadow effort must not turn an allowed write into a block");
});

// ---- 2. combined agent_end ----------------------------------------------------------------------

test("agent_end order: L4 proactive Jev ask happens before the L2 tool give-back; willContinue skips both", async () => {
  const s = await setup(ALL_ON("off" as never, 4), { usage: 80 });
  try {
    const baseline = s.host.active();
    assert.ok(baseline.includes("jev_recall"), "jev_recall active in mode on + context.request on");
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    const applied = s.host.active();
    assert.notDeepEqual(sorted(applied), sorted(baseline), "routing applied a narrowed set");
    // willContinue: our continuation's settle — no proactive ask, no give-back.
    const before = s.jev.log.length;
    await s.host.emit("agent_end", { messages: [], willContinue: true });
    assert.equal(s.jev.log.slice(before).filter((r) => r.kind === "proactive").length, 0);
    assert.deepEqual(sorted(s.host.active()), sorted(applied));
    s.host.order.length = 0;
    const mark = s.jev.log.length;
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    const proactive = s.jev.log.slice(mark).find((r) => r.kind === "proactive");
    assert.ok(proactive, "proactive asked Jev");
    const restoreIndex = s.host.order.findIndex((o) => o.startsWith("setActiveTools"));
    assert.ok(restoreIndex >= 0, `tools given back: ${JSON.stringify(s.host.order)}`);
    assert.ok(proactive.at > 0 && s.host.order.indexOf("host.compact") === -1 || s.host.order.indexOf("host.compact") > restoreIndex, "deferred compaction runs after the give-back");
    assert.deepEqual(sorted(s.host.active()), sorted(baseline));
    await s.settled();
  } finally {
    await s.done();
  }
});

test("agent_end: host failures inside L4 proactive (getContextUsage / compact / isIdle throw) never skip the L2 give-back", async () => {
  const s = await setup(ALL_ON("off" as never, 4), { usage: 95 });
  try {
    const baseline = s.host.active();
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    assert.notDeepEqual(sorted(s.host.active()), sorted(baseline));
    const ctx = s.host.ctx as unknown as Record<string, unknown>;
    ctx.getContextUsage = () => { throw new Error("usage boom"); };
    ctx.compact = () => { throw new Error("compact boom"); };
    ctx.isIdle = () => { throw new Error("idle boom"); };
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    assert.deepEqual(sorted(s.host.active()), sorted(baseline));
    await s.settled();
  } finally {
    await s.done();
  }
});

test("agent_end: a throwing hasPendingMessages / getAsyncJobSnapshot (proactive hard threshold) still lets the give-back run", async () => {
  const s = await setup(ALL_ON("off" as never, 4), { usage: 95 });
  try {
    const baseline = s.host.active();
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    const ctx = s.host.ctx as unknown as Record<string, unknown>;
    ctx.hasPendingMessages = () => { throw new Error("pending boom"); };
    ctx.getAsyncJobSnapshot = () => { throw new Error("jobs boom"); };
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    assert.deepEqual(sorted(s.host.active()), sorted(baseline));
    await s.settled();
  } finally {
    await s.done();
  }
});

// ---- 3. /jev mode off mid-task ------------------------------------------------------------------

test("/jev mode off mid-task: tools given back, jev_recall deactivated, in-flight context/compaction aborted, stop reset, then zero Jev requests and zero setters", async () => {
  const s = await setup(ALL_ON("on", 8), { usage: 50 });
  try {
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    assert.notDeepEqual(sorted(s.host.active()), sorted(NATIVE), "routing applied");
    // A long session_before_compact and a context reduction hang on Jev.
    s.jev.hang.add("*");
    const bigMessages: unknown[] = [{ role: "user", content: "port the parser" }];
    for (let i = 0; i < 5; i++) {
      bigMessages.push({ role: "assistant", content: [{ type: "text", text: `step c${i}` }, { type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `c${i}.txt` } }] });
      bigMessages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: `c${i}:` + "payload line\n".repeat(3000) }], isError: false });
    }
    bigMessages.push({ role: "assistant", content: [{ type: "text", text: "summary so far" }] });
    const ctxRun = s.host.emit("context", { messages: bigMessages });
    const compactRun = s.host.emit("session_before_compact", { preparation: { messagesToSummarize: bigMessages, turnPrefixMessages: [], firstKeptEntryId: "e1", tokensBefore: 100000, previousSummary: undefined }, branchEntries: [], signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const inflight = s.jev.log.map((r) => r.kind).filter((k) => k !== "route" && k !== "effort");
    assert.ok(inflight.length >= 2, `context + compaction requests in flight at mode off: ${JSON.stringify(inflight)}`);
    const text = await s.host.command("mode off");
    assert.match(text, /off/i);
    const settledBoth = await Promise.race([Promise.allSettled([ctxRun, compactRun]).then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("stuck"), 1500))]);
    assert.equal(settledBoth, "done", "context/compaction aborted by mode off");
    assert.deepEqual(sorted(s.host.active()), sorted(NATIVE), "native tools back, jev_recall gone");
    assert.match(s.status(), /continuations this task: 0\//);
    // After off: nothing talks to Jev or the host.
    s.jev.hang.clear();
    const mark = s.jev.log.length;
    const setters = s.host.setters.length;
    await s.host.emit("before_agent_start", { prompt: "a brand new task after off" });
    await s.host.emit("context", { messages: bigMessages });
    await s.host.tool("write", { path: "n2.txt", content: "y" });
    await s.host.emit("tool_result", { toolName: "write" });
    await s.host.emit("session_stop", { messages: [] });
    await s.host.emit("session_before_compact", { preparation: { messagesToSummarize: bigMessages, turnPrefixMessages: [], firstKeptEntryId: "e1", tokensBefore: 100000 }, branchEntries: [], signal: new AbortController().signal });
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    for (const name of ["jev_plan", "jev_acceptance_gate", "foreman_assess", "jev_route"]) {
      const tool = s.host.tools.get(name);
      if (tool) await tool.execute("t", { task: "plan this", answer: "done", intent: "read files" }, undefined, undefined, s.host.ctx);
    }
    await s.settled();
    assert.equal(s.jev.log.length, mark, `Jev requests after off: ${JSON.stringify(s.jev.log.slice(mark))}`);
    assert.equal(s.host.setters.length, setters, `host setters after off: ${JSON.stringify(s.host.setters.slice(setters))}`);
  } finally {
    await s.done();
  }
});

// ---- 4. chain wiring ------------------------------------------------------------------------------

test("chain wiring: each OMP call site uses its capability's chain (route/effort/assess(enforce)/acceptance(approval)/compact/toolContext/plan)", async () => {
  const provider = (id: string) => [{ id, url: `https://${id}.example.invalid/v1`, model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "FAKE_CHAIN_KEY" }];
  const chain = {
    providers: provider("default"),
    capabilities: Object.fromEntries(["route", "effort", "assess", "acceptance", "compact", "toolContext", "plan"].map((c) => [c, provider(c.toLowerCase())])),
  };
  const s = await setup({ ...ALL_ON("shadow", 8), mode: "on", jev: chain }, { env: { FAKE_CHAIN_KEY: "fake-chain-secret-abc" }, usage: 50 });
  try {
    await runTask(s);
    await s.host.tools.get("jev_plan")!.execute("t", { task: "split the refactor into parts" }, undefined, undefined, s.host.ctx);
    await s.settled();
    const byKind = new Map<string, Set<string>>();
    for (const r of s.jev.log) byKind.set(r.kind, new Set([...(byKind.get(r.kind) ?? []), new URL(r.url).hostname.split(".")[0]!]));
    const hosts = (kind: string) => [...(byKind.get(kind) ?? [])];
    assert.deepEqual(hosts("effort"), ["effort"], JSON.stringify([...byKind]));
    assert.deepEqual(hosts("enforce"), ["assess"]);
    assert.deepEqual(hosts("approval"), ["acceptance"]);
    assert.ok(!s.jev.log.some((r) => r.url.includes("default.example")), `no call fell back to the default chain: ${JSON.stringify([...byKind])}`);
  } finally {
    await s.done();
  }
});

test("chain secrets: a chain-only key in a tool input withholds enforce/approval reviews (credential scan covers chainSecrets)", async () => {
  const chain = { providers: [{ id: "alpha", url: "https://alpha.example.invalid/v1", model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "FAKE_ALPHA_KEY" }] };
  const s = await setup({ ...ALL_ON(undefined, 8), effort: "off", router: { tools: "off" }, jev: chain }, { env: { FAKE_ALPHA_KEY: "fake-alpha-secret-xyz" } });
  try {
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    const mark = s.jev.log.length;
    await s.host.tool("write", { path: "notes.txt", content: "token fake-alpha-secret-xyz" });
    await s.settled();
    const sent = s.jev.log.slice(mark).filter((r) => r.kind === "enforce" || r.kind === "approval");
    assert.deepEqual(sent, [], "no review carried the chain key");
  } finally {
    await s.done();
  }
});

// ---- 6. safety invariants ------------------------------------------------------------------------

test("mode off with every switch on: zero Jev requests, zero host setters; only registration happens", async () => {
  const s = await setup({ ...ALL_ON("on", 8), mode: "off" }, { usage: 95 });
  try {
    await runTask(s);
    await s.host.emit("session_stop", { messages: [] });
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    await s.host.tools.get("jev_plan")!.execute("t", { task: "plan" }, undefined, undefined, s.host.ctx);
    await s.settled();
    assert.deepEqual(s.jev.log, []);
    assert.deepEqual(s.host.setters, []);
    assert.ok(!s.host.handlerNames().includes("session_before_compact"), "compaction handler not registered when off at startup");
  } finally {
    await s.done();
  }
});

test("child session with every switch on (mode on): no Jev request from any hook, no setter", async () => {
  const s = await setup(ALL_ON("on", 8), { child: true, usage: 95 });
  try {
    await runTask(s);
    await s.host.emit("session_stop", { messages: [] });
    await s.host.emit("session_before_compact", { preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: "e1", tokensBefore: 1 }, branchEntries: [], signal: new AbortController().signal });
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    await s.settled();
    assert.deepEqual(s.jev.log.map((r) => r.kind), []);
    // jev_recall activation at session_start happens before any child check (session-level, not per task).
    assert.deepEqual(s.host.setters.filter((c) => c !== "setActiveTools"), []);
  } finally {
    await s.done();
  }
});

test("shadow session with effort on + every switch on: never setThinkingLevel / setModel / setActiveTools", async () => {
  const s = await setup({ ...ALL_ON("on", 8), mode: "shadow" }, { usage: 95 });
  try {
    await runTask(s);
    await s.host.emit("session_stop", { messages: [] });
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    await s.settled();
    assert.deepEqual(s.host.setters, []);
    assert.ok(s.jev.log.some((r) => r.kind === "effort"), "shadow effort still asks");
  } finally {
    await s.done();
  }
});

test("/jev mode off during an in-flight session_stop (mode on): no continuation returned, stop state reset, no request after off", async () => {
  const s = await setup({ ...ALL_ON("off" as never, 8), router: { tools: "off" } });
  try {
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    const messages = [{ role: "user", content: PROMPT }, { role: "assistant", content: [{ type: "text", text: "I created notes.txt" }] }];
    // First stop: record whether a continuation is granted, so the reset below is observable.
    const [first] = await s.host.emit("session_stop", { messages, signal: new AbortController().signal }) as Array<{ continue?: boolean } | undefined>;
    const usedBefore = first?.continue ? 1 : 0;
    assert.match(s.status(), new RegExp(`continuations this task: ${usedBefore}/2`));
    s.jev.hang.add("*");
    const stop = s.host.emit("session_stop", { messages, signal: new AbortController().signal, stop_hook_active: first?.continue === true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mark = s.jev.log.length;
    await s.host.command("mode off");
    const [result] = await Promise.race([stop, new Promise<unknown[]>((resolve) => setTimeout(() => resolve(["stuck"]), 1500))]);
    assert.notEqual(result, "stuck", "in-flight stop check aborted by mode off");
    assert.ok(!(result as { continue?: boolean } | undefined)?.continue, "no continuation after mode off");
    assert.match(s.status(), /continuations this task: 0\/2/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(s.jev.log.length, mark, `requests after off: ${JSON.stringify(s.jev.log.slice(mark))}`);
  } finally {
    await s.done();
  }
});

// OMP (oh-my-pi agent-session.ts #emitSessionStopEvent → #queueHiddenNextTurnMessage →
// #promptWithMessage → #prepareAgentStart → emitBeforeAgentStart) runs `before_agent_start` for
// our own session_stop continuation turn, with the additionalContext as the prompt. L3 treats that
// turn as the same task (stop.ts startTask); budget.ts rule 1 says the per-task counter resets only
// at a new task.
test("DEFECT: our continuation turn's before_agent_start resets the per-task counter (route+effort units per task exceed maxRequestsPerTask)", async () => {
  const jev = fakeJev({ "*": "rejected", effort: "high" }, { done: 0.1, autonomous: 0.95 });
  const s = await setup({ mode: "on", outbound: { taskIntent: true }, router: { tools: "shadow" }, effort: "shadow", harness: { continuation: { enabled: true } }, budget: { maxRequestsPerTask: 2, waitMs: 2000 } }, { jev });
  try {
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    await s.settled();
    const messages = [{ role: "user", content: [{ type: "text", text: PROMPT }] }, { role: "assistant", content: [{ type: "text", text: "It parses things." }] }];
    let continued = 0;
    for (let i = 0; i < 3; i++) {
      const [result] = await s.host.emit("session_stop", { messages, stop_hook_active: continued > 0, signal: new AbortController().signal }) as Array<{ continue?: boolean; additionalContext?: string } | undefined>;
      await s.host.emit("agent_end", { messages, willContinue: result?.continue === true });
      if (!result?.continue) break;
      continued++;
      // Real OMP: the hidden continuation turn goes through before_agent_start with the context text.
      await s.host.emit("before_agent_start", { prompt: result.additionalContext });
      await s.settled();
    }
    assert.ok(continued >= 1, "fixture produced at least one continuation");
    const units = s.jev.log.filter((r) => isTaskUnit(r.kind));
    assert.ok(units.length <= 2, `one task (${continued} continuation turns) spent ${units.length} task units > maxRequestsPerTask 2: ${JSON.stringify(units.map((u) => u.kind))}`);
  } finally {
    await s.done();
  }
});

test("T105 L7: an agent_end step that throws (proactive session view) does not skip the L2 give-back", async () => {
  const s = await setup(ALL_ON("off" as never, 4), { usage: 95 });
  try {
    const baseline = s.host.active();
    await s.host.emit("before_agent_start", { prompt: PROMPT });
    assert.notDeepEqual(sorted(s.host.active()), sorted(baseline));
    // ompSessionView(ctx) in the proactive step reads the session manager outside its own try.
    Object.defineProperty(s.host.ctx, "sessionManager", { configurable: true, get: () => { throw new Error("session boom"); } });
    await s.host.emit("agent_end", { messages: [], willContinue: false });
    assert.deepEqual(sorted(s.host.active()), sorted(baseline), "give-back ran although the proactive step threw");
  } finally {
    await s.done().catch(() => {});
  }
});
