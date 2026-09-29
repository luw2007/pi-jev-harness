/**
 * offline: C7 request reduction + jev_recall, C8 fast-jev compaction, proactive
 * compaction at agent_end, and legacy OMP_JEV_* / OMP_TELEMETRY_* compatibility. Fake OMP host,
 * fake Jev (injected fetch), archives in a temp dir; no real model, Jev, ~/.omp or ~/.pi.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "../../../../src/adapters/omp/legacy.ts";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { ompContextSettings, ompTelemetryMaxBytes } from "../../../../src/adapters/omp/context-settings.ts";
import { compactionWaitMs, VERBATIM_HEADER } from "../../../../src/adapters/omp/compaction.ts";
import { defaultOmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolDefinition } from "../../../../src/adapters/omp/types.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

const KEY = "fake-typesafe-key-l4";
const SESSION = "omp-session-l4";
const ENOENT = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };

// ---- fixtures ---------------------------------------------------------------------------------

const user = (text: string) => ({ role: "user", content: text });
const assistant = (content: unknown[], usage?: { input: number; cacheRead: number }) => ({ role: "assistant", content, ...(usage ? { usage } : {}) });
const toolCall = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } });
const toolResult = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false });
const payload = (id: string) => `${id}:` + "Dé€".repeat(3_000) + "\n\ttrailing  ";
const conversation = (usage?: { input: number; cacheRead: number }) => [
  user("fix the failing parsePort test"),
  assistant([{ type: "text", text: "step c0" }, toolCall("c0")]), toolResult("c0", payload("c0")),
  assistant([{ type: "text", text: "step c1" }, toolCall("c1")]), toolResult("c1", payload("c1")),
  assistant([{ type: "text", text: "done" }], usage),
];

type Answer = (id: string, instructions: string) => number;

function fakeJev(answer: Answer | "fail" = () => 0.01) {
  const state = { requests: 0, bodies: [] as Array<{ questions: Record<string, { instructions: string }> }> };
  let override: typeof globalThis.fetch | undefined;
  const use = (impl: typeof globalThis.fetch) => { override = impl; };
  const fetch: typeof globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    if (override) return override(input as string, init as RequestInit);
    state.requests++;
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { instructions: string }> };
    state.bodies.push(body);
    if (answer === "fail") return new Response("down", { status: 503 });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: "noul", noul: answer(id, q.instructions) }]));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { state, fetch, use };
}

interface Host {
  api: OmpExtensionAPI;
  ctx: OmpContext;
  tools: Map<string, OmpToolDefinition>;
  active: string[];
  compacts: number;
  setterCalls: string[];
  usage: { percent: number | undefined };
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

function fakeHost(): Host {
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, { name: string; source: "extension"; description?: string }>();
  const host = {
    tools: new Map<string, OmpToolDefinition>(),
    active: ["read"],
    compacts: 0,
    setterCalls: [] as string[],
    usage: { percent: undefined as number | undefined },
  } as Host;
  host.ctx = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getSessionId: () => SESSION, getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] },
    getContextUsage: () => ({ percent: host.usage.percent ?? null }),
    ui: { notify: () => {} },
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: (options) => { host.compacts++; options?.onComplete?.(); },
  };
  host.api = {
    pi: { VERSION: "18.4.1" },
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name: string, options: { description?: string }) => { commands.set(name, { name, source: "extension" as const, description: options.description }); },
    registerTool: (tool) => { host.tools.set(tool.name, tool); },
    // Own tools carry this package as source (legacy check reads sourceInfo).
    getAllTools: () => [...host.tools.values()].map(({ name }) => ({ name, sourceInfo: { path: join(PACKAGE_ROOT, "src/adapters/omp/index.ts"), source: "extension" as const } })),
    getActiveTools: () => [...host.active],
    getCommands: () => [...commands.values()],
    getThinkingLevel: () => undefined,
    setActiveTools: async (names) => { host.active = [...names]; },
    setModel: () => { host.setterCalls.push("setModel"); return true; },
    setThinkingLevel: () => { host.setterCalls.push("setThinkingLevel"); },
  };
  host.emit = async (event, payload = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, host.ctx));
    return results;
  };
  return host;
}

interface Setup {
  host: Host;
  jev: ReturnType<typeof fakeJev>;
  events: TelemetryInput[];
  dir: string;
  storeDir: string;
  settled(): Promise<void>;
  status(): string;
  cleanup(): Promise<void>;
}

async function setup(config: Record<string, unknown>, options: { answer?: Answer | "fail"; env?: Record<string, string>; storeDir?: (dir: string) => Promise<string> } = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), "omp-l4-"));
  const storeDir = options.storeDir ? await options.storeDir(dir) : join(dir, "store");
  // C12 effort (default shadow) would add its own Jev request; these tests count C7/C8 traffic only.
  const file = { effort: "off", ...config, context: { storeDir, limits: { recentTurns: 1 }, ...(config.context as object) } };
  const jev = fakeJev(options.answer);
  const events: TelemetryInput[] = [];
  const host = fakeHost();
  const registry = {};
  const env = { TYPESAFE_API_KEY: KEY, ...options.env };
  let claim: { settled(): Promise<void>; statusText(): string } | undefined;
  createExtension({
    env,
    loadConfig: () => loadOmpConfig({ home: dir, env, readText: async () => JSON.stringify(file), readLegacyText: ENOENT }),
    fetch: jev.fetch,
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
  }, registry)(host.api);
  claim = (registry as Record<symbol, { host: { settled(): Promise<void>; statusText(): string } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  await host.emit("session_start");
  await host.emit("before_agent_start", { prompt: "fix the failing parsePort test" });
  return {
    host, jev, events, dir, storeDir,
    settled: () => claim!.settled(),
    status: () => claim!.statusText(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const ON = (context: Record<string, unknown> = {}) => ({ mode: "on", outbound: { taskIntent: true }, router: { tools: "off" }, context: { request: "on", ...context } });
const text = (message: unknown) => (message as { content: Array<{ text: string }> }).content[0]!.text;
const HANDLE_RE = /spill:[a-z0-9._-]+:[0-9a-f]{64}/;

// ---- C7 ---------------------------------------------------------------------------------------

test("C7 on: archive first, then replace; jev_recall returns the original byte for byte", async () => {
  const s = await setup(ON());
  try {
    assert.ok(s.host.active.includes("jev_recall"), "jev_recall activated when request reduction is on");
    const messages = conversation();
    const snapshot = structuredClone(messages);
    const [result] = await s.host.emit("context", { messages });
    const reduced = (result as { messages: unknown[] }).messages;
    assert.deepEqual(messages, snapshot, "event messages not edited in place");
    assert.equal(reduced.length, messages.length);
    const notice = text(reduced[2]);
    assert.notEqual(notice, payload("c0"));
    const handle = HANDLE_RE.exec(notice)?.[0];
    assert.ok(handle, notice);
    assert.ok((await readdir(join(s.storeDir, SESSION))).length > 0, "archive written");
    const recalled = await s.host.tools.get("jev_recall")!.execute("t1", { handle }, undefined, undefined, s.host.ctx);
    assert.equal(recalled.content[0]!.text, payload("c0"));
    assert.ok(Buffer.from(recalled.content[0]!.text).equals(Buffer.from(payload("c0"))));
    assert.deepEqual(s.host.setterCalls, []);
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

test("C7 on: unwritable store keeps the original messages", async () => {
  const s = await setup(ON(), {
    storeDir: async (dir) => {
      await writeFile(join(dir, "not-a-dir"), "x");
      return join(dir, "not-a-dir", "store");
    },
  });
  try {
    const [result] = await s.host.emit("context", { messages: conversation() });
    assert.equal(result, undefined);
    assert.match(s.status(), /已回退/);
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

test("C7 on: Jev unavailable keeps the original messages", async () => {
  const s = await setup(ON(), { answer: "fail" });
  try {
    const [result] = await s.host.emit("context", { messages: conversation() });
    assert.equal(result, undefined);
    assert.ok(s.jev.state.requests >= 1);
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

test("C7 shadow: would-reduce recorded, request unchanged", async () => {
  const s = await setup({ ...ON(), mode: "shadow" });
  try {
    const [result] = await s.host.emit("context", { messages: conversation() });
    assert.equal(result, undefined);
    await s.settled();
    assert.ok(s.jev.state.requests >= 1);
    assert.ok(s.events.some((e) => e.kind === "context" && e.outcome === "ok"));
    assert.match(s.status(), /仅观察（本任务候选 2/);
  } finally {
    await s.cleanup();
  }
});

test("C7 legacy OMP_JEV_SPILL=0: nothing archived, request unchanged", async () => {
  const s = await setup(ON(), { env: { OMP_JEV_SPILL: "0" } });
  try {
    const [result] = await s.host.emit("context", { messages: conversation() });
    assert.equal(result, undefined);
    await s.settled();
  } finally {
    await s.cleanup();
  }
});

test("C7 cache guard: cache-dominated session left alone without asking Jev", async () => {
  const s = await setup(ON(), { env: { OMP_JEV_CACHE_CEILING: "0.8" } });
  try {
    const [result] = await s.host.emit("context", { messages: conversation({ input: 100, cacheRead: 9_900 }) });
    assert.equal(result, undefined);
    assert.equal(s.jev.state.requests, 0);
    assert.ok(s.events.some((e) => e.source === "context:cache_guard"));
    const [paying] = await s.host.emit("context", { messages: conversation({ input: 9_000, cacheRead: 1_000 }) });
    assert.ok(paying, "a session paying full price is reduced");
  } finally {
    await s.settled();
    await s.cleanup();
  }
});

// ---- C8 ---------------------------------------------------------------------------------------

const preparation = () => ({
  firstKeptEntryId: "entry-9",
  tokensBefore: 12_345,
  messagesToSummarize: conversation().slice(0, 5),
  turnPrefixMessages: [],
});

/** Keep c1's result (high score), drop c0's. */
const keepC1: Answer = (id, instructions) => (id.includes("t2") || instructions.includes("c1") ? 0.9 : 0.01);

