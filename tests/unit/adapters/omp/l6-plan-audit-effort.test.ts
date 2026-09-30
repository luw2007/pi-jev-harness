/**
 * T105 L6: `jev_plan` (C6), audit + report (C11), effort suggestion (C12). Fake OMP host, fake Jev.
 * Plan fixtures are derived from the legacy `jev_route` planner tests
 * (omp-jev-extensions/extensions/jev-harness/capabilities/planning-test.ts).
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";
import type { CliDeps } from "../../../../src/cli/context.ts";
import { main } from "../../../../src/cli/main.ts";
import { AUDIT_FILE, auditDirFor, createAuditWriter, type AuditInput } from "../../../../src/telemetry/audit.ts";
import { effectiveEffort, suggestEffort } from "../../../../src/adapters/omp/effort.ts";
import type { JevClient } from "../../../../src/jev/index.ts";

const TASK_SECRET_WORDS = "Refactor the zebra-quartz billing module";

async function withTemp(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-l6-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Answers = Record<string, string>;

/** Fake Jev: answers `choices[id]` when valid, else the first option; records every body. */
function fakeJev(choices: Answers = {}) {
  const bodies: Array<{ state: Record<string, unknown>; questions: Record<string, { instructions: string; criteria: Record<string, string> }> }> = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>).map(([id, q]) => {
      const options = Object.keys(q.criteria);
      const pick = options.includes(choices[id] ?? "") ? choices[id]! : options[0]!;
      const rest = 0.3 / (options.length - 1);
      return [id, { type: "choice", choice: pick, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 0.7 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

function fakeHost() {
  const handlers = new Map<string, OmpHandler[]>();
  const tools = new Map<string, OmpToolDefinition>();
  const calls: string[] = [];
  const commandMap = new Map<string, { name: string; source: "extension"; description?: string }>();
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}) },
    getContextUsage: () => undefined,
    ui: { notify: () => {} },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: "18.3.5" },
    on: (event, handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, options) => {
      commandMap.set(name, { name, source: "extension", description: options?.description });
    },
    getCommands: () => [...commandMap.values()],
    registerTool: (tool) => void tools.set(tool.name, tool),
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "medium",
    setActiveTools: () => void calls.push("setActiveTools"),
    setModel: () => { calls.push("setModel"); return true; },
    setThinkingLevel: (level) => void calls.push(`setThinkingLevel:${String(level)}`),
  };
  return {
    api, ctx, tools, calls,
    async emit(event: string, payload: Record<string, unknown> = {}) {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
    },
  };
}

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function setup(config: Record<string, unknown>, choices: Answers = {}) {
  const host = fakeHost();
  const jev = fakeJev(choices);
  const audits: AuditInput[] = [];
  const registry = {};
  createExtension({
    env: { TYPESAFE_API_KEY: "test-key" },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify(config) }),
    fetch: jev.fetch,
    now: () => 0,
    newId,
    readPluginsLock: () => undefined,
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: () => ({ record: async (a) => { audits.push(a); return true; }, flush: async () => {}, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry)(host.api);
  const settled = () => (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host.settled();
  const plan = (task: string, pinnedAgent?: string) =>
    host.tools.get("jev_plan")!.execute("call-1", { task, pinnedAgent }, new AbortController().signal, () => {}, host.ctx) as Promise<{ content: Array<{ text: string }>; details: { plan?: any }; isError?: boolean }>;
  return { host, jev, audits, settled, plan };
}

const PLAN_ON = { mode: "shadow", outbound: { taskIntent: true }, effort: "off", router: { tools: "off" } };

// ---- C6 ----------------------------------------------------------------------------------------

test("jev_plan: tool definition equals the legacy jev_route definition except the name", async () => {
  const s = setup(PLAN_ON);
  const tool = s.host.tools.get("jev_plan")!;
  assert.deepEqual({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters }, {
    name: "jev_plan",
    label: "Jev Route Agent Planner",
    description: "Derives and arbitrates subagent delegation topology (direct, single, parallel, dag) using Jev.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "User prompt or high-level task instructions" },
        pinnedAgent: { type: "string", description: "Optional explicit user-pinned agent class override" },
      },
      required: ["task"],
    },
  });
});

