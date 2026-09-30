/**
 * T105 L2 verification (verifier-owned): boundary, failure and parity cases for C1 tool apply,
 * C2 enforce and C3 approval + steer, driven through the real OMP extension entry
 * (`createExtension`) against a fake OMP 18.3.5 host and a fake Jev. No real model or Jev.
 *
 * Tests named "DEFECT:" encode expected behavior that the current implementation does not meet.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { MAX_STEERS } from "../../../../src/adapters/omp/approval.ts";
import { ENFORCE_MAX_WAIT_MS } from "../../../../src/adapters/omp/enforce.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolInfo } from "../../../../src/adapters/omp/types.ts";
import { loadConfig } from "../../../../src/adapters/shared/index.ts";
import { restoreOwnedTools as coreRestore } from "../../../../src/adapters/core/port.ts";
import { restoreOwnedTools as piRestore } from "../../../../src/adapters/pi/tools.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.omp");
const KEY = "l2-verify-key-0123456789";
const PROMPT = "Create the file notes.txt with a short greeting";
const NATIVE = ["read", "bash", "write", "edit", "grep", "web_search", "browser"];
const TOOLS: OmpToolInfo[] = NATIVE.map((name) => ({
  name, description: `${name} tool`, parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" },
}));

type SetBehavior = "normal" | "drop_one" | "throw";
interface HostOptions {
  hasUI?: boolean;
  confirm?: boolean | "reject";
  child?: boolean;
  setDelayMs?: number;
  setBehavior?: SetBehavior;
}

async function fakeHost(options: HostOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-l2v-"));
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: OmpContext) => unknown; description?: string }>();
  let active = [...NATIVE];
  let setCount = 0;
  const setterCalls: string[] = [];
  const confirms: string[] = [];
  const steers: unknown[] = [];
  const executed: string[] = [];
  const modelRequests: string[][] = [];
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => (options.child ? { parentSession: "parent-1" } : {}), getSessionId: () => "s1" },
    getContextUsage: () => undefined,
    hasUI: options.hasUI ?? true,
    cwd,
    ui: {
      notify: () => {},
      confirm: async (title) => {
        confirms.push(title);
        if (options.confirm === "reject") throw new Error("dialog failed");
        return options.confirm ?? false;
      },
    },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: "18.3.5" },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name, command) { commands.set(name, command as never); },
    getCommands: () => [...commands.entries()].map(([name, cmd]) => ({ name, source: "extension", description: cmd.description })),
    getAllTools: () => TOOLS,
    getActiveTools: () => [...active],
    getThinkingLevel: () => "medium",
    setActiveTools: async (names: string[]) => {
      setterCalls.push("setActiveTools");
      setCount++;
      await new Promise((resolve) => setTimeout(resolve, options.setDelayMs ?? 5));
      if (options.setBehavior === "throw") throw new Error("host refused");
      // drop_one: the first apply silently drops a name (read-back mismatch); later calls behave.
      active = options.setBehavior === "drop_one" && setCount === 1 ? names.slice(1) : [...names];
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
    command: (args: string) => commands.get("jev")!.handler(args, ctx),
    async prompt(text: string) {
      await emit("before_agent_start", { prompt: text });
      modelRequests.push([...active]);
    },
    /** OMP 18.3.5 `emitToolCall`: a handler rejection becomes a block ("Extension ... failed"). */
    async tool(toolName: string, input: unknown) {
      let results: Array<{ block?: boolean; reason?: string } | undefined>;
      try {
        results = (await emit("tool_call", { toolCallId: `call-${++calls}`, toolName, input })) as typeof results;
      } catch (error) {
        return { block: true, reason: `Extension failed: ${(error as Error).message}`, threw: true };
      }
      const blocked = results.find((result) => result?.block);
      if (!blocked) {
        executed.push(toolName);
        const i = input as { path?: unknown; content?: unknown } | null;
        if (toolName === "write" && i && typeof i.path === "string") await writeFile(join(cwd, i.path), String(i.content));
      }
      await emit("tool_result", { toolCallId: `call-${calls}`, toolName });
      return blocked;
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

/**
 * Fake Jev. `hang`: never answers, but honors the request abort signal. `delays[i]`: request i
 * answers after that many ms (Infinity = hang).
 */
function fakeJev(pick: string | undefined, noul: Record<string, number>, hang = false, delays: number[] = []) {
  const state = { requests: 0, noulIds: [] as string[] };
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    const delay = delays[state.requests] ?? 0;
    state.requests++;
    if (delay > 0 && Number.isFinite(delay)) await new Promise((resolve) => setTimeout(resolve, delay));
    if (hang || delay === Infinity) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    }
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

const FAVORABLE = { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05, irreversible: 0.05 };
const UNFAVORABLE = { addresses_task: 0.1, evidence_supports: 0.1, unrelated_changes: 0.9, needs_clarification: 0.9 };

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

type SetupOptions = HostOptions & { pick?: string; noul?: Record<string, number>; key?: boolean; hang?: boolean; delays?: number[] };

async function setup(config: Record<string, unknown>, options: SetupOptions = {}) {
  const host = await fakeHost(options);
  const jev = fakeJev(options.pick, options.noul ?? FAVORABLE, options.hang, options.delays);
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
  const done = async () => {
    await host.emit("session_shutdown");
    await host.cleanup();
  };
  return { host, jev, status: () => registry[CLAIM]!.host.statusText(), settled: () => registry[CLAIM]!.host.settled(), done };
}

const ON = { mode: "on", outbound: { taskIntent: true } };
const TOOLS_ON = { ...ON, router: { tools: "on" } };
const sorted = (xs: readonly string[]) => [...xs].sort();

// ---- C1 ------------------------------------------------------------------------------------------

test("C1 read-back mismatch: previous set restored, first request carries the native set", async () => {
  const s = await setup(TOOLS_ON, { pick: "write", setBehavior: "drop_one" });
  await s.host.prompt(PROMPT);
  assert.equal(s.host.setterCalls.length, 2, "apply + restore");
  assert.deepEqual(sorted(s.host.modelRequests[0]!), sorted(NATIVE));
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  assert.deepEqual(sorted(s.host.active()), sorted(NATIVE));
  await s.done();
});

test("C1 host setActiveTools rejects: handler does not throw, native tools kept", async () => {
  const s = await setup(TOOLS_ON, { pick: "write", setBehavior: "throw" });
  await s.host.prompt(PROMPT);
  assert.deepEqual(sorted(s.host.modelRequests[0]!), sorted(NATIVE));
  assert.match(s.status(), /native kept 1/);
  await s.done();
});

test("C1 slow async setActiveTools (80 ms) is awaited before the first request", async () => {
  const s = await setup(TOOLS_ON, { pick: "write", setDelayMs: 80 });
  await s.host.prompt(PROMPT);
  const first = s.host.modelRequests[0]!;
  assert.ok(first.length < NATIVE.length && !first.includes("browser"), JSON.stringify(first));
  assert.deepEqual(first, s.host.active());
  await s.done();
});

test("C1 willContinue:true keeps the applied set; the terminal agent_end restores it", async () => {
  const s = await setup(TOOLS_ON, { pick: "write" });
  await s.host.prompt(PROMPT);
  const applied = s.host.active();
  await s.host.emit("agent_end", { messages: [], willContinue: true });
  assert.deepEqual(s.host.active(), applied);
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  assert.deepEqual(sorted(s.host.active()), sorted(NATIVE));
  await s.done();
});

test("C1 session_shutdown without agent_end restores the owned tools", async () => {
  const s = await setup(TOOLS_ON, { pick: "write" });
  await s.host.prompt(PROMPT);
  assert.ok(s.host.active().length < NATIVE.length);
  await s.host.emit("session_shutdown");
  assert.deepEqual(sorted(s.host.active()), sorted(NATIVE));
  await s.host.cleanup();
});

test("C1 second task without agent_end: previous removals given back before re-applying (baseline stays native)", async () => {
  const s = await setup(TOOLS_ON, { pick: "write" });
  await s.host.prompt(PROMPT);
  await s.host.prompt(PROMPT);
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  assert.deepEqual(sorted(s.host.active()), sorted(NATIVE));
  await s.done();
});

test("C1 outbound gate closed: zero Jev requests, zero setters, native tools", async () => {
  const s = await setup({ mode: "on", router: { tools: "on" } }, { pick: "write" });
  await s.host.prompt(PROMPT);
  assert.equal(s.jev.state.requests, 0);
  assert.deepEqual(s.host.setterCalls, []);
  assert.deepEqual(s.host.modelRequests[0], NATIVE);
  await s.done();
});

test("C1 credential in the prompt: zero Jev requests, zero setters", async () => {
  const s = await setup(TOOLS_ON, { pick: "write" });
  await s.host.prompt(`${PROMPT} using key ${KEY}`);
  assert.equal(s.jev.state.requests, 0);
  assert.deepEqual(s.host.setterCalls, []);
  await s.done();
});

test("C1 mode on + router.tools shadow: no setter, would-apply only", async () => {
  const s = await setup({ ...ON, router: { tools: "shadow" } }, { pick: "write" });
  await s.host.prompt(PROMPT);
  await s.settled();
  assert.deepEqual(s.host.setterCalls, []);
  assert.match(s.status(), /would-apply 1/);
  await s.done();
});

test("DEFECT: C1 `/jev mode off` mid-task: the applied tools are still given back at task end", async () => {
  const s = await setup(TOOLS_ON, { pick: "write" });
  await s.host.prompt(PROMPT);
  assert.ok(s.host.active().length < NATIVE.length);
  await s.host.command("mode off");
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  await s.host.prompt("next task");
  assert.deepEqual(sorted(s.host.active()), sorted(NATIVE), "tools stay reduced until session_shutdown");
  await s.done();
});

// ---- C2 ------------------------------------------------------------------------------------------

const ENFORCE = { ...ON, router: { tools: "off" }, harness: { enforce: ["create", "overwrite"] } };

test("C2 validation failure (path outside cwd): blocked, reason surfaced, zero Jev requests, never executed", async () => {
  const s = await setup(ENFORCE);
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("write", { path: "../escape-l2v.txt", content: "x" });
  assert.ok(blocked?.block && !("threw" in blocked), JSON.stringify(blocked));
  assert.match(blocked.reason ?? "", /^pi-jev-harness: .+/);
  assert.equal(s.jev.state.requests, 0);
  assert.deepEqual(s.host.executed, []);
  await s.done();
});

test("C2 overwrite of an existing file with an unfavorable review: blocked, file unchanged", async () => {
  const s = await setup(ENFORCE, { noul: UNFAVORABLE });
  await writeFile(join(s.host.cwd, "keep.txt"), "original");
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("write", { path: "keep.txt", content: "clobber" });
  assert.ok(blocked?.block);
  assert.deepEqual(s.host.executed, []);
  await s.done();
});

test("C2 malformed tool_call inputs never make the handler throw", async () => {
  const s = await setup({ ...ENFORCE, approval: { enabled: true } }, { confirm: true });
  await s.host.prompt(PROMPT);
  for (const [tool, input] of [["write", null], ["write", undefined], ["write", { path: 42 }], ["edit", "str"], ["bash", { command: { nested: true } }]] as const) {
    const result = await s.host.tool(tool, input);
    assert.ok(!(result && "threw" in result), `${tool}: ${JSON.stringify(result)}`);
  }
  await s.done();
});

test("C2 hanging Jev: the review wait is capped by budget.waitMs and blocks with a reason (cap constant < 30 s)", async () => {
  assert.ok(ENFORCE_MAX_WAIT_MS < 30_000);
  const s = await setup({ ...ENFORCE, budget: { waitMs: 150 } }, { hang: true });
  await s.host.prompt(PROMPT);
  const started = Date.now();
  const blocked = await s.host.tool("write", { path: "notes.txt", content: "hello" });
  const elapsed = Date.now() - started;
  assert.ok(blocked?.block && !("threw" in blocked));
  assert.ok(elapsed < 1_500, `elapsed ${elapsed}`);
  assert.ok(!existsSync(join(s.host.cwd, "notes.txt")));
  await s.done();
});

test("DEFECT: C2+C3 one tool_call handler: enforce wait + approval Jev wait together stay within one wait cap", async (t) => {
  // write removed from denyTools so approval asks Jev after enforce: two sequential min(waitMs, 25 s)
  // waits in one handler, i.e. up to 2 × 20 s (default waitMs) > OMP's 30 s tool_call timeout.
  const waitMs = 150;
  // Review answers (favorable) just inside the cap; the approval risk question then hangs.
  const s = await setup({ ...ENFORCE, budget: { waitMs, maxRequestsPerTask: 4 }, approval: { enabled: true, denyTools: ["bash"] } }, { delays: [120, Infinity], confirm: true });
  await s.host.prompt(PROMPT);
  // Virtual clock (timers + Date) so the 120 ms review answer and the 150 ms cap are exact, not a
  // race against wall-clock scheduling. Real I/O (file reads in prepare) is awaited via setImmediate.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const untilRequests = async (n: number) => { while (s.jev.state.requests < n) await nextTurn(); };
  const started = Date.now();
  const handled = s.host.tool("write", { path: "notes.txt", content: "hello" });
  await untilRequests(1);
  t.mock.timers.tick(120); // review answers just inside the cap
  await untilRequests(2); // approval risk question is sent and hangs
  t.mock.timers.tick(waitMs - 120); // the shared Jev deadline is reached
  await handled;
  const elapsed = Date.now() - started;
  t.mock.timers.reset();
  assert.equal(s.jev.state.requests, 2, "review + risk question");
  assert.ok(elapsed < waitMs * 1.8, `handler active wait ${elapsed} ms for waitMs ${waitMs}`);
  await s.done();
});

test("C2 credential in the written content: blocked with zero Jev requests", async () => {
  const s = await setup(ENFORCE);
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("write", { path: "notes.txt", content: `token=${KEY}` });
  assert.match(blocked?.reason ?? "", /credential/);
  assert.equal(s.jev.state.requests, 0);
  await s.done();
});

test("C2 budget exhausted (maxRequestsPerTask 0): enforce blocks, no Jev request", async () => {
  const s = await setup({ ...ENFORCE, budget: { maxRequestsPerTask: 0 } });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("write", { path: "notes.txt", content: "hello" });
  assert.match(blocked?.reason ?? "", /maxRequestsPerTask/);
  assert.equal(s.jev.state.requests, 0);
  await s.done();
});

test("C2 edit kind not listed in enforce: passes untouched, no Jev request", async () => {
  const s = await setup({ ...ON, router: { tools: "off" }, harness: { enforce: ["create"] } }, { noul: UNFAVORABLE });
  await writeFile(join(s.host.cwd, "a.txt"), "one");
  await s.host.prompt(PROMPT);
  assert.equal(await s.host.tool("edit", { path: "a.txt", oldText: "one", newText: "two" }), undefined);
  assert.equal(s.jev.state.requests, 0);
  await s.done();
});

// ---- C3 ------------------------------------------------------------------------------------------

const APPROVAL = { ...ON, router: { tools: "off" }, approval: { enabled: true } };

test("C3 default off: mode on without an approval section never confirms or blocks", async () => {
  const s = await setup({ ...ON, router: { tools: "off" } });
  await s.host.prompt(PROMPT);
  assert.equal(await s.host.tool("bash", { command: "rm -rf /tmp/x" }), undefined);
  assert.equal(s.host.confirms.length, 0);
  assert.equal(s.jev.state.requests, 0);
  await s.done();
});

test("C3 default deny/allow lists match the legacy plugin", async () => {
  const loaded = await loadOmpConfig({ home: "/h", path: "/x", env: {}, readText: async () => "{}" });
  assert.deepEqual(loaded.config.approval.denyTools, ["bash", "write", "edit", "eval", "task", "hub"]);
  assert.deepEqual(loaded.config.approval.allowTools, ["read", "grep", "glob"]);
  assert.equal(loaded.config.approval.riskThreshold, 0.2);
  assert.equal(loaded.config.approval.noUi, "deny");
  assert.equal(loaded.config.approval.enabled, false);
});

test("C3 deny-list tool asks the human with zero Jev requests", async () => {
  const s = await setup(APPROVAL, { confirm: true });
  await s.host.prompt(PROMPT);
  for (const tool of ["bash", "write", "edit", "eval", "task", "hub"]) await s.host.tool(tool, { x: 1 });
  assert.equal(s.host.confirms.length, 6);
  assert.equal(s.jev.state.requests, 0);
  await s.done();
});

test("DEFECT: C3 legacy parity: a tool in both denyTools and allowTools asks the human (legacy checks deny first)", async () => {
  const s = await setup({ ...APPROVAL, approval: { enabled: true, allowTools: ["bash"], denyTools: ["bash"] } });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("bash", { command: "ls" });
  assert.equal(s.host.confirms.length, 1);
  assert.ok(blocked?.block);
  await s.done();
});

test("C3 irreversible threshold boundary: risk exactly 0.2 asks, 0.19 does not", async () => {
  for (const [risk, asks] of [[0.2, true], [0.19, false]] as const) {
    const s = await setup(APPROVAL, { noul: { irreversible: risk }, confirm: true });
    await s.host.prompt(PROMPT);
    await s.host.tool("web_search", { q: "x" });
    assert.equal(s.host.confirms.length, asks ? 1 : 0, `risk ${risk}`);
    await s.done();
  }
});

test("C3 Jev unanswerable (outbound closed / credential / budget exhausted / hang): asks the human", async () => {
  const cases: Array<[string, Record<string, unknown>, SetupOptions, unknown]> = [
    ["outbound", { ...APPROVAL, outbound: { taskIntent: false } }, {}, { q: "x" }],
    ["credential", APPROVAL, {}, { q: KEY }],
    ["budget", { ...APPROVAL, budget: { maxRequestsPerTask: 0 } }, {}, { q: "x" }],
    ["hang", { ...APPROVAL, budget: { waitMs: 100 } }, { hang: true }, { q: "x" }],
  ];
  for (const [label, config, options, input] of cases) {
    const s = await setup(config, { ...options, noul: { irreversible: 0.01 } });
    await s.host.prompt(PROMPT);
    const blocked = await s.host.tool("web_search", input);
    assert.equal(s.host.confirms.length, 1, label);
    assert.ok(blocked?.block, label);
    if (label !== "hang") assert.equal(s.jev.state.requests, 0, label);
    await s.done();
  }
});

test("C3 Jev hang without UI: Jev may use the whole wait, then a wait-limit block (no confirm)", async () => {
  const s = await setup({ ...APPROVAL, budget: { waitMs: 100 } }, { hang: true, hasUI: false, noul: { irreversible: 0.01 } });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("web_search", { q: "x" });
  assert.equal(s.host.confirms.length, 0);
  assert.match(blocked?.reason ?? "", /wait limit reached/);
  await s.done();
});

test("C3 shared per-task counter: enforce spends it, approval then asks the human without Jev", async () => {
  const s = await setup({ ...ENFORCE, budget: { maxRequestsPerTask: 1 }, approval: { enabled: true } }, { confirm: true, noul: { ...FAVORABLE, irreversible: 0.01 } });
  await s.host.prompt(PROMPT);
  assert.equal(await s.host.tool("write", { path: "notes.txt", content: "hello" }), undefined);
  const before = s.jev.state.requests;
  assert.equal(before, 1);
  await s.host.tool("web_search", { q: "x" });
  assert.equal(s.jev.state.requests, before, "no Jev request after the counter is spent");
  assert.equal(s.host.confirms.length, 2, "write (deny-list) + web_search (budget)");
  await s.done();
});

test("C3 confirm rejects: treated as a denial, handler does not throw", async () => {
  const s = await setup(APPROVAL, { confirm: "reject" });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("bash", { command: "ls" });
  assert.ok(blocked?.block && !("threw" in blocked));
  assert.deepEqual(s.host.executed, []);
  await s.done();
});

test("C3 approval block reason is surfaced to the model", async () => {
  const s = await setup(APPROVAL, { confirm: false });
  await s.host.prompt(PROMPT);
  const blocked = await s.host.tool("bash", { command: "ls" });
  assert.equal(blocked?.reason, "Human approval required");
  await s.done();
});

test("C3 steer: at most 3 per user input; extension input does not reset, user input does", async () => {
  const s = await setup({ ...ON, router: { tools: "off" }, approval: { silentSteer: true } });
  await s.host.prompt(PROMPT);
  for (let i = 0; i < 25; i++) await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, MAX_STEERS);
  await s.host.emit("input", { source: "extension" });
  for (let i = 0; i < 5; i++) await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, MAX_STEERS);
  await s.host.emit("input", { source: "interactive" });
  for (let i = 0; i < 5; i++) await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, MAX_STEERS + 1);
  await s.done();
});