test("C8 on: kept history verbatim, no summary generated, dropped result absent", async () => {
  const s = await setup(ON({ request: "off", compaction: "on" }), { answer: keepC1 });
  try {
    const [result] = await s.host.emit("session_before_compact", { preparation: preparation(), branchEntries: [], signal: new AbortController().signal });
    const compaction = (result as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number }; cancel?: boolean }).compaction;
    assert.ok(compaction, JSON.stringify(s.events));
    assert.equal((result as { cancel?: boolean }).cancel, undefined);
    assert.ok(compaction.summary.startsWith(VERBATIM_HEADER));
    assert.equal(compaction.firstKeptEntryId, "entry-9");
    assert.equal(compaction.tokensBefore, 12_345);
    for (const kept of ["fix the failing parsePort test", "step c0", "step c1", payload("c1"), '{"path":"c0.txt"}'])
      assert.ok(compaction.summary.includes(kept), `verbatim: ${kept.slice(0, 20)}`);
    assert.ok(!compaction.summary.includes(payload("c0")), "dropped result not retained");
    assert.ok(s.events.some((e) => e.source === "compaction:applied"));
  } finally {
    await s.cleanup();
  }
});

test("C8 failure paths return undefined so native compaction runs", async () => {
  const cases: Array<[string, Parameters<typeof setup>]> = [
    ["jev down", [ON({ request: "off", compaction: "on" }), { answer: "fail" }]],
    ["compaction budget 0", [{ ...ON({ request: "off", compaction: "on" }), budget: { compactRequests: 0 } }, {}]],
    ["everything kept (insufficient reduction)", [ON({ request: "off", compaction: "on" }), { answer: () => 0.99 }]],
    ["outbound not allowed", [{ ...ON({ request: "off", compaction: "on" }), outbound: { taskIntent: false } }, {}]],
    ["shadow", [{ ...ON({ request: "off", compaction: "on" }), mode: "shadow" }, { answer: keepC1 }]],
  ];
  for (const [name, args] of cases) {
    const s = await setup(...args);
    try {
      const [result] = await s.host.emit("session_before_compact", { preparation: preparation(), branchEntries: [], signal: new AbortController().signal });
      assert.equal(result, undefined, name);
      const [garbage] = await s.host.emit("session_before_compact", { preparation: { nope: 1 }, branchEntries: [], signal: new AbortController().signal });
      assert.equal(garbage, undefined, `${name}: unrecognized preparation`);
    } finally {
      await s.cleanup();
    }
  }
});