test("jev_plan: direct result is byte-identical to the legacy fixture", async () => {
  const s = setup(PLAN_ON, { mode: "direct" });
  await s.host.emit("session_start");
  const expected = { version: 1, mode: "direct", rationale: "Jev selected topology: direct", slices: [], recommendedGate: "light" };
  assert.deepEqual(await s.plan("Answer this question"), { content: [{ type: "text", text: JSON.stringify(expected, null, 2) }], details: { plan: expected } });
  // Legacy wire body: same question ids, instructions and criteria keys.
  const body = s.jev.bodies[0]!;
  assert.deepEqual(Object.keys(body.questions), ["mode", "agent_slice_1", "model_slice_1"]);
  assert.deepEqual(Object.keys(body.questions.mode!.criteria), ["direct", "single", "parallel", "dag"]);
  assert.deepEqual(Object.keys(body.questions.agent_slice_1!.criteria), ["fast", "smart", "scout", "reviewer"]);
  assert.deepEqual(Object.keys(body.questions.model_slice_1!.criteria), ["fast", "smart", "slow", "task"]);
  assert.deepEqual(body.state.catalog, ["fast", "smart", "scout", "reviewer"]);
  assert.equal(body.state.pinnedAgent, null);
});

test("jev_plan: single / parallel / dag match the legacy fixtures", async () => {
  const single = setup(PLAN_ON, { mode: "single", agent_slice_1: "scout", model_slice_1: "smart" });
  await single.host.emit("session_start");
  const one = (await single.plan("Inspect the implementation")).details.plan;
  assert.equal(one.mode, "single");
  assert.deepEqual(one.slices, [{ id: "slice_1", agent: "scout", taskClass: "research", dependsOn: [], target: "Project files relevant to task",
    change: "Inspect the implementation", acceptance: "All task requirements satisfied and verified", model: "smart" }]);
  assert.equal(one.recommendedGate, "light");

  const multi = "- Inspect source\n- Update implementation";
  const parallel = setup(PLAN_ON, { mode: "parallel", agent_slice_1: "scout", agent_slice_2: "fast" });
  await parallel.host.emit("session_start");
  const p = (await parallel.plan(multi)).details.plan;
  assert.equal(p.mode, "parallel");
  assert.deepEqual(p.slices.map((x: any) => x.dependsOn), [[], []]);
  assert.deepEqual(p.slices.map((x: any) => x.id), ["slice_1", "slice_2"]);
  assert.equal(p.recommendedGate, "heavy");

  const dag = setup(PLAN_ON, { mode: "dag", agent_slice_1: "scout", agent_slice_2: "fast" });
  await dag.host.emit("session_start");
  assert.deepEqual((await dag.plan(multi)).details.plan.slices.map((x: any) => x.dependsOn), [[], ["slice_1"]]);
});

test("jev_plan: pinnedAgent overrides the agent; unknown pin is ignored", async () => {
  const s = setup(PLAN_ON, { mode: "single", agent_slice_1: "fast" });
  await s.host.emit("session_start");
  const pinned = await s.plan("Implement feature", "smart");
  assert.equal(pinned.details.plan.slices[0].agent, "smart");
  assert.equal(pinned.details.plan.slices[0].taskClass, "routine", "legacy: taskClass follows Jev's choice");
  assert.equal(s.jev.bodies[0]!.state.pinnedAgent, "smart");
  assert.match(s.jev.bodies[0]!.questions.agent_slice_1!.instructions, /Pinned agent constraint: smart\./);
  const unknown = await s.plan("Implement feature", "deep-worker");
  assert.equal(unknown.details.plan.slices[0].agent, "fast");
  assert.equal(s.jev.bodies[1]!.state.pinnedAgent, null);
});

test("jev_plan: gates (off, outbound, credential) send nothing; never dispatches", async () => {
  const off = setup({ ...PLAN_ON, mode: "off" });
  await off.host.emit("session_start");
  const r1 = await off.plan("Do it");
  assert.equal(r1.isError, true);
  assert.equal(r1.details.plan, undefined);
  const noOut = setup({ ...PLAN_ON, outbound: { taskIntent: false } });
  await noOut.host.emit("session_start");
  assert.equal((await noOut.plan("Do it")).isError, true);
  const cred = setup(PLAN_ON);
  await cred.host.emit("session_start");
  assert.match((await cred.plan("use key test-key please")).content[0]!.text, /credential detected/);
  assert.equal(off.jev.bodies.length + noOut.jev.bodies.length + cred.jev.bodies.length, 0);
  assert.deepEqual([...off.host.calls, ...noOut.host.calls, ...cred.host.calls], []);
});

