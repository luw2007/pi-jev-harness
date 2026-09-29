/**
 * verification of request-level context reduction on Pi's `context` event and
 * `jev_recall`, through the real extension entry on the fake Pi host. Jev is a fake fetch;
 * archives go to a temp directory. No real Pi, Jev or model.
 */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../../../src/adapters/pi/config.ts";
import { isSpillNotice, type PiMessage, type SpillFs } from "../../../../src/context/index.ts";
import { fakeFetch, fakePi, harness, load, settled, type FakePi, type Harness, type JevRequest } from "./fake-host.ts";

const SESSION = "session-test";
const HEX = "0123456789abcdef".repeat(4);

const user = (text: string): PiMessage => ({ role: "user", content: text, timestamp: 1 }) as PiMessage;
const assistant = (content: unknown[]): PiMessage =>
  ({ role: "assistant", content, provider: "prov", model: "alpha", stopReason: "toolUse", timestamp: 2 }) as PiMessage;
const toolCall = (id: string, name: string, args: Record<string, unknown> = { path: `${id}.txt` }) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id: string, name: string, text: string): PiMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 3 }) as PiMessage;
const payload = (id: string, filler = "D", size = 5_000) => `${id}:` + filler.repeat(size);
const turn = (id: string, name = "read", text = payload(id), args?: Record<string, unknown>): PiMessage[] => [
  assistant([{ type: "text", text: `step ${id}` }, toolCall(id, name, args)]),
  toolResult(id, name, text),
];
const conversation = (...turns: PiMessage[][]): PiMessage[] => [user("fix the failing parsePort test"), ...turns.flat(), assistant([{ type: "text", text: "done" }])];
const textOf = (message: PiMessage | undefined): string => ((message as unknown as { content: { text: string }[] }).content[0] as { text: string }).text;

function noul(yes = 0.01) {
  return (request: JevRequest): Response => {
    const answers = Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: "noul", noul: yes }]));
    return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

interface Session {
  h: Harness;
  fake: FakePi;
  jev: ReturnType<typeof fakeFetch>;
  registry: object;
  storeDir: string;
  context(messages: PiMessage[]): Promise<{ messages?: PiMessage[] } | undefined>;
  status(): Promise<string>;
}

async function session(options: { request?: string; on?: boolean; maxRequestsPerTask?: number; contextFs?: SpillFs; limits?: Record<string, number>; sessionId?: string } = {}): Promise<Session> {
  const h = await harness();
  const storeDir = join(h.dir, "store");
  await writeFile(h.configPath, JSON.stringify({
    mode: "shadow",
    outbound: { taskIntent: true },
    router: { tools: false },
    ...(options.maxRequestsPerTask !== undefined ? { budget: { maxRequestsPerTask: options.maxRequestsPerTask } } : {}),
    context: { request: options.request ?? "on", limits: { recentTurns: 1, ...options.limits }, storeDir },
  }));
  const jev = fakeFetch(noul());
  const fake = fakePi();
  if (options.sessionId) (fake.ctx.sessionManager as unknown as { getSessionId: () => string }).getSessionId = () => options.sessionId!;
  const registry = load(fake, h.deps({ fetch: jev.fetch, ...(options.contextFs ? { contextFs: options.contextFs } : {}) }));
  await fake.emit("session_start", { reason: "startup" });
  if (options.on ?? true) await fake.command("mode on");
  await fake.emit("before_agent_start", { prompt: "fix the failing parsePort test" });
  return {
    h, fake, jev, registry, storeDir,
    async context(messages) {
      const [result] = await fake.emit("context", { messages });
      return result as never;
    },
    status: () => fake.command("status"),
  };
}

async function close(s: Session) {
  await settled(s.registry);
  await s.fake.emit("session_shutdown", { reason: "quit" });
  await s.h.cleanup();
}

