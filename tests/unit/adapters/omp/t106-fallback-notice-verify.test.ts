/**
 * T106 verifier: edge cases for the provider-chain fallback notice, telemetry allowlist and
 * concurrency. Fake OMP host, fake Jev (injected fetch). No ~/.omp, ~/.pi or network.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler } from "../../../../src/adapters/omp/types.ts";
import { sanitizeEvent } from "../../../../src/telemetry/writer.ts";

const KEY = "zz-fake-key-T106V-";
const urlOf = (id: string) => `https://${id}-t106v.example.invalid/v1/secretpath`;
const PROMPT_MARK = "PROMPT-MARK-T106V";

type Reply = number | "network";
type Step = Reply | (() => Promise<Reply>);

interface HostOptions { ui?: "ok" | "none" | "throws" | "getter-throws" }

function fakeHost(options: HostOptions) {
  const handlers = new Map<string, OmpHandler[]>();
  const commands = new Map<string, (args: string, ctx: OmpContext) => unknown>();
  const notes: { message: string; level: string }[] = [];
  const statusNotes: string[] = [];
  const view = { child: false };
  const base: Record<string, unknown> = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => (view.child ? { parentSession: "parent" } : {}), getSessionId: () => "s-t106v", getLeafId: () => "leaf", getBranch: () => [{ id: "leaf" }] },
    getContextUsage: () => ({ percent: null }),
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: () => {},
  };
  const ui = options.ui ?? "ok";
  if (ui === "ok") base.ui = { notify: (message: string, level: string) => { notes.push({ message, level }); } };
  if (ui === "throws") base.ui = { notify: () => { throw new Error("notify boom"); } };
  if (ui === "getter-throws") Object.defineProperty(base, "ui", { get: () => { throw new Error("ui getter boom"); }, enumerable: false });
  const ctx = base as unknown as OmpContext;
  const statusCtx = { ...base, ui: { notify: (m: string) => { statusNotes.push(m); } } } as unknown as OmpContext;
  const api = {
    pi: { VERSION: "18.4.1" },
    on: (event: string, handler: OmpHandler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name: string, o: { handler: (args: string, ctx: OmpContext) => unknown }) => { commands.set(name, o.handler); },
    registerTool: () => {},
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["read"],
    getCommands: () => [],
    getThinkingLevel: () => undefined,
    setActiveTools: async () => {},
    setModel: () => true,
    setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  const status = async () => {
    statusNotes.length = 0;
    await commands.get("jev")!("status", statusCtx);
    return statusNotes.join("\n");
  };
  return { api, emit, status, notes, view };
}

async function setup(options: HostOptions & { providers?: string[]; config?: Record<string, unknown> } = {}) {
  const ids = options.providers ?? ["internal", "typesafe"];
  const dir = await mkdtemp(join(tmpdir(), "omp-t106v-"));
  const host = fakeHost(options);
  const plan: Record<string, Step> = Object.fromEntries(ids.map((id) => [id, 200]));
  const hits: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const flight = { now: 0, max: 0 };
  const events: Record<string, unknown>[] = [];
  const fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const id = ids.find((p) => String(input) === urlOf(p))!;
    hits[id]!++;
    const step = plan[id]!;
    flight.max = Math.max(flight.max, ++flight.now);
    const reply = typeof step === "function" ? await step().finally(() => flight.now--) : (flight.now--, step);
    if (reply === "network") throw new TypeError(`fetch failed ${KEY}${id}`);
    if (reply !== 200) return new Response(`upstream said ${KEY}${id} for ${PROMPT_MARK}`, { status: reply });
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria?: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([qid, question]) => {
      if (!question.criteria) return [qid, { type: "noul", noul: 0.01 }];
      const opts = Object.keys(question.criteria);
      const rest = 0.3 / Math.max(1, opts.length - 1);
      return [qid, { type: "choice", choice: opts[0], confidence: 0.9, probabilities: Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 0.7 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const config = {
    mode: "shadow", effort: "off", outbound: { taskIntent: true }, router: { tools: "shadow" }, budget: { maxRequestsPerTask: 50, waitMs: 5000 },
    ...options.config,
    context: { storeDir: join(dir, "store"), ...(options.config?.context as object | undefined) },
    jev: { providers: ids.map((id) => ({ id, url: urlOf(id), model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: `FAKE_T106V_${id.toUpperCase()}` })) },
  };
  const env = Object.fromEntries(ids.map((id) => [`FAKE_T106V_${id.toUpperCase()}`, `${KEY}${id}`]));
  const overrides: Partial<OmpHostDeps> = {
    env,
    loadConfig: () => loadOmpConfig({ home: dir, path: join(dir, "config.json"), env: {}, readText: async () => JSON.stringify(config) }),
    fetch,
    createTelemetry: () => ({ record: async (e: unknown) => { events.push(e as Record<string, unknown>); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
  };
  const registry = {};
  createExtension(overrides, registry)(host.api);
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  let n = 0;
  const task = async (prompt = `List the files in src ${PROMPT_MARK} ${n++}`) => {
    await host.emit("before_agent_start", { prompt });
    await claim.settled();
  };
  const cleanup = async () => {
    await host.emit("session_shutdown");
    await rm(dir, { recursive: true, force: true });
  };
  return { host, plan, hits, flight, events, task, claim, cleanup, ids };
}

function barrier(count: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return async () => { if (++arrived >= count) open(); await gate; };
}

const leaks = (text: string, ids: string[]) =>
  [KEY, PROMPT_MARK, "secretpath", "example.invalid", "https://", "upstream said", ...ids.map(urlOf)].filter((s) => text.includes(s));

// ---- spec: all providers fail ------------------------------------------------------------------

test("1-provider chain: its only provider failing is 'all providers fail' and must warn once", async () => {
  const s = await setup({ providers: ["typesafe"] });
  try {
    s.plan.typesafe = 503;
    await s.host.emit("session_start");
    await s.task();
    await s.task();
    assert.ok(s.hits.typesafe! >= 1, "Jev was called");
    const warnings = s.host.notes.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1, `expected one outage notice for a 1-provider chain, got ${JSON.stringify(s.host.notes)}`);
  } finally {
    await s.cleanup();
  }
});

test("3-provider chain: a,b fail, c answers: one notice naming the first failure and the answering provider", async () => {
  const s = await setup({ providers: ["pa", "pb", "pc"] });
  try {
    s.plan.pa = "network";
    s.plan.pb = 502;
    await s.host.emit("session_start");
    await s.task();
    await s.task();
    assert.deepEqual(s.host.notes.map((n) => n.message), ["Jev：pa 不可用（network_error），已回退到 pc"]);
    const status = await s.host.status();
    assert.match(status, /last answered pc/);
    assert.deepEqual(leaks(status, s.ids), []);
  } finally {
    await s.cleanup();
  }
});

// ---- secrets ------------------------------------------------------------------------------------

test("error bodies echoing key and task text never reach notice, status or telemetry", async () => {
  const s = await setup();
  try {
    s.plan.internal = 503;
    s.plan.typesafe = 200;
    await s.host.emit("session_start");
    await s.task();
    s.plan.typesafe = 500;
    await s.task();
    assert.equal(s.host.notes.length, 2, JSON.stringify(s.host.notes));
    for (const n of s.host.notes) assert.deepEqual(leaks(n.message, s.ids), [], n.message);
    assert.deepEqual(leaks(await s.host.status(), s.ids), []);
    const chainRows = s.events.filter((e) => e.chain);
    assert.ok(chainRows.length >= 4);
    for (const e of chainRows) {
      const clean = sanitizeEvent(e, 1) as { chain?: unknown } | undefined;
      assert.ok(clean?.chain, `chain row survives the sanitizer: ${JSON.stringify(e)}`);
      assert.deepEqual(leaks(JSON.stringify(clean), s.ids), []);
    }
    assert.deepEqual(leaks(JSON.stringify(chainRows), s.ids), []);
  } finally {
    await s.cleanup();
  }
});

// ---- ui robustness ------------------------------------------------------------------------------

for (const ui of ["none", "throws", "getter-throws"] as const) {
  test(`ui=${ui}: fallback and all-fail never throw; telemetry still recorded`, async () => {
    const s = await setup({ ui });
    try {
      s.plan.internal = 503;
      await s.host.emit("session_start");
      await s.task();
      s.plan.typesafe = 503;
      await s.task();
      assert.equal(s.events.filter((e) => e.chain).length, 4);
    } finally {
      await s.cleanup();
    }
  });
}

// ---- concurrency --------------------------------------------------------------------------------

test("concurrency: two tasks falling back at the same time produce one notice", async () => {
  const s = await setup();
  try {
    const both = barrier(2);
    s.plan.internal = async () => { await both(); return 503; };
    await s.host.emit("session_start");
    await s.host.emit("before_agent_start", { prompt: "first task in parallel" });
    await s.host.emit("before_agent_start", { prompt: "second task in parallel" });
    await s.claim.settled();
    assert.equal(s.hits.internal, 2, "both calls reached internal concurrently");
    assert.equal(s.hits.typesafe, 2);
    assert.deepEqual(s.host.notes.map((n) => n.message), ["Jev：internal 不可用（http_error 503），已回退到 typesafe"]);
  } finally {
    await s.cleanup();
  }
});

test("concurrency: two tasks failing on every provider at the same time produce one notice", async () => {
  const s = await setup();
  try {
    const first = barrier(2);
    const second = barrier(2);
    s.plan.internal = async () => { await first(); return 503; };
    s.plan.typesafe = async () => { await second(); return 502; };
    await s.host.emit("session_start");
    await s.host.emit("before_agent_start", { prompt: "first task in parallel" });
    await s.host.emit("before_agent_start", { prompt: "second task in parallel" });
    await s.claim.settled();
    assert.equal(s.host.notes.length, 1, JSON.stringify(s.host.notes));
    assert.match(s.host.notes[0]!.message, /^Jev：所有 provider 均不可用/);
  } finally {
    await s.cleanup();
  }
});

// Compaction batches of one window run in parallel under ONE decisionId (compaction.ts asker).
const bigRegion = () => {
  const user = (text: string) => ({ role: "user", content: text });
  const out: unknown[] = [user("big region")];
  const id = (i: number) => `c${i}-qqqqq`;
  for (let i = 0; i < 300; i++) {
    out.push({ role: "assistant", content: [{ type: "text", text: `s${i}` }, { type: "toolCall", id: id(i), name: "read", arguments: { path: `${i}.txt` } }] });
    out.push({ role: "toolResult", toolCallId: id(i), toolName: "read", content: [{ type: "text", text: "r" }], isError: false });
  }
  return out;
};
const COMPACT = { mode: "on", router: { tools: "off" }, context: { request: "off", compaction: "on" } };

test("concurrency (compaction, shared decisionId): parallel batches falling back produce one notice", async () => {
  const s = await setup({ config: COMPACT });
  try {
    await s.host.emit("session_start");
    await s.task();
    s.hits.internal = 0;
    s.plan.internal = async () => { await new Promise((r) => setTimeout(r, 5)); return 503; };
    await s.host.emit("session_before_compact", {
      preparation: { firstKeptEntryId: "e", tokensBefore: 99_999, messagesToSummarize: bigRegion(), turnPrefixMessages: [] },
      branchEntries: [], signal: new AbortController().signal,
    });
    await s.claim.settled();
    assert.ok(s.flight.max >= 2, `need batches in flight together, max ${s.flight.max}`);
    assert.deepEqual(s.host.notes.map((n) => n.message), ["Jev：internal 不可用（http_error 503），已回退到 typesafe"]);
  } finally {
    await s.cleanup();
  }
});

test("concurrency (compaction, shared decisionId): a notice never claims a fallback to the provider that failed", async () => {
  const s = await setup({ config: COMPACT });
  try {
    await s.host.emit("session_start");
    await s.task();
    s.hits.internal = 0;
    // First batch to reach internal fails; the others (same decisionId) answer from internal, after the failure is recorded.
    let calls = 0;
    let failed!: () => void;
    const failedOnce = new Promise<void>((resolve) => { failed = resolve; });
    s.plan.internal = async () => {
      if (++calls === 1) { setTimeout(failed, 0); return 503; }
      await failedOnce;
      await new Promise((r) => setTimeout(r, 5));
      return 200;
    };
    let release!: () => void;
    const typesafeGate = new Promise<void>((resolve) => { release = resolve; });
    s.plan.typesafe = async () => { await typesafeGate; return 200; };
    const compacting = s.host.emit("session_before_compact", {
      preparation: { firstKeptEntryId: "e", tokensBefore: 99_999, messagesToSummarize: bigRegion(), turnPrefixMessages: [] },
      branchEntries: [], signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await compacting;
    await s.claim.settled();
    assert.ok(calls >= 2, `need >=2 batches, got ${calls}`);
    assert.ok(s.flight.max >= 2, `need batches in flight together, max ${s.flight.max}`);
    for (const n of s.host.notes) assert.doesNotMatch(n.message, /internal 不可用.*已回退到 internal/, n.message);
  } finally {
    await s.cleanup();
  }
});

// ---- telemetry allowlist ------------------------------------------------------------------------

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const base = { runId: `run_${UUID}`, decisionId: `dec_${UUID}`, kind: "jev_attempt", outcome: "fallback", durationMs: 3 };
const good = { providerId: "internal", outcome: "http_error", fellBack: true, httpStatus: 503 };

test("allowlist: dirty provider ids drop the whole chain field", () => {
  for (const providerId of ["https://x.example/v1", "a b", "a/b", "a:b", "key=sk-123", "", "-lead", ".lead", "x".repeat(65), "内部", "a\nb", 42, null]) {
    const out = sanitizeEvent({ ...base, chain: { ...good, providerId } }, 1) as { chain?: unknown } | undefined;
    assert.ok(out, `event kept for ${String(providerId)}`);
    assert.equal(out.chain, undefined, `providerId ${JSON.stringify(providerId)} must drop chain`);
  }
  assert.deepEqual((sanitizeEvent({ ...base, chain: { ...good, providerId: "a".repeat(64) } }, 1) as { chain?: { providerId: string } }).chain?.providerId, "a".repeat(64));
});

test("allowlist: outcomes, fellBack and shape outside the whitelist drop chain; extra fields never copied", () => {
  for (const chain of [
    { ...good, outcome: "fallback" }, { ...good, outcome: "HTTP_ERROR" }, { ...good, outcome: "http_error 503" }, { ...good, outcome: undefined },
    { ...good, fellBack: "true" }, { ...good, fellBack: 1 }, { providerId: "internal", outcome: "ok" }, [good], "internal", null,
  ]) {
    const out = sanitizeEvent({ ...base, chain }, 1) as { chain?: unknown };
    assert.equal(out.chain, undefined, JSON.stringify(chain));
  }
  const extra = sanitizeEvent({ ...base, chain: { ...good, url: "https://x", key: "sk-1", body: "task text", error: "boom" } }, 1) as { chain?: unknown };
  assert.deepEqual(extra.chain, good);
});

test("allowlist: httpStatus kept only as an integer 100..599; chain only on jev_attempt", () => {
  for (const httpStatus of [99, 600, 503.5, "503", Number.NaN, -1, Infinity]) {
    const out = sanitizeEvent({ ...base, chain: { ...good, httpStatus } }, 1) as { chain?: Record<string, unknown> };
    assert.deepEqual(out.chain, { providerId: "internal", outcome: "http_error", fellBack: true }, String(httpStatus));
  }
  for (const httpStatus of [100, 599]) assert.equal((sanitizeEvent({ ...base, chain: { ...good, httpStatus } }, 1) as { chain: { httpStatus: number } }).chain.httpStatus, httpStatus);
  const other = sanitizeEvent({ ...base, kind: "route_tools", outcome: "ok", chain: good }, 1) as { chain?: unknown } | undefined;
  assert.equal(other?.chain, undefined);
});

// ---- round 2 ------------------------------------------------------------------------------------

test("off from session start: a prompt, compaction and stop cause 0 Jev calls and 0 notices", async () => {
  const s = await setup({ config: { mode: "off", context: { request: "on", compaction: "on" } } });
  try {
    s.plan.internal = 503;
    s.plan.typesafe = 503;
    await s.host.emit("session_start");
    await s.task();
    await s.host.emit("context", { messages: [{ role: "user", content: "x" }] });
    await s.host.emit("session_before_compact", {
      preparation: { firstKeptEntryId: "e", tokensBefore: 99_999, messagesToSummarize: bigRegion(), turnPrefixMessages: [] },
      branchEntries: [], signal: new AbortController().signal,
    });
    await s.host.emit("session_stop", {});
    await s.host.emit("agent_end", { messages: [] });
    await s.claim.settled();
    assert.deepEqual([s.hits.internal, s.hits.typesafe], [0, 0]);
    assert.deepEqual(s.host.notes, []);
  } finally {
    await s.cleanup();
  }
});

test("1-provider chain: non-outage failures (bad request) do not warn; outage warns again after recovery", async () => {
  const s = await setup({ providers: ["typesafe"] });
  try {
    await s.host.emit("session_start");
    s.plan.typesafe = 400;
    await s.task();
    assert.equal(s.host.notes.length, 0, "400 is our request, not an outage");
    s.plan.typesafe = "network";
    await s.task();
    await s.task();
    s.plan.typesafe = 200;
    await s.task();
    s.plan.typesafe = 503;
    await s.task();
    assert.deepEqual(s.host.notes.map((n) => n.message), [
      "Jev：typesafe 不可用（network_error），本次跳过",
      "Jev：typesafe 不可用（http_error 503），本次跳过",
    ]);
  } finally {
    await s.cleanup();
  }
});

test("OMP single-url (no chain config): outage warns once, chain telemetry recorded, no url/key leak", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-t106v-su-"));
  const host = fakeHost({});
  const url = "https://single-t106v.example.invalid/v1/secretpath";
  let hits = 0;
  const events: Record<string, unknown>[] = [];
  const fetch = (async () => { hits++; return new Response(`echo ${KEY}single ${PROMPT_MARK}`, { status: 502 }); }) as unknown as typeof globalThis.fetch;
  const config = { mode: "shadow", effort: "off", outbound: { taskIntent: true }, router: { tools: "shadow" }, budget: { maxRequestsPerTask: 10, waitMs: 5000 }, jev: { url } };
  const registry = {};
  createExtension({
    env: { TYPESAFE_API_KEY: `${KEY}single` },
    loadConfig: () => loadOmpConfig({ home: dir, path: join(dir, "config.json"), env: {}, readText: async () => JSON.stringify(config) }),
    fetch,
    createTelemetry: () => ({ record: async (e: unknown) => { events.push(e as Record<string, unknown>); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
  }, registry)(host.api);
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  try {
    await host.emit("session_start");
    for (const p of ["one task", "two task"]) { await host.emit("before_agent_start", { prompt: `${p} ${PROMPT_MARK}` }); await claim.settled(); }
    assert.ok(hits >= 2);
    assert.deepEqual(host.notes.map((n) => n.message), ["Jev：typesafe 不可用（http_error 502），本次跳过"]);
    const chainRows = events.filter((e) => e.chain);
    assert.ok(chainRows.length >= 2);
    const text = JSON.stringify([host.notes, chainRows, await host.status()]);
    for (const s of [KEY, PROMPT_MARK, "secretpath", "example.invalid"]) assert.ok(!text.includes(s), s);
  } finally {
    await host.emit("session_shutdown");
    await rm(dir, { recursive: true, force: true });
  }
});
