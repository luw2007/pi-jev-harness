/**
 * Verifier edge cases for `jev_plan`, audit writer + report, effort.
 * Harness copied from l6-plan-audit-effort.test.ts so the two files stay independent.
 * Tests marked `todo` pin the expected behaviour of reported defects without failing the suite.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";
import { aggregateAudit, auditMaxBytes, AUDIT_FILE, createAuditWriter, type AuditInput, type AuditWriter } from "../../../../src/telemetry/audit.ts";

const TASK = "Refactor the zebra-quartz billing module";

async function withTemp(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-l6v-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Body = { model: string; state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, string> }> };
type Responder = (body: Body, init?: RequestInit) => Promise<Response> | Response;

function valid(id: string, options: string[], pick = options[0]!) {
  const rest = 0.3 / Math.max(1, options.length - 1);
  return [id, { type: "choice", choice: pick, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 0.7 : rest])) }] as const;
}

/** Valid answers for every question; `choices[id]` when it is an option. */
const answerAll = (choices: Record<string, string> = {}): Responder => (body) =>
  Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
    const options = Object.keys(q.criteria ?? {});
    return valid(id, options, options.includes(choices[id] ?? "") ? choices[id] : options[0]);
  })) });

function fakeHost(parentSession?: string) {
  const handlers = new Map<string, OmpHandler[]>();
  const tools = new Map<string, OmpToolDefinition>();
  const calls: string[] = [];
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => (parentSession ? { parentSession } : {}) },
    getContextUsage: () => undefined,
    ui: { notify: () => {} },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: "18.3.5" },
    on: (event, handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: () => {},
    registerTool: (tool) => void tools.set(tool.name, tool),
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
      { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: {} } },
    ],
    getActiveTools: () => ["read", "bash"],
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

function setup(config: Record<string, unknown>, respond: Responder = answerAll(), opts: { audit?: (dir: string) => AuditWriter; parentSession?: string } = {}) {
  const host = fakeHost(opts.parentSession);
  const bodies: Body[] = [];
  const audits: AuditInput[] = [];
  const registry = {};
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return respond(body, init);
  }) as typeof globalThis.fetch;
  createExtension({
    env: { TYPESAFE_API_KEY: "test-key-0123456789" },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify(config) }),
    fetch,
    now: () => 0,
    newId,
    readPluginsLock: () => undefined,
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: opts.audit ?? (() => ({ record: async (a) => { audits.push(a); return true; }, flush: async () => {}, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) })),
  }, registry)(host.api);
  const settled = () => (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host.settled();
  const plan = (params: unknown, signal: AbortSignal = new AbortController().signal) =>
    host.tools.get("jev_plan")!.execute("call-1", params, signal, () => {}, host.ctx) as Promise<{ content: Array<{ text: string }>; details: { plan?: any }; isError?: boolean }>;
  const task = async (prompt = TASK) => {
    await host.emit("before_agent_start", { prompt, images: [] });
    await settled();
  };
  return { host, bodies, audits, settled, plan, task };
}

const PLAN_ON = { mode: "shadow", outbound: { taskIntent: true }, effort: "off", router: { tools: "off" } };
const MULTI = "- Inspect source\n- Update implementation";

// ---- strict answers (legacy defaulted partial answers) -------------------------------------

test("jev_plan: partial Jev answer (only mode) returns a usable isError, never throws", async () => {
  // Legacy `jev_route` would return a plan here (agent/model defaulted); jev_plan now requires every answer.
  const s = setup(PLAN_ON, (body) => Response.json({ model: body.model, answers: Object.fromEntries([valid("mode", ["direct", "single", "parallel", "dag"], "single")]) }));
  await s.host.emit("session_start");
  const r = await s.plan({ task: "Implement feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {});
  assert.match(r.content[0]!.text, /^Route planning failed: Jev unavailable \(\w+\)$/);
  assert.equal(s.bodies.length, 1);
  assert.equal(s.audits[0]!.outcome, "unavailable");
});

test("jev_plan: answer without probabilities / wrong model / HTTP 500 / fetch throw all degrade to isError", async () => {
  const cases: Responder[] = [
    (body) => Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: "choice", choice: Object.keys(q.criteria!)[0] }])) }),
    (body) => answerAll()({ ...body, model: "other" }),
    () => new Response("boom", { status: 500 }),
    () => { throw new Error("socket hang up"); },
  ];
  for (const respond of cases) {
    const s = setup(PLAN_ON, respond);
    await s.host.emit("session_start");
    const r = await s.plan({ task: "Implement feature" });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Route planning failed: /);
  }
});