test("jev_plan: route audit carries categories and counts, never the task text", async () => {
  const s = setup(PLAN_ON, { mode: "single" });
  await s.host.emit("session_start");
  await s.plan(TASK_SECRET_WORDS);
  assert.equal(s.audits.length, 1);
  assert.equal(s.audits[0]!.kind, "route");
  assert.equal(s.audits[0]!.outcome, "ok");
  assert.equal(s.audits[0]!.mode, "single");
  assert.ok(!JSON.stringify(s.audits).includes("zebra-quartz"));
});

// ---- C11 ---------------------------------------------------------------------------------------

test("audit writer: whitelist drops free text; file never contains the task text", async () => {
  await withTemp(async (root) => {
    const writer = createAuditWriter({ dir: root, now: () => 1000 });
    assert.equal(await writer.record({ kind: "stop", event: "continue", outcome: "ok", metrics: { continues: 1, note: TASK_SECRET_WORDS } as never }), true);
    assert.equal(await writer.record({ kind: "stop", event: TASK_SECRET_WORDS, outcome: "ok" }), false);
    assert.equal(await writer.record({ kind: "approval", event: "ask", outcome: "ok", mode: "has space" }), false);
    assert.equal(await writer.record({ kind: "bogus" as never, event: "x", outcome: "ok" }), false);
    const text = await readFile(join(root, AUDIT_FILE), "utf8");
    assert.ok(!text.includes("zebra"));
    assert.deepEqual(JSON.parse(text.trim()).metrics, { continues: 1 });
    assert.deepEqual(writer.diagnostics(), { written: 1, rejected: 3, writeFailures: 0 });
  });
});

test("audit writer: rotates by size; OMP_TELEMETRY_MAX_BYTES honoured", async () => {
  await withTemp(async (root) => {
    const writer = createAuditWriter({ dir: root, now: () => 1000, env: { OMP_TELEMETRY_MAX_BYTES: "4096" } });
    for (let i = 0; i < 60; i++) await writer.record({ kind: "autorun", event: "effort", outcome: "high", mode: "shadow", durationMs: i, metrics: { applied: false } });
    await writer.flush();
    const names = (await readdir(root)).sort();
    assert.ok(names.includes("audit.jsonl") && names.includes("audit.1.jsonl"), names.join(","));
    let lines = 0;
    for (const name of names) {
      const text = await readFile(join(root, name), "utf8");
      assert.ok(Buffer.byteLength(text) <= 4096, `${name} exceeds limit`);
      lines += text.split("\n").filter(Boolean).length;
    }
    assert.equal(lines, 60);
  });
});

test("report --telemetry aggregates the sibling audit dir (legacy report.js core metrics)", async () => {
  await withTemp(async (root) => {
    const telemetry = join(root, "omp", "telemetry");
    await mkdir(telemetry, { recursive: true });
    const writer = createAuditWriter({ dir: auditDirFor(telemetry), now: () => 1000 });
    await writer.record({ kind: "route", event: "jev_plan", outcome: "ok", mode: "single", durationMs: 10, metrics: { requests: 1 } });
    await writer.record({ kind: "route", event: "jev_plan", outcome: "ok", mode: "single", durationMs: 30, metrics: { requests: 1 } });
    await writer.record({ kind: "stop", event: "continue", outcome: "ok", durationMs: 5 });
    await writer.flush();
    await writeFile(join(auditDirFor(telemetry), AUDIT_FILE), `${await readFile(join(auditDirFor(telemetry), AUDIT_FILE), "utf8")}{"task":"${TASK_SECRET_WORDS}"}\n`);
    let out = "";
    const deps: CliDeps = { env: {}, home: join(root, "home"), cwd: root, harnessRoot: root, out: (t) => void (out += t), err: () => {}, execFile: () => "" };
    assert.equal(await main(["report", "--telemetry", telemetry, "--json"], deps), 0);
    const audit = JSON.parse(out).audit;
    assert.equal(audit.lines, 4);
    assert.equal(audit.skipped, 1);
    const route = audit.groups.find((g: any) => g.plugin === "route");
    assert.deepEqual({ events: route.events, p50: route.durationMs.p50, p95: route.durationMs.p95, sum: route.durationMs.sum, requests: route.requests.count },
      { events: 2, p50: 10, p95: 30, sum: 40, requests: 2 });
    assert.equal(audit.groups.find((g: any) => g.plugin === "stop").mode, "(none)");
    out = "";
    assert.equal(await main(["report", "--telemetry", telemetry], deps), 0);
    assert.match(out, /route \/ jev_plan \/ single \/ ok：2 次.*缓存命中 N\/A，字符缩减 N\/A/);
    assert.match(out, /注：cache and characterReduction: N\/A/);
    assert.equal(route.cache.reads, null);
    assert.ok(!out.includes("zebra"));
  });
});

