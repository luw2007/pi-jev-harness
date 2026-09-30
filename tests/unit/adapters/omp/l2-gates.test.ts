/**
 * T105 L2 (C1 tool apply, C2 enforce, C3 approval + steer) against a fake OMP host and a fake Jev.
 * The fake host mimics OMP 18.3.5: awaits before_agent_start before the first model request, blocks
 * a tool when any tool_call handler returns `{block}`, and `setActiveTools` is async.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { STEER_REMINDER } from "../../../../src/adapters/omp/approval.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolInfo } from "../../../../src/adapters/omp/types.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.omp");
const KEY = "l2-test-key-0123456789";
const PROMPT = "Create the file notes.txt with a short greeting";

const TOOLS: OmpToolInfo[] = ["read", "bash", "write", "edit", "grep", "web_search", "browser"].map((name) => ({
  name, description: `${name} tool`, parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" },
}));

interface Options { hasUI?: boolean; confirm?: boolean; child?: boolean; hang?: boolean }

async function fakeHost(options: Options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-l2-"));
  const handlers = new Map<string, OmpHandler[]>();
  let active = TOOLS.map((tool) => tool.name);
  const setterCalls: string[] = [];
  const confirms: string[] = [];
  const steers: unknown[] = [];
  const executed: string[] = [];
  const modelRequests: string[][] = [];
  const commandMap = new Map<string, { name: string; source: "extension"; description?: string }>();
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => (options.child ? { parentSession: "parent-1" } : {}), getSessionId: () => "s1" },
    getContextUsage: () => undefined,
    hasUI: options.hasUI ?? true,
    cwd,
    ui: {
      notify: () => {},
      confirm: async (title) => { confirms.push(title); return options.hang ? new Promise<boolean>(() => {}) : options.confirm ?? false; },
    },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: "18.3.5" },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name, options) {
      commandMap.set(name, { name, source: "extension", description: options?.description });
    },
    getCommands: () => [...commandMap.values()],
    getAllTools: () => TOOLS,
    getActiveTools: () => [...active],
    getThinkingLevel: () => "medium",
    setActiveTools: async (names: string[]) => {
      setterCalls.push("setActiveTools");
      await new Promise((resolve) => setTimeout(resolve, 5));
      active = [...names];
    },
    sendMessage: (message, opts) => { steers.push({ message, opts }); },
    setModel: () => { setterCalls.push("setModel"); },
    setThinkingLevel: () => { setterCalls.push("setThinkingLevel"); },
  };
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  let calls = 0;
  return {
    api, ctx, cwd, setterCalls, confirms, steers, executed, modelRequests, emit,
    active: () => [...active],
    /** OMP: await before_agent_start, then the first model request carries the active tool set. */
    async prompt(text: string) {
      await emit("before_agent_start", { prompt: text });
      modelRequests.push([...active]);
    },
    /** OMP: a tool runs only when no tool_call handler blocked it. */
    async tool(toolName: string, input: Record<string, unknown>) {
      const results = (await emit("tool_call", { toolCallId: `call-${++calls}`, toolName, input })) as Array<{ block?: boolean; reason?: string } | undefined>;
      const blocked = results.find((result) => result?.block);
      if (!blocked) {
        executed.push(toolName);
        if (toolName === "write") await writeFile(join(cwd, String(input.path)), String(input.content));
      }
      await emit("tool_result", { toolCallId: `call-${calls}`, toolName });
      return blocked;
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

/** Fake Jev: choice picks `pick` when offered; noul answers from `noul` by question id. */
function fakeJev(pick: string | undefined, noul: Record<string, number>) {
  const state = { requests: 0, noulIds: [] as string[] };
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    state.requests++;
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type === "noul") {
        state.noulIds.push(id);
        return [id, { type: "noul", noul: noul[id] ?? 0.5 }];
      }
      const options = Object.keys(question.criteria ?? {});
      const choice = pick && options.includes(pick) ? pick : options[0]!;
      const rest = 0.05 / Math.max(1, options.length - 1);
      return [id, { type: "choice", choice, confidence: 0.95, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.95 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

const FAVORABLE = { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05 };
const UNFAVORABLE = { addresses_task: 0.1, evidence_supports: 0.1, unrelated_changes: 0.9, needs_clarification: 0.9 };

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

async function setup(config: Record<string, unknown>, options: Options & { pick?: string; noul?: Record<string, number>; key?: boolean } = {}) {
  const host = await fakeHost(options);
  const jev = fakeJev(options.pick, options.noul ?? FAVORABLE);
  const registry: Record<symbol, { host: { settled(): Promise<void>; statusText(): string } }> = {};
  createExtension({
    env: options.key === false ? {} : { TYPESAFE_API_KEY: KEY },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify({ effort: "off", ...config }) /* C12 effort (L6) off: these count C1–C3 traffic */ }),
    fetch: jev.fetch,
    now: () => 0,
    newId,
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry)(host.api);
  await host.emit("session_start");
  return { host, jev, status: () => registry[CLAIM]!.host.statusText(), settled: () => registry[CLAIM]!.host.settled() };
}

const ON = { mode: "on", outbound: { taskIntent: true } };

// ---- C1 ------------------------------------------------------------------------------------------

test("C1 on + router.tools on: first model request carries exactly the applied set; restored at task end", async () => {
  const s = await setup({ ...ON, router: { tools: "on" } }, { pick: "write" });
  await s.host.prompt(PROMPT);
  const applied = s.host.modelRequests[0]!;
  assert.ok(s.host.setterCalls.includes("setActiveTools"));
  assert.deepEqual(applied, s.host.active());
  assert.ok(applied.length < 7 && applied.includes("write") && applied.includes("read"), JSON.stringify(applied));
  assert.ok(!applied.includes("browser"));
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  assert.deepEqual(s.host.active().sort(), TOOLS.map((t) => t.name).sort());
  assert.ok(!s.host.setterCalls.includes("setModel") && !s.host.setterCalls.includes("setThinkingLevel"));
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C1 Jev unavailable (no key): native tools kept, no setter", async () => {
  const s = await setup({ ...ON, router: { tools: "on" } }, { key: false });
  await s.host.prompt(PROMPT);
  assert.deepEqual(s.host.modelRequests[0], TOOLS.map((t) => t.name));
  assert.deepEqual(s.host.setterCalls, []);
  assert.equal(s.jev.state.requests, 0);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C1 shadow + router.tools on: would-apply recorded, host unchanged", async () => {
  const s = await setup({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "on" } }, { pick: "write" });
  await s.host.prompt(PROMPT);
  await s.settled();
  assert.deepEqual(s.host.setterCalls, []);
  assert.deepEqual(s.host.modelRequests[0], TOOLS.map((t) => t.name));
  assert.match(s.status(), /would-apply 1/);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C1 child session: nothing applied", async () => {
  const s = await setup({ ...ON, router: { tools: "on" } }, { pick: "write", child: true });
  await s.host.prompt(PROMPT);
  assert.deepEqual(s.host.setterCalls, []);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

// ---- C2 ------------------------------------------------------------------------------------------

test("C2 on + enforce create: an unfavorable review blocks and the tool never executes", async () => {
  const s = await setup({ ...ON, router: { tools: "off" }, harness: { enforce: ["create"] } }, { noul: UNFAVORABLE });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("write", { path: "notes.txt", content: "hello" });
  assert.ok(blocked?.block && /pi-jev-harness/.test(blocked.reason ?? ""));
  assert.deepEqual(s.host.executed, []);
  assert.ok(!existsSync(join(s.host.cwd, "notes.txt")));
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C2 on + enforce create: a favorable review lets the write run", async () => {
  const s = await setup({ ...ON, router: { tools: "off" }, harness: { enforce: ["create"] } });
  await s.host.prompt(PROMPT);
  assert.equal(await s.host.tool("write", { path: "notes.txt", content: "hello" }), undefined);
  assert.deepEqual(s.host.executed, ["write"]);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C2 on: outbound gate closed → review unavailable → blocked with zero Jev requests", async () => {
  const s = await setup({ mode: "on", router: { tools: "off" }, harness: { enforce: ["create"] } });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("write", { path: "notes.txt", content: "hello" });
  assert.match(blocked?.reason ?? "", /outbound\.taskIntent=false/);
  assert.equal(s.jev.state.requests, 0);
  assert.deepEqual(s.host.executed, []);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C2 shadow: would-block recorded, the tool runs", async () => {
  const s = await setup({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "off" }, harness: { enforce: ["create"] } }, { noul: UNFAVORABLE });
  await s.host.prompt(PROMPT);
  assert.equal(await s.host.tool("write", { path: "notes.txt", content: "hello" }), undefined);
  await s.settled();
  assert.deepEqual(s.host.executed, ["write"]);
  assert.match(s.status(), /blocked 0, would-block 1/);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

// ---- C3 ------------------------------------------------------------------------------------------

const APPROVAL = { ...ON, router: { tools: "off" }, approval: { enabled: true } };

test("C3 deny-list tool: confirm deny blocks, confirm allow runs", async () => {
  for (const confirm of [false, true]) {
    const s = await setup(APPROVAL, { confirm });
    await s.host.prompt(PROMPT);
    const blocked = await s.host.tool("bash", { command: "ls" });
    assert.equal(s.host.confirms.length, 1);
    assert.equal(Boolean(blocked?.block), !confirm);
    assert.deepEqual(s.host.executed, confirm ? ["bash"] : []);
    await s.host.emit("session_shutdown");
    await s.host.cleanup();
  }
});

test("C3 no UI: default deny; approval.noUi allow runs", async () => {
  for (const noUi of [undefined, "allow"]) {
    const s = await setup({ ...APPROVAL, approval: { enabled: true, ...(noUi ? { noUi } : {}) } }, { hasUI: false });
    await s.host.prompt(PROMPT);
    const blocked = await s.host.tool("bash", { command: "ls" });
    assert.equal(s.host.confirms.length, 0);
    assert.equal(Boolean(blocked?.block), noUi === undefined);
    await s.host.emit("session_shutdown");
    await s.host.cleanup();
  }
});

test("C3 confirm timeout: min(confirmTimeoutMs, 25s), then the no-UI policy (default deny, reason timeout)", async () => {
  for (const noUi of [undefined, "allow"]) {
    const s = await setup({ ...APPROVAL, approval: { enabled: true, confirmTimeoutMs: 20, ...(noUi ? { noUi } : {}) } }, { hang: true });
    await s.host.prompt(PROMPT);
    const blocked = await s.host.tool("bash", { command: "ls" });
    assert.equal(s.host.confirms.length, 1);
    if (noUi) assert.equal(blocked, undefined);
    else assert.match(blocked?.reason ?? "", /timeout/);
    await s.host.emit("session_shutdown");
    await s.host.cleanup();
  }
});

test("C3 other tools: Jev irreversible risk decides whether to ask; allow-list never asks", async () => {
  const low = await setup(APPROVAL, { noul: { irreversible: 0.05 } });
  await low.host.prompt(PROMPT);
  assert.equal(await low.host.tool("web_search", { q: "x" }), undefined);
  assert.equal(await low.host.tool("read", { path: "a" }), undefined);
  assert.equal(low.host.confirms.length, 0);
  assert.deepEqual(low.jev.state.noulIds, ["irreversible"]);
  await low.host.emit("session_shutdown");
  await low.host.cleanup();

  const high = await setup(APPROVAL, { noul: { irreversible: 0.9 } });
  await high.host.prompt(PROMPT);
  assert.ok((await high.host.tool("web_search", { q: "x" }))?.block);
  assert.equal(high.host.confirms.length, 1);
  await high.host.emit("session_shutdown");
  await high.host.cleanup();
});

test("C3 shadow: no confirm, no block, would-confirm recorded", async () => {
  const s = await setup({ ...APPROVAL, mode: "shadow" });
  await s.host.prompt(PROMPT);
  assert.equal(await s.host.tool("bash", { command: "ls" }), undefined);
  assert.equal(s.host.confirms.length, 0);
  assert.match(s.status(), /would-confirm 1/);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C3 steer: fires at the 5th silent tool result, resets on assistant text, off by default", async () => {
  const s = await setup({ ...ON, router: { tools: "off" }, approval: { silentSteer: true } });
  await s.host.prompt(PROMPT);
  for (let i = 0; i < 4; i++) await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, 0);
  await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, 1);
  assert.deepEqual(s.host.steers[0], { message: { customType: "jev-autorun-reminder", content: STEER_REMINDER, display: true }, opts: { deliverAs: "steer" } });
  for (let i = 0; i < 4; i++) await s.host.tool("read", { path: "a" });
  await s.host.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "progress" }] } });
  await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, 1);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();

  const off = await setup({ ...ON, router: { tools: "off" } });
  await off.host.prompt(PROMPT);
  for (let i = 0; i < 6; i++) await off.host.tool("read", { path: "a" });
  assert.equal(off.host.steers.length, 0);
  await off.host.emit("session_shutdown");
  await off.host.cleanup();
});