test("jev_plan: Jev answer that yields an invalid plan (single with 2 slices) is isError, not a throw", async () => {
  const s = setup(PLAN_ON, answerAll({ mode: "single" }));
  await s.host.emit("session_start");
  const r = await s.plan({ task: MULTI });
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, "Route planning failed: Single mode requires exactly 1 slice, got 2");
});

test("jev_plan: wait budget bounds a hanging Jev; tool abort signal cancels", async () => {
  const hang: Responder = (_b, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const s = setup({ ...PLAN_ON, budget: { waitMs: 30 } }, hang);
  await s.host.emit("session_start");
  const r = await s.plan({ task: "Implement feature" });
  assert.equal(r.isError, true);
  const ac = new AbortController();
  const s2 = setup(PLAN_ON, hang);
  await s2.host.emit("session_start");
  const pending = s2.plan({ task: "Implement feature" }, ac.signal);
  ac.abort();
  assert.equal((await pending).isError, true);
});

test("jev_plan: before session_start, empty/non-string task, missing params → isError, zero requests", async () => {
  const s = setup(PLAN_ON);
  assert.match((await s.plan({ task: "x" })).content[0]!.text, /pi-jev-harness is off/);
  await s.host.emit("session_start");
  for (const params of [{ task: "   " }, { task: 42 }, undefined, null]) assert.equal((await s.plan(params)).isError, true);
  assert.equal(s.bodies.length, 0);
});

test("jev_plan: budget 0 sends nothing; after shutdown it is off", async () => {
  const s = setup({ ...PLAN_ON, budget: { maxRequestsPerTask: 0 } });
  await s.host.emit("session_start");
  assert.match((await s.plan({ task: "x" })).content[0]!.text, /budget/);
  const t = setup(PLAN_ON);
  await t.host.emit("session_start");
  await t.host.emit("session_shutdown");
  assert.match((await t.plan({ task: "x" })).content[0]!.text, /pi-jev-harness is off/);
  assert.equal(s.bodies.length + t.bodies.length, 0);
});

test("jev_plan: route.md steps 3-5 — direct has no slices; single/parallel/dag slices carry agent, deps, target/change/acceptance", async () => {
  for (const [mode, task, n] of [["direct", "Answer this", 0], ["single", "Implement feature", 1], ["parallel", MULTI, 2], ["dag", MULTI, 2]] as const) {
    const s = setup(PLAN_ON, answerAll({ mode, agent_slice_1: "scout", agent_slice_2: "smart", model_slice_2: "slow" }));
    await s.host.emit("session_start");
    const r = await s.plan({ task });
    assert.equal(r.isError, undefined, r.content[0]!.text);
    const plan = JSON.parse(r.content[0]!.text);
    assert.deepEqual(plan, r.details.plan);
    assert.equal(plan.mode, mode);
    assert.equal(plan.slices.length, n);
    for (const slice of plan.slices) {
      assert.ok(["fast", "smart", "scout", "reviewer"].includes(slice.agent));
      for (const k of ["target", "change", "acceptance"]) assert.equal(typeof slice[k], "string");
      assert.ok(Array.isArray(slice.dependsOn));
    }
    if (mode === "dag") assert.deepEqual(plan.slices[1].dependsOn, ["slice_1"]);
    if (n === 2) assert.deepEqual(plan.slices.map((x: any) => [x.agent, x.taskClass, x.model]), [["scout", "research", "fast"], ["smart", "smart", "slow"]]);
    assert.deepEqual(s.host.calls, [], "advice only: nothing dispatched or applied");
  }
});

test("jev_plan: pinnedAgent scout on a non-research slice fails legacy invariant as isError (legacy parity)", async () => {
  const s = setup(PLAN_ON, answerAll({ mode: "single", agent_slice_1: "fast" }));
  await s.host.emit("session_start");
  const r = await s.plan({ task: "Implement feature", pinnedAgent: "scout" });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Scout agent can only be assigned to research taskClass/);
});

// ---- audit writer ------------------------------------------------------------------------

test("audit: OMP_TELEMETRY_MAX_BYTES floor and fallbacks match the legacy writer", () => {
  assert.equal(auditMaxBytes({}), 10 * 1024 * 1024);
  assert.equal(auditMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "4095" }), 10 * 1024 * 1024);
  assert.equal(auditMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "4096" }), 4096);
  assert.equal(auditMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "5000.9" }), 5000);
  assert.equal(auditMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "abc" }), 10 * 1024 * 1024);
  assert.equal(auditMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "-1" }), 10 * 1024 * 1024);
});