test("C8 has its own budget: a large multi-window compaction completes with the task budget exhausted", async () => {
  const s = await setup({ ...ON({ compaction: "on" }), budget: { maxRequestsPerTask: 1 } }, { answer: (id) => (id.endsWith("1") ? 0.9 : 0.01) });
  try {
    // Spend the task budget on request reduction first.
    await s.host.emit("context", { messages: conversation() });
    await s.settled();
    const taskRequests = s.jev.state.requests;
    assert.equal(taskRequests, 1);
    const big = [user("big region")];
    for (let i = 0; i < 12; i++) big.push(assistant([{ type: "text", text: `step r${i}` }, toolCall(`r${i}`)]) as never, toolResult(`r${i}`, `r${i}:` + "x".repeat(20_000)) as never);
    const [result] = await s.host.emit("session_before_compact", {
      preparation: { firstKeptEntryId: "e", tokensBefore: 99_999, messagesToSummarize: big, turnPrefixMessages: [] },
      branchEntries: [], signal: new AbortController().signal,
    });
    assert.ok((result as { compaction?: unknown })?.compaction, JSON.stringify(s.events.filter((e) => e.kind === "context")));
    assert.ok(s.jev.state.requests - taskRequests >= 3, "several windows, one request each at least");
    // Compaction drew nothing from the task budget: the next task gets its full budget.
    await s.host.emit("before_agent_start", { prompt: "next task" });
    const before = s.jev.state.requests;
    await s.host.emit("context", { messages: conversation() });
    await s.settled();
    assert.equal(s.jev.state.requests - before, 1, "new task budget intact after compaction");
  } finally {
    await s.cleanup();
  }
});