function flakyFs(fail: (data: string, count: number) => boolean): SpillFs {
  const fs = nodeFs as unknown as SpillFs;
  let count = 0;
  return {
    mkdir: (path, options) => fs.mkdir(path, options),
    chmod: (path, mode) => fs.chmod(path, mode),
    rename: (from, to) => fs.rename(from, to),
    rm: (path, options) => fs.rm(path, options),
    readFile: (path) => fs.readFile(path),
    readdir: (path) => fs.readdir(path),
    lstat: (path) => fs.lstat(path),
    writeFile: async (path, data, options) => {
      if (fail(Buffer.from(data).toString("utf8"), ++count)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.writeFile(path, data, options);
    },
  };
}

const HANDLE_RE = /spill:[a-z0-9._-]+:[0-9a-f]{64}/;

// ---- spills --------------------------------------------------------------------------------

test("on: one failed archive among three keeps every original; the next request with a healthy disk applies without re-asking Jev", async () => {
  let broken = true;
  const s = await session({ contextFs: flakyFs((data) => broken && data.startsWith("c1:")) });
  try {
    const messages = conversation(...["c0", "c1", "c2"].map((id) => turn(id)));
    assert.equal(await s.context(messages), undefined);
    const asked = s.jev.requests.length;
    assert.ok(asked >= 1);
    broken = false;
    const result = await s.context(messages);
    assert.ok(result?.messages, "applied once every archive succeeded");
    for (const index of [2, 4, 6]) assert.ok(isSpillNotice(textOf(result.messages[index])), `message ${index}`);
    assert.equal(s.jev.requests.length, asked, "the cached verdicts are reused: no new Jev request");
  } finally { await close(s); }
});

test("on: a session archive quota too small for the payloads keeps the originals", async () => {
  const s = await session({ limits: { maxSessionBytes: 6_000 } });
  try {
    const messages = conversation(turn("c0"), turn("c1"));
    assert.equal(await s.context(messages), undefined);
    assert.match(await s.status(), /上下文裁剪（请求级）：已回退（存档失败 1 条，保留原文）/);
  } finally { await close(s); }
});

// ---- bounds --------------------------------------------------------------------------------

test("a huge message set stays bounded: at most the per-task budget of Jev requests, bounded request bodies, originals on overflow", async () => {
  const s = await session({ maxRequestsPerTask: 2 });
  try {
    const turns = Array.from({ length: 400 }, (_, i) => turn(`h${i}`, "read", payload(`h${i}`, "H", 20_000)));
    const messages = conversation(...turns);
    const started = Date.now();
    const result = await s.context(messages);
    const elapsed = Date.now() - started;
    assert.ok(s.jev.requests.length <= 2, `requests ${s.jev.requests.length}`);
    for (const request of s.jev.requests) assert.ok(JSON.stringify(request.body).length < 400_000, "request body is bounded");
    assert.ok(elapsed < 20_000, `took ${elapsed} ms`);
    if (result?.messages) assert.equal(result.messages.length, messages.length);
    await settled(s.registry);
    const [stats] = (await s.h.events()).filter((event) => event.kind === "context");
    assert.ok(stats, "the reduction was recorded");
    // A second event in the same task sends nothing more.
    await s.context(messages);
    assert.ok(s.jev.requests.length <= 2);
  } finally { await close(s); }
});

test("a history needing more asks than the per-task budget still uses the answers already paid for (partial reduction)", async () => {
  // 400 old read results need more than maxRequestsPerTask (2) Jev asks. The reducer's own ask cap
  // (maxAsks) leaves the rest unscored and applies what was scored; the adapter's budget refusal
  // instead fails the whole reduce, so both paid answers are thrown away on every task.
  const s = await session({ maxRequestsPerTask: 2 });
  try {
    const messages = conversation(...Array.from({ length: 400 }, (_, i) => turn(`h${i}`, "read", payload(`h${i}`, "H", 20_000))));
    const result = await s.context(messages);
    assert.equal(s.jev.requests.length, 2);
    assert.ok(result?.messages, "two paid Jev answers were discarded: nothing applied");
  } finally { await close(s); }
});

// ---- budget --------------------------------------------------------------------------------

test("budget: exhausted per task sends no ask and keeps originals; a new task resets it; routing never spends it", async () => {
  const s = await session({ maxRequestsPerTask: 1 });
  try {
    assert.ok((await s.context(conversation(turn("a0"), turn("a1"))))?.messages);
    assert.equal(s.jev.requests.length, 1);
    // New, uncached candidates in the same task: the budget is spent.
    assert.equal(await s.context(conversation(turn("b0"), turn("b1"))), undefined);
    assert.equal(s.jev.requests.length, 1, "no ask after the budget is spent");
    assert.match(await s.status(), /已回退（本任务 Jev 请求预算已用完）/);
    await s.fake.emit("before_agent_start", { prompt: "next task" });
    assert.ok((await s.context(conversation(turn("b0"), turn("b1"))))?.messages, "new task, new budget");
    assert.equal(s.jev.requests.length, 2);
  } finally { await close(s); }
});

test("budget in shadow: exhausted budget sends nothing either", async () => {
  const s = await session({ on: false, maxRequestsPerTask: 0 });
  try {
    assert.equal(await s.context(conversation(turn("a0"), turn("a1"))), undefined);
    await settled(s.registry);
    assert.equal(s.jev.requests.length, 0);
    assert.match(await s.status(), /仅观察（本任务候选 2，可省约 0 字符；本任务 Jev 请求预算已用完）/);
  } finally { await close(s); }
});

// ---- jev_recall ------------------------------------------------------------------------------

test("jev_recall rejects other sessions, uppercase hex, traversal and near-miss handles without reading anything", async () => {
  const s = await session();
  try {
    const result = await s.context(conversation(turn("c0"), turn("c1")));
    const handle = HANDLE_RE.exec(textOf(result?.messages?.[2]))![0];
    const digest = handle.split(":")[2]!;
    const cases: [unknown, RegExp][] = [
      [`spill:other-session:${digest}`, /foreign_session/],
      [`spill:${SESSION}:${digest.toUpperCase()}`, /invalid_handle/],
      [`spill:${SESSION.toUpperCase()}:${digest}`, /invalid_handle/],
      [`spill:..:${digest}`, /invalid_handle/],
      [`spill:../${SESSION}:${digest}`, /invalid_handle/],
      [`spill:${SESSION}:${digest}/..`, /invalid_handle/],
      [`spill:${SESSION}:${digest.slice(1)}`, /invalid_handle/],
      [`${handle}\n`, /invalid_handle/],
      [` ${handle}`, /invalid_handle/],
      [`spill:${SESSION}:${HEX}`, /not_found/],
      [42, /invalid_handle/],
    ];
    for (const [value, expected] of cases) await assert.rejects(s.fake.runTool("jev_recall", { handle: value }), expected, String(value));
    assert.equal((await s.fake.runTool("jev_recall", { handle })).content[0]?.text, payload("c0"));
  } finally { await close(s); }
});

test("jev_recall of a tampered archive fails as corrupted instead of returning altered content", async () => {
  const s = await session();
  try {
    const result = await s.context(conversation(turn("c0"), turn("c1")));
    const handle = HANDLE_RE.exec(textOf(result?.messages?.[2]))![0];
    await writeFile(join(s.storeDir, SESSION, handle.split(":")[2]!), "tampered");
    await assert.rejects(s.fake.runTool("jev_recall", { handle }), /corrupted/);
  } finally { await close(s); }
});

test("a handle from another session's archive in the same store is refused even though the file exists", async () => {
  const other = await session({ sessionId: "other-session" });
  let foreign: string;
  try {
    const result = await other.context(conversation(turn("c0"), turn("c1")));
    foreign = HANDLE_RE.exec(textOf(result?.messages?.[2]))![0];
    assert.ok(foreign.startsWith("spill:other-session:"));
    assert.ok((await other.fake.runTool("jev_recall", { handle: foreign })).content[0]?.text, "its own session reads it");
    // Same store, current session "session-test": the other session's handle is refused.
    (other.fake.ctx.sessionManager as unknown as { getSessionId: () => string }).getSessionId = () => SESSION;
    await assert.rejects(other.fake.runTool("jev_recall", { handle: foreign }), /foreign_session/);
  } finally { await close(other); }
});

test("sticky recall: a recalled result stays verbatim over later requests and is never asked about", async () => {
  const s = await session();
  try {
    const first = conversation(turn("c0"), turn("c1"));
    const result = await s.context(first);
    const handle = HANDLE_RE.exec(textOf(result?.messages?.[2]))![0];
    const recalled = (await s.fake.runTool("jev_recall", { handle })).content[0]!.text!;
    const history = [
      ...first.slice(0, -1),
      ...turn("rc", "jev_recall", recalled, { handle }),
      ...turn("c2"),
      ...turn("c3"),
      assistant([{ type: "text", text: "done" }]),
    ];
    const asked = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const before = s.jev.requests.length;
      const out = await s.context(history);
      for (const request of s.jev.requests.slice(before)) for (const id of Object.keys(request.body.questions)) asked.add(id);
      const messages = out?.messages ?? history;
      const recallIndex = history.findIndex((m) => (m as { toolCallId?: string }).toolCallId === "rc");
      assert.equal(textOf(messages[recallIndex]), recalled, `round ${round}: recalled content still visible`);
      assert.ok(isSpillNotice(textOf(messages[2])), `round ${round}: the original stays spilled (cached)`);
    }
    assert.ok(![...asked].some((id) => id.includes("rc")), `recall result never asked about: ${[...asked].join(",")}`);
  } finally { await close(s); }
});