// ---- C12 ---------------------------------------------------------------------------------------

async function task(s: ReturnType<typeof setup>) {
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: TASK_SECRET_WORDS, images: [] });
  await s.settled();
}

const EFFORT_BASE = { mode: "shadow", outbound: { taskIntent: true }, router: { tools: "off" } };

test("effort shadow (default): suggestion audited, setThinkingLevel never called", async () => {
  const s = setup(EFFORT_BASE, { effort: "high" });
  await task(s);
  assert.equal(s.jev.bodies.length, 1);
  assert.deepEqual(Object.keys(s.jev.bodies[0]!.questions), ["effort"]);
  assert.deepEqual(s.host.calls, []);
  const a = s.audits.find((x) => x.kind === "autorun")!;
  assert.deepEqual({ event: a.event, outcome: a.outcome, mode: a.mode, applied: a.metrics?.applied }, { event: "effort", outcome: "high", mode: "shadow", applied: false });
  assert.ok(!JSON.stringify(s.audits).includes("zebra"));
});

test("effort mode is capped by the session mode", () => {
  for (const e of ["off", "shadow", "on"] as const) assert.equal(effectiveEffort(e, "off"), "off");
  assert.deepEqual(["off", "shadow", "on"].map((e) => effectiveEffort(e as never, "shadow")), ["off", "shadow", "shadow"]);
  assert.deepEqual(["off", "shadow", "on"].map((e) => effectiveEffort(e as never, "on")), ["off", "shadow", "on"]);
});

test("effort on (session on): setThinkingLevel once per decision, setModel never; timeout sets nothing", async () => {
  const calls: string[] = [];
  const client = (level: string | null): JevClient => ({
    choice: async (_q, opts) => {
      if (level === null) return await new Promise((resolve) => opts.signal!.addEventListener("abort", () => resolve({ ok: false, error: { kind: "aborted" } })));
      return { ok: true, evidence: [{ questionId: "effort", model: "m", choice: level, confidence: 0.9, probabilities: {} }], attempt: {} as never };
    },
    noul: async () => ({ ok: false, error: { kind: "aborted" } }),
  });
  const base = { intent: "task", gate: () => true, decisionId: "dec_x", runId: "run_x", getThinkingLevel: () => "medium",
    setThinkingLevel: (l: string) => void calls.push(`setThinkingLevel:${l}`), audit: undefined, now: () => 0 };
  assert.equal(await suggestEffort({ ...base, mode: "on", client: client("xhigh"), signal: new AbortController().signal }), "xhigh");
  assert.equal(await suggestEffort({ ...base, mode: "on", client: client("low"), signal: new AbortController().signal }), "low");
  assert.deepEqual(calls, ["setThinkingLevel:xhigh", "setThinkingLevel:low"]);
  const timeout = new AbortController();
  const pending = suggestEffort({ ...base, mode: "on", client: client(null), signal: timeout.signal });
  timeout.abort();
  assert.equal(await pending, undefined);
  assert.equal(await suggestEffort({ ...base, mode: "shadow", client: client("high"), signal: new AbortController().signal }), "high");
  assert.deepEqual(calls, ["setThinkingLevel:xhigh", "setThinkingLevel:low"], "timeout and shadow set nothing");
});

test("child session: no routing and no effort", async () => {
  const s = setup(EFFORT_BASE, { effort: "high" });
  s.host.ctx.sessionManager = { getHeader: () => ({ parentSession: "/p.jsonl" }) };
  await task(s);
  assert.equal(s.jev.bodies.length, 0);
});

test("effort off: zero Jev requests; outbound gate and budget respected", async () => {
  const off = setup({ ...EFFORT_BASE, effort: "off" });
  await task(off);
  assert.equal(off.jev.bodies.length, 0);
  const gated = setup({ ...EFFORT_BASE, effort: "on", outbound: { taskIntent: false } });
  await task(gated);
  assert.equal(gated.jev.bodies.length, 0);
  const noBudget = setup({ ...EFFORT_BASE, effort: "on", budget: { maxRequestsPerTask: 0 } });
  await task(noBudget);
  assert.equal(noBudget.jev.bodies.length, 0);
  assert.deepEqual([...off.host.calls, ...gated.host.calls, ...noBudget.host.calls], []);
});