test("audit: repeated rotation numbers files monotonically; concurrent records all land", async () => {
  await withTemp(async (root) => {
    const writer = createAuditWriter({ dir: root, now: () => 1000, env: { OMP_TELEMETRY_MAX_BYTES: "4096" } });
    await Promise.all(Array.from({ length: 150 }, (_, i) => writer.record({ kind: "route", event: "jev_plan", outcome: "ok", durationMs: i })));
    await writer.flush();
    const names = (await readdir(root)).sort();
    assert.ok(names.includes("audit.2.jsonl"), names.join(","));
    let durations: number[] = [];
    for (const name of names) {
      const text = await readFile(join(root, name), "utf8");
      assert.ok(Buffer.byteLength(text) <= 4096);
      durations.push(...text.split("\n").filter(Boolean).map((l) => JSON.parse(l).durationMs as number));
    }
    durations = durations.sort((a, b) => a - b);
    assert.deepEqual(durations, Array.from({ length: 150 }, (_, i) => i));
    assert.equal(writer.diagnostics().written, 150);
  });
});

test("audit: write failure never rejects; negative/NaN/string metrics and bad ids dropped", async () => {
  await withTemp(async (root) => {
    const blocked = join(root, "file");
    await (await import("node:fs/promises")).writeFile(blocked, "x");
    const bad = createAuditWriter({ dir: join(blocked, "sub"), now: () => 1 });
    assert.equal(await bad.record({ kind: "stop", event: "continue", outcome: "ok" }), false);
    assert.equal(bad.diagnostics().writeFailures, 1);
    const w = createAuditWriter({ dir: root, now: () => 1 });
    await w.record({ kind: "stop", event: "continue", outcome: "ok", runId: TASK, decisionId: "dec_00000000-0000-4000-8000-0000000000ab", metrics: { requests: -1, inputTokens: Number.NaN, outputTokens: "7", continues: 2, cacheHit: true, applied: true } });
    await w.record({ kind: "stop", event: "continue", outcome: "ok", decisionId: "dec_abc" });
    const [rec, second] = (await readFile(join(root, AUDIT_FILE), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rec.metrics, { continues: 2, cacheHit: true }, "applied is not a stop metric");
    assert.equal(rec.runId, undefined);
    assert.equal(rec.decisionId, "dec_00000000-0000-4000-8000-0000000000ab");
    assert.equal(second.decisionId, undefined, "non-UUID id dropped");
  });
});

test("audit: metric keys are restricted to a named allowlist (legacy METRIC_TYPES style)", async () => {
  await withTemp(async (root) => {
    const w = createAuditWriter({ dir: root, now: () => 1 });
    await w.record({ kind: "route", event: "jev_plan", outcome: "ok", metrics: { refactorZebraQuartzBillingModule: 1, requests: 1 } });
    const text = await readFile(join(root, AUDIT_FILE), "utf8");
    assert.ok(!text.includes("Zebra"), text);
  });
});

test("audit: shutdown flushes the effort line of a flight aborted by session_shutdown", async () => {
  await withTemp(async (root) => {
    const hang: Responder = (_b, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const s = setup({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "off" } }, hang,
      { audit: () => createAuditWriter({ dir: root, now: () => 5 }) });
    await s.host.emit("session_start");
    await s.host.emit("before_agent_start", { prompt: TASK, images: [] });
    await new Promise((r) => setTimeout(r, 5));
    await s.host.emit("session_shutdown");
    const text = await readFile(join(root, AUDIT_FILE), "utf8");
    const rec = JSON.parse(text.trim());
    assert.deepEqual([rec.plugin, rec.event, rec.outcome], ["autorun", "effort", "unavailable"]);
    assert.ok(!text.includes("zebra"));
  });
});

test("report: aggregateAudit ignores legacy-foreign lines and matches report.js group math", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, ts: 1, ...o });
  const r = aggregateAudit([
    line({ plugin: "route", event: "jev_plan", mode: "single", outcome: "ok", durationMs: 10, metrics: { requests: 1, inputTokens: 5 } }),
    line({ plugin: "route", event: "jev_plan", mode: "single", outcome: "ok", durationMs: 30, metrics: { jevRequests: 2, requests: 9 } }),
    line({ plugin: "route", event: "jev_plan", mode: "single", outcome: "ok" }),
    "not json",
    JSON.stringify({ plugin: "route", event: "x", outcome: "ok" }),
  ]);
  const g = r.groups[0]!;
  assert.deepEqual({ lines: r.lines, skipped: r.skipped, groups: r.groups.length }, { lines: 5, skipped: 2, groups: 1 });
  assert.deepEqual(g.durationMs, { count: 2, p50: 10, p95: 30, sum: 40, coverage: 2 / 3 });
  assert.deepEqual(g.requests, { count: 3, known: 2, total: 3, coverage: 2 / 3 });
  assert.deepEqual(g.usage.inputTokens, { sum: 5, known: 1, total: 3, coverage: 1 / 3 });
});