// ---- off -----------------------------------------------------------------------------------------

test("off: zero Jev requests, zero setters, no block/confirm/steer even with every switch on", async () => {
  const s = await setup({ mode: "off", outbound: { taskIntent: true }, router: { tools: "on" }, harness: { enforce: ["create"] }, approval: { enabled: true, silentSteer: true } }, { noul: UNFAVORABLE });
  await s.host.prompt(PROMPT);
  for (let i = 0; i < 6; i++) await s.host.tool("bash", { command: "ls" });
  assert.equal(await s.host.tool("write", { path: "notes.txt", content: "hello" }), undefined);
  assert.equal(s.jev.state.requests, 0);
  assert.deepEqual(s.host.setterCalls, []);
  assert.equal(s.host.confirms.length + s.host.steers.length, 0);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("C1 before_agent_start retried within one task: no second route or apply", async () => {
  const s = await setup({ ...ON, router: { tools: "on" } }, { pick: "write" });
  await s.host.prompt(PROMPT);
  const requests = s.jev.state.requests;
  const setters = s.host.setterCalls.length;
  await s.host.prompt(PROMPT);
  assert.equal(s.jev.state.requests, requests);
  assert.equal(s.host.setterCalls.length, setters);
  assert.deepEqual(s.host.modelRequests[1], s.host.modelRequests[0]);
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  await s.host.prompt(PROMPT);
  assert.ok(s.jev.state.requests > requests, "a new task after agent_end routes again");
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("status in on + router.tools on says 应用", async () => {
  const s = await setup({ ...ON, router: { tools: "on" } });
  assert.match(s.status(), /路由：应用/);
  await s.host.emit("session_shutdown");
  await s.host.cleanup();
});

test("Pi config still refuses the approval section", async () => {
  const { loadConfig } = await import("../../../../src/adapters/shared/index.ts");
  const pi = await loadConfig({ home: "/h", path: "/x", readText: async () => JSON.stringify({ approval: { enabled: true } }) });
  assert.equal(pi.source, "invalid");
});