test("compaction budget keys are OMP-only", async () => {
  const { loadConfig } = await import("../../../../src/adapters/shared/index.ts");
  assert.equal((await loadConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ budget: { compactRequests: 3 } }) })).source, "invalid");
  const omp = await loadOmpConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ budget: { compactRequests: 3, compactWaitMs: 5000 } }), readLegacyText: ENOENT });
  assert.deepEqual([omp.config.budget.compactRequests, omp.config.budget.compactWaitMs], [3, 5000]);
});

// ---- proactive --------------------------------------------------------------------------------

async function agentEnd(s: Setup, percent: number, payload: Record<string, unknown> = {}) {
  s.host.usage.percent = percent;
  await s.host.emit("agent_end", { messages: [], ...payload });
  await s.settled();
}

test("proactive: below soft nothing; soft asks Jev for a natural break; hard compacts without Jev", async () => {
  const yes = await setup(ON({ request: "off", proactive: { mode: "on" } }), { answer: () => 0.9 });
  try {
    await agentEnd(yes, 69.9);
    assert.equal(yes.jev.state.requests, 0);
    assert.equal(yes.host.compacts, 0);
    await agentEnd(yes, 70);
    assert.equal(yes.jev.state.requests, 1);
    assert.match(yes.jev.state.bodies[0]!.questions.naturalBreak!.instructions, /natural break/);
    assert.equal(yes.host.compacts, 1);
    await agentEnd(yes, 80, { willContinue: true });
    assert.equal(yes.host.compacts, 1, "no compaction while a continuation is scheduled");
  } finally {
    await yes.cleanup();
  }

  const no = await setup(ON({ request: "off", proactive: { mode: "on" } }), { answer: () => 0.1 });
  try {
    await agentEnd(no, 85);
    assert.equal(no.jev.state.requests, 1);
    assert.equal(no.host.compacts, 0, "not a natural break");
    await agentEnd(no, 90);
    assert.equal(no.jev.state.requests, 1, "hard threshold does not ask Jev");
    assert.equal(no.host.compacts, 1, "hard threshold compacts");
  } finally {
    await no.cleanup();
  }

  const noHard = await setup(ON({ request: "off", proactive: { mode: "on", hardCompact: false } }), { answer: () => 0.1 });
  try {
    await agentEnd(noHard, 95);
    assert.equal(noHard.jev.state.requests, 1, "switch off: hard also asks Jev");
    assert.equal(noHard.host.compacts, 0);
  } finally {
    await noHard.cleanup();
  }

  const shadow = await setup({ ...ON({ request: "off", proactive: { mode: "on" } }), mode: "shadow" });
  try {
    await agentEnd(shadow, 95);
    assert.equal(shadow.host.compacts, 0);
    assert.ok(shadow.events.some((e) => e.source === "proactive:would_compact"));
  } finally {
    await shadow.cleanup();
  }
});

// ---- off --------------------------------------------------------------------------------------