// ---- effort --------------------------------------------------------------------------------

const EFFORT = { mode: "shadow", outbound: { taskIntent: true } };

test("effort + tool routing share maxRequestsPerTask: total per task never exceeds the budget", async () => {
  for (const max of [1, 2, 3]) {
    const s = setup({ ...EFFORT, router: { tools: "shadow" }, budget: { maxRequestsPerTask: max } }, answerAll({ effort: "high" }));
    await s.host.emit("session_start");
    await s.task();
    assert.ok(s.bodies.length <= max, `max=${max} sent ${s.bodies.length}`);
    const effort = s.audits.find((a) => a.kind === "autorun" && a.event === "effort")!;
    if (max === 1) {
      assert.equal(s.bodies.length, 1);
      assert.equal(effort.outcome, "budget");
      assert.ok(!("effort" in s.bodies[0]!.questions), "tool routing is served first");
    } else {
      assert.equal(effort.outcome, "high");
    }
    assert.deepEqual(s.host.calls, []);
  }
});

test("effort default (no effort key) is shadow: exactly one extra Jev request per task, no host setter", async () => {
  const s = setup({ ...EFFORT, router: { tools: "shadow" } }, answerAll({ effort: "low" }));
  await s.host.emit("session_start");
  await s.task();
  await s.task("second prompt");
  assert.equal(s.bodies.length, 4, "2 per task: tools + effort (default budget 2)");
  assert.equal(s.bodies.filter((b) => "effort" in b.questions).length, 2);
  assert.deepEqual(s.host.calls, []);
});

test("effort: invalid Jev answer / Jev error never applies; on applies at most once per task", async () => {
  const bad = setup({ ...EFFORT, effort: "on", router: { tools: "off" } }, () => new Response("{}", { status: 200 }));
  await bad.host.emit("session_start");
  await bad.task();
  assert.deepEqual(bad.host.calls, []);
  assert.equal(bad.audits.find((a) => a.event === "effort")!.outcome, "unavailable");
  const on = setup({ ...EFFORT, effort: "on", router: { tools: "off" } }, answerAll({ effort: "low" }));
  await on.host.emit("session_start");
  await on.task();
  assert.deepEqual(on.host.calls, [], "session shadow caps effort on at shadow");
  assert.equal(on.audits.find((a) => a.event === "effort")!.mode, "shadow");
});

test("effort off + tools off: zero Jev requests; mode off: zero even with effort on", async () => {
  const a = setup({ ...EFFORT, effort: "off", router: { tools: "off" } });
  await a.host.emit("session_start");
  await a.task();
  const b = setup({ mode: "off", outbound: { taskIntent: true }, effort: "on" });
  await b.host.emit("session_start");
  await b.task();
  assert.equal(a.bodies.length + b.bodies.length, 0);
  assert.deepEqual([...a.host.calls, ...b.host.calls], []);
});

test("effort in a child session (parentSession set) does not run (legacy autorun skipped children)", async () => {
  const s = setup({ ...EFFORT, effort: "on", router: { tools: "off" } }, answerAll({ effort: "high" }), { parentSession: "/parent.jsonl" });
  await s.host.emit("session_start");
  await s.task();
  assert.equal(s.bodies.length, 0);
  assert.deepEqual(s.host.calls, []);
});

test("effort on in a shadow session: nothing is set (session mode caps effort; on needs session on)", async () => {
  const s = setup({ ...EFFORT, effort: "on", router: { tools: "shadow" } }, answerAll({ effort: "xhigh" }));
  await s.host.emit("session_start");
  await s.host.emit("before_agent_start", { prompt: TASK, images: [] });
  await s.settled();
  assert.deepEqual(s.host.calls, []);
});