// ---- config ---------------------------------------------------------------------------------

test("summaryReplacement: any value but the string off is invalid and forces the adapter off", async () => {
  const read = (context: unknown) => loadConfig({ home: "/h", path: "/h/c.json", readText: async () => JSON.stringify({ mode: "shadow", context }) });
  for (const value of ["on", "OFF", "Off", " off", "", null, false, true, 0, {}, ["off"]]) {
    const loaded = await read({ request: "shadow", summaryReplacement: value });
    assert.equal(loaded.source, "invalid", JSON.stringify(value));
    assert.equal(loaded.config.mode, "off", JSON.stringify(value));
    assert.equal(loaded.config.context.request, "off", JSON.stringify(value));
  }
  const ok = await read({ request: "shadow", summaryReplacement: "off" });
  assert.deepEqual([ok.source, ok.config.mode, ok.config.context.request], ["file", "shadow", "shadow"]);
});

test("invalid summaryReplacement: no context event is computed and jev_recall is not registered", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, context: { request: "on", summaryReplacement: "native" } }));
    const jev = fakeFetch(noul());
    const fake = fakePi();
    const registry = load(fake, h.deps({ fetch: jev.fetch }));
    await fake.emit("session_start", { reason: "startup" });
    assert.match(await fake.command("mode on"), /config invalid .*staying off/);
    await fake.emit("before_agent_start", { prompt: "x" });
    const [result] = await fake.emit("context", { messages: conversation(turn("c0"), turn("c1")) });
    assert.equal(result, undefined);
    await settled(registry);
    assert.equal(jev.requests.length, 0);
    assert.equal(fake.tools.has("jev_recall"), false);
    await fake.emit("session_shutdown", { reason: "quit" });
  } finally { await h.cleanup(); }
});

// ---- outbound ------------------------------------------------------------------------------

test("a credential in a tool-call argument withholds the Jev request (not only in message text)", async () => {
  const s = await session();
  try {
    const messages = conversation(turn("c0", "bash", payload("c0"), { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' x" }), turn("c1"));
    assert.equal(await s.context(messages), undefined);
    assert.equal(s.jev.requests.length, 0);
    assert.match(await s.status(), /检测到凭据形态/);
  } finally { await close(s); }
});

test("on: the event messages are never edited in place, whether the reduction applied or fell back", async () => {
  const s = await session({ contextFs: flakyFs((_data, count) => count === 1) });
  try {
    const messages = conversation(turn("c0"), turn("c1"));
    const snapshot = structuredClone(messages);
    await s.context(messages);
    assert.deepEqual(messages, snapshot);
    const applied = await s.context(messages);
    assert.ok(applied?.messages);
    assert.deepEqual(messages, snapshot);
    assert.ok((await readdir(join(s.storeDir, SESSION))).some((name) => /^[0-9a-f]{64}$/.test(name)));
  } finally { await close(s); }
});