test("C3 steer: assistant message without visible text does not reset; tool-only messages count", async () => {
  const s = await setup({ ...ON, router: { tools: "off" }, approval: { silentSteer: true } });
  await s.host.prompt(PROMPT);
  for (let i = 0; i < 4; i++) await s.host.tool("read", { path: "a" });
  await s.host.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "   " }, { type: "toolCall" }] } });
  await s.host.emit("message_end", { message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, 1);
  await s.done();
});

test("C3 steer shadow: no sendMessage, would-steer counted", async () => {
  const s = await setup({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "off" }, approval: { silentSteer: true } });
  await s.host.prompt(PROMPT);
  for (let i = 0; i < 5; i++) await s.host.tool("read", { path: "a" });
  assert.equal(s.host.steers.length, 0);
  assert.match(s.status(), /would 1/);
  await s.done();
});

// ---- Safety --------------------------------------------------------------------------------------

const EVERYTHING = { outbound: { taskIntent: true }, router: { tools: "on" }, harness: { enforce: ["create", "overwrite"] }, approval: { enabled: true, silentSteer: true } };

test("shadow with every switch on: no setter, no block, no confirm, no steer, no setModel", async () => {
  const s = await setup({ mode: "shadow", ...EVERYTHING }, { pick: "write", noul: UNFAVORABLE });
  await s.host.prompt(PROMPT);
  for (let i = 0; i < 6; i++) assert.equal(await s.host.tool("bash", { command: "ls" }), undefined);
  assert.equal(await s.host.tool("write", { path: "notes.txt", content: "hello" }), undefined);
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  await s.settled();
  assert.deepEqual(s.host.setterCalls, []);
  assert.equal(s.host.confirms.length + s.host.steers.length, 0);
  assert.deepEqual(s.host.executed.length, 7);
  await s.done();
});