test("off makes zero Jev requests and no host changes (session off, and on with every switch off)", async () => {
  for (const config of [{ ...ON({ compaction: "on", proactive: { mode: "on" } }), mode: "off" }, { ...ON({ request: "off" }), router: { tools: "off" } }]) {
    const s = await setup(config, { answer: () => 0.01 });
    try {
      assert.deepEqual(await s.host.emit("context", { messages: conversation() }), [undefined]);
      // Session off: no session_before_compact handler at all (OMP keeps its speculative compaction).
      assert.deepEqual(await s.host.emit("session_before_compact", { preparation: preparation(), branchEntries: [], signal: new AbortController().signal }), []);
      await agentEnd(s, 99);
      assert.equal(s.jev.state.requests, 0);
      assert.equal(s.host.compacts, 0);
      assert.deepEqual(s.host.active, ["read"], "jev_recall not activated");
      assert.deepEqual(s.host.setterCalls, []);
    } finally {
      await s.cleanup();
    }
  }
});

// ---- env compatibility ------------------------------------------------------------------------

test("env > new config > legacy file > default", async () => {
  const legacy = async (path: string) => {
    if (path.endsWith("jev-harness.json")) return JSON.stringify({ schemaVersion: 1, capabilities: { compaction: { mode: "on" } } });
    if (path.endsWith("jev-autorun.json")) return JSON.stringify({ mode: "dry-run", softContextPercent: 60, hardContextPercent: 80 });
    return ENOENT();
  };
  const load = (env: Record<string, string>, file?: unknown, readLegacyText = legacy) =>
    loadOmpConfig({ home: "/h", env, readText: file === undefined ? ENOENT : async () => JSON.stringify(file), readLegacyText });

  // default (no file, no legacy, no env)
  const none = await load({}, undefined, ENOENT);
  const d = ompContextSettings(none);
  assert.equal(none.config.context.request, "off");
  assert.deepEqual([d.compaction, d.proactive.mode, d.proactive.softPercent, d.proactive.hardPercent, d.keepThreshold, d.minReduction, d.preserveRecent, d.spill], ["off", "off", 70, 90, 0.2, 0.25, 0, true]);

  // legacy fills what the new config does not set
  const leg = await load({});
  const l = ompContextSettings(leg);
  assert.equal(leg.config.context.request, "on");
  assert.deepEqual([l.compaction, l.proactive.mode, l.proactive.softPercent, l.proactive.hardPercent], ["on", "shadow", 60, 80]);
  assert.equal(l.sources.request, "legacy");

  // new config beats legacy
  const cfg = await load({}, { context: { request: "shadow", compaction: "off", proactive: { softPercent: 65, hardPercent: 85 }, fastJev: { keepThreshold: 0.3, spillDir: "/cfg/spill" } } });
  const c = ompContextSettings(cfg);
  assert.equal(cfg.config.context.request, "shadow");
  assert.deepEqual([c.compaction, c.proactive.mode, c.proactive.softPercent, c.keepThreshold], ["off", "shadow", 65, 0.3]);
  assert.equal(cfg.config.context.storeDir, "/cfg/spill");

  // env beats both
  const env = await load({
    OMP_JEV_CONTEXT: "0", OMP_JEV_KEEP_THRESHOLD: "0.4", OMP_JEV_PRESERVE_RECENT: "3", OMP_JEV_MIN_REDUCTION: "0.5", OMP_JEV_SPILL: "0",
    OMP_JEV_SPILL_DIR: "/env/spill", OMP_JEV_CACHE_CEILING: "0.7", OMP_JEV_TIMEOUT_MS: "1234", OMP_JEV_BASE_URL: "http://127.0.0.1:9/jev",
    OMP_JEV_MODEL: "jev-x", OMP_JEV_PROVIDER: "openrouter", OMP_TELEMETRY_PATH: "/env/tel/plugin-events.jsonl", OMP_TELEMETRY_MAX_BYTES: "8192",
  }, { telemetryDir: "/cfg/tel", jev: { timeoutMs: 999 }, context: { request: "on", fastJev: { keepThreshold: 0.3, spillDir: "/cfg/spill" } } });
  const e = ompContextSettings(env);
  assert.equal(env.config.context.request, "off");
  assert.deepEqual([e.keepThreshold, e.preserveRecent, e.minReduction, e.spill, e.cacheCeiling, e.model], [0.4, 3, 0.5, false, 0.7, "jev-x"]);
  assert.equal(env.config.context.storeDir, "/env/spill");
  assert.equal(env.config.jev.timeoutMs, 1234);
  assert.equal(env.config.jev.url, "http://127.0.0.1:9/jev");
  assert.equal(env.config.telemetryDir, "/env/tel");
  assert.match(e.notes.join("\n"), /OMP_JEV_PROVIDER=openrouter/);
  assert.equal(ompTelemetryMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "8192" }), 8192);
  assert.equal(ompTelemetryMaxBytes({ OMP_TELEMETRY_MAX_BYTES: "100" }), undefined, "legacy rule: below 4096 ignored");
  assert.equal((await load({ OMP_JEV_CONTEXT: "1" }, { context: { request: "off" } })).config.context.request, "on");
});