test("child session in mode on with every switch on: no Jev request from the gates, no setter/block/confirm/steer", async () => {
  const s = await setup({ mode: "on", ...EVERYTHING }, { pick: "write", noul: UNFAVORABLE, child: true });
  await s.host.prompt(PROMPT);
  const routeRequests = s.jev.state.requests;
  for (let i = 0; i < 6; i++) assert.equal(await s.host.tool("bash", { command: "ls" }), undefined);
  assert.equal(await s.host.tool("write", { path: "notes.txt", content: "hello" }), undefined);
  assert.equal(s.jev.state.requests, routeRequests);
  assert.deepEqual(s.host.setterCalls, []);
  assert.equal(s.host.confirms.length + s.host.steers.length, 0);
  await s.done();
});

test("mode on with every switch on: setModel/setThinkingLevel never called", async () => {
  const s = await setup({ mode: "on", ...EVERYTHING }, { pick: "write", confirm: true });
  await s.host.prompt(PROMPT);
  await s.host.tool("bash", { command: "ls" });
  await s.host.tool("write", { path: "notes.txt", content: "hello" });
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  assert.ok(!s.host.setterCalls.includes("setModel") && !s.host.setterCalls.includes("setThinkingLevel"));
  await s.done();
});

// ---- Pi unchanged ----------------------------------------------------------------------------------

test("Pi: approval section rejected, mode on rejected; restoreOwnedTools re-export is the core function", async () => {
  const pi = await loadConfig({ home: "/h", path: "/x", readText: async () => JSON.stringify({ approval: { enabled: false } }) });
  assert.equal(pi.source, "invalid");
  assert.match(pi.reason ?? "", /approval/);
  const on = await loadConfig({ home: "/h", path: "/x", readText: async () => JSON.stringify({ mode: "on" }) });
  assert.equal(on.source, "invalid");
  assert.equal(piRestore, coreRestore);
});

// ---- Round 2 -------------------------------------------------------------------------------------

test("C1 host retry of before_agent_start: one route, one apply; same prompt after agent_end is a new task", async () => {
  const s = await setup(TOOLS_ON, { pick: "write" });
  await s.host.prompt(PROMPT);
  const requests = s.jev.state.requests;
  const sets = s.host.setterCalls.length;
  await s.host.emit("before_agent_start", { prompt: PROMPT });
  assert.equal(s.jev.state.requests, requests);
  assert.equal(s.host.setterCalls.length, sets);
  await s.host.emit("agent_end", { messages: [], willContinue: false });
  await s.host.prompt(PROMPT);
  assert.ok(s.jev.state.requests > requests, "same text after task end routes again");
  assert.ok(s.host.active().length < NATIVE.length);
  assert.match(s.status(), /路由：应用/);
  await s.done();
});