test("OMP_TELEMETRY=0 writes no telemetry; otherwise events.jsonl is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-l4-tel-"));
  try {
    const event = { runId: "run_00000000-0000-4000-8000-000000000000", decisionId: "dec_00000000-0000-4000-8000-000000000000", kind: "context", outcome: "ok", durationMs: 1 } as TelemetryInput;
    await defaultOmpHostDeps({ env: { OMP_TELEMETRY: "0" } }).createTelemetry(join(dir, "off")).record(event);
    await assert.rejects(readdir(join(dir, "off")), { code: "ENOENT" });
    await defaultOmpHostDeps({ env: { OMP_TELEMETRY: "1" } }).createTelemetry(join(dir, "on")).record(event);
    assert.deepEqual(await readdir(join(dir, "on")), ["events.jsonl"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OMP_JEV_ALLOW_DROPPING_CALLS: only \"1\" lets C8 drop a low-scoring call record", async () => {
  for (const [value, dropsCall] of [["1", true], ["true", false], ["", false]] as const) {
    const s = await setup(ON({ request: "off", compaction: "on" }), { answer: () => 0.01, env: { OMP_JEV_ALLOW_DROPPING_CALLS: value } });
    try {
      const [result] = await s.host.emit("session_before_compact", { preparation: preparation(), branchEntries: [], signal: new AbortController().signal });
      const summary = (result as { compaction: { summary: string } }).compaction.summary;
      assert.equal(!summary.includes("Tool call: read (c0)"), dropsCall, `value ${JSON.stringify(value)}`);
    } finally {
      await s.cleanup();
    }
  }
});

test("C8 wait stays below OMP's handler timeout; a failed batch aborts the other in-flight batches", async () => {
  const cfg = (compactWaitMs?: number) => ({ budget: { maxRequestsPerTask: 2, waitMs: 1, ...(compactWaitMs ? { compactWaitMs } : {}) } }) as never;
  assert.equal(compactionWaitMs(cfg()), 25_000);
  assert.equal(compactionWaitMs(cfg(10_000)), 10_000);
  assert.equal(compactionWaitMs(cfg(60_000), 20_000), 15_000);

  const signals: AbortSignal[] = [];
  let calls = 0;
  const s = await setup(ON({ request: "off", compaction: "on" }), { answer: () => 0.01 });
  const hanging = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
    calls++;
    if (init?.signal) signals.push(init.signal);
    if (calls === 1) return new Response("down", { status: 503 });
    return await new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  }) as typeof globalThis.fetch;
  s.jev.use(hanging);
  try {
    const big = [user("big region")];
    for (let i = 0; i < 6; i++) big.push(assistant([{ type: "text", text: `step r${i}` }, toolCall(`r${i}`)]) as never, toolResult(`r${i}`, `r${i}:` + "x".repeat(70_000)) as never);
    const [result] = await s.host.emit("session_before_compact", {
      preparation: { firstKeptEntryId: "e", tokensBefore: 1, messagesToSummarize: big, turnPrefixMessages: [] }, branchEntries: [], signal: new AbortController().signal,
    });
    assert.equal(result, undefined, "native fallback");
    assert.ok(signals.length >= 1 && signals.every((signal) => signal.aborted), `all batch requests aborted (${signals.length})`);
  } finally {
    await s.cleanup();
  }
});

test("Pi still rejects the OMP-only context keys", async () => {
  const { loadConfig } = await import("../../../../src/adapters/shared/index.ts");
  const pi = await loadConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ context: { compaction: "on" } }) });
  assert.equal(pi.source, "invalid");
  assert.equal(pi.config.context.omp, undefined);
});
