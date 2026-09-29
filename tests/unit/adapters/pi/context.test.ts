/**
 * request-level context reduction on Pi's `context` event and the `jev_recall` tool, driven
 * through the fake host. No real Pi, model or Jev: Jev is a fake fetch answering Noul questions;
 * archives go to a temp directory.
 */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../../../src/adapters/pi/config.ts";
import { isSpillNotice, type PiMessage, type SpillFs } from "../../../../src/context/index.ts";
import { fakeFetch, fakePi, harness, load, settled, type FakePi, type Harness, type JevRequest } from "./fake-host.ts";

const SESSION = "session-test";

// ---- fixtures ---------------------------------------------------------------------------------

const user = (text: string): PiMessage => ({ role: "user", content: text, timestamp: 1 }) as PiMessage;
const assistant = (content: unknown[]): PiMessage =>
  ({ role: "assistant", content, provider: "prov", model: "alpha", stopReason: "toolUse", timestamp: 2 }) as PiMessage;
const toolCall = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { path: `${id}.txt` } });
const toolResult = (id: string, name: string, text: string): PiMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 3 }) as PiMessage;
const payload = (id: string, filler = "D") => `${id}:` + filler.repeat(5_000);
const turn = (id: string, name = "read", text = payload(id)): PiMessage[] => [
  assistant([{ type: "text", text: `step ${id}` }, toolCall(id, name)]),
  toolResult(id, name, text),
];
/** Two old read turns, then a closing assistant message (recentTurns 1 covers only it). */
const conversation = (...turns: PiMessage[][]): PiMessage[] => [
  user("fix the failing parsePort test"),
  ...(turns.length ? turns : [turn("c0"), turn("c1")]).flat(),
  assistant([{ type: "text", text: "done" }]),
];
const textOf = (message: PiMessage | undefined): string =>
  ((message as unknown as { content: { text: string }[] }).content[0] as { text: string }).text;

/** Noul answers with a low keep probability: every scored result is dropped. */
function noul(yes = 0.01) {
  return (request: JevRequest): Response => {
    const answers = Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: "noul", noul: yes }]));
    return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

interface Options {
  request?: string;
  summaryReplacement?: string;
  on?: boolean;
  taskIntent?: boolean;
  maxRequestsPerTask?: number;
  contextFs?: SpillFs;
  jev?: (request: JevRequest) => Response;
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

async function session(options: Options = {}): Promise<Session> {
  const h = await harness();
  const storeDir = join(h.dir, "store");
  await writeFile(h.configPath, JSON.stringify({
    mode: "shadow",
    outbound: { taskIntent: options.taskIntent ?? true },
    router: { tools: false },
    ...(options.maxRequestsPerTask !== undefined ? { budget: { maxRequestsPerTask: options.maxRequestsPerTask } } : {}),
    context: {
      request: options.request ?? "shadow",
      ...(options.summaryReplacement !== undefined ? { summaryReplacement: options.summaryReplacement } : {}),
      limits: { recentTurns: 1 },
      storeDir,
    },
  }));
  const jev = fakeFetch(options.jev ?? noul());
  const fake = fakePi();
  const registry = load(fake, h.deps({ fetch: jev.fetch, ...(options.contextFs ? { contextFs: options.contextFs } : {}) }));
  await fake.emit("session_start", { reason: "startup" });
  if (options.on) await fake.command("mode on");
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

/** Node fs whose archive writes fail for payloads starting with `prefix`. */
function failingFs(prefix: string): SpillFs {
  const fs = nodeFs as unknown as SpillFs;
  return {
    ...fs,
    mkdir: (path, options) => fs.mkdir(path, options),
    chmod: (path, mode) => fs.chmod(path, mode),
    rename: (from, to) => fs.rename(from, to),
    rm: (path, options) => fs.rm(path, options),
    readFile: (path) => fs.readFile(path),
    readdir: (path) => fs.readdir(path),
    lstat: (path) => fs.lstat(path),
    writeFile: async (path, data, options) => {
      if (Buffer.from(data).toString("utf8").startsWith(prefix)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.writeFile(path, data, options);
    },
  };
}

/** Let background reductions and artifact writes finish, then remove the temp directory. */
async function close(s: Session): Promise<void> {
  await settled(s.registry);
  await s.h.cleanup();
}

const HANDLE_RE = /spill:[a-z0-9._-]+:[0-9a-f]{64}/;

// ---- behaviour --------------------------------------------------------------------------------

test("shadow returns the original messages unchanged and records decisions and stats", async () => {
  const s = await session({ request: "on" });
  try {
    const messages = conversation();
    const snapshot = structuredClone(messages);
    assert.equal(await s.context(messages), undefined, "shadow never returns messages");
    await settled(s.registry);
    assert.deepEqual(messages, snapshot, "event messages are not edited in place");
    assert.ok(s.jev.requests.length >= 1, "the reduction was computed");
    const events = await s.h.events();
    assert.ok(events.some((e) => e.kind === "context" && e.outcome === "ok"));
    const status = await s.status();
    assert.match(status, /上下文裁剪（请求级）：仅观察（本任务候选 2，可省约 [1-9]\d* 字符）/);
    assert.match(status, /摘要替换：关闭（原生路径）/);
    const summary = JSON.parse(await readFile(join(s.storeDir, SESSION, "context.json"), "utf8"));
    assert.equal(summary.request, "on");
    assert.equal(summary.summaryReplacement, "off");
    assert.deepEqual(summary.tasks[0].spills, { ok: 2, failed: 0 });
    assert.ok(summary.tasks[0].last.chars.after < summary.tasks[0].last.chars.before);
    assert.ok(summary.tasks[0].last.estimatedTokens.before > 0);
    const lines = (await readFile(join(s.storeDir, SESSION, "context.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].effective, "shadow");
    assert.equal(lines[0].applied, false);
    assert.doesNotMatch(JSON.stringify(lines), /DDDD/, "receipts carry no content");
  } finally {
    await close(s);
  }
});

test("on applies the reduction when every archive write succeeded", async () => {
  const s = await session({ request: "on", on: true });
  try {
    const messages = conversation();
    const snapshot = structuredClone(messages);
    const result = await s.context(messages);
    assert.ok(result?.messages, "reduced messages returned");
    assert.equal(result.messages.length, messages.length);
    assert.ok(isSpillNotice(textOf(result.messages[2])));
    assert.ok(isSpillNotice(textOf(result.messages[4])));
    assert.equal(result.messages[0], messages[0], "user instruction passes through");
    assert.deepEqual(messages, snapshot, "event messages are not edited in place");
    const archived = (await readdir(join(s.storeDir, SESSION))).filter((name) => /^[0-9a-f]{64}$/.test(name));
    assert.equal(archived.length, 2);
    assert.match(await s.status(), /上下文裁剪（请求级）：已应用（2 条已存档）/);
  } finally {
    await close(s);
  }
});

test("a spill failure keeps the original messages in on mode", async () => {
  const s = await session({ request: "on", on: true, contextFs: failingFs("c1:") });
  try {
    const messages = conversation();
    assert.equal(await s.context(messages), undefined, "one failed archive: originals are sent");
    assert.match(await s.status(), /上下文裁剪（请求级）：已回退（存档失败 1 条，保留原文）/);
    await settled(s.registry);
    const summary = JSON.parse(await readFile(join(s.storeDir, SESSION, "context.json"), "utf8"));
    assert.deepEqual(summary.tasks[0].spills, { ok: 1, failed: 1 });
  } finally {
    await close(s);
  }
});

test("request on with session mode shadow only observes", async () => {
  const s = await session({ request: "on" });
  try {
    assert.equal(await s.context(conversation()), undefined);
    await settled(s.registry);
    assert.match(await s.status(), /上下文裁剪（请求级）：仅观察/);
  } finally {
    await close(s);
  }
});

test("outbound.taskIntent=false sends no Jev request and records the reason", async () => {
  const s = await session({ request: "on", on: true, taskIntent: false });
  try {
    assert.equal(await s.context(conversation()), undefined);
    await settled(s.registry);
    assert.equal(s.jev.requests.length, 0);
    const events = await s.h.events();
    assert.ok(events.some((e) => e.kind === "context" && e.outcome === "withheld"));
    assert.match(await s.status(), /上下文裁剪（请求级）：已回退（outbound\.taskIntent=false，不发请求）/);
  } finally {
    await close(s);
  }
});

test("a credential in the history withholds the Jev request", async () => {
  const s = await session({ request: "on", on: true });
  try {
    // Result text never leaves (fast-jev sends only its length); message text and call inputs do.
    const messages = conversation();
    messages[0] = user("fix the failing parsePort test; log in with password=hunter2secret");
    assert.equal(await s.context(messages), undefined);
    assert.equal(s.jev.requests.length, 0);
    assert.match(await s.status(), /已回退（检测到凭据形态，未发送 Jev 请求）/);
  } finally {
    await close(s);
  }
});

test("an exhausted per-task budget sends no request and keeps the original messages", async () => {
  const s = await session({ request: "on", on: true, maxRequestsPerTask: 0 });
  try {
    assert.equal(await s.context(conversation()), undefined);
    assert.equal(s.jev.requests.length, 0);
    assert.match(await s.status(), /已回退（本任务 Jev 请求预算已用完）/);
  } finally {
    await close(s);
  }
});

test("jev_recall returns the exact archived content", async () => {
  const s = await session({ request: "on", on: true });
  try {
    const messages = conversation();
    const result = await s.context(messages);
    const handle = HANDLE_RE.exec(textOf(result?.messages?.[2]))?.[0];
    assert.ok(handle?.startsWith(`spill:${SESSION}:`));
    const recalled = await s.fake.runTool("jev_recall", { handle });
    assert.equal(recalled.content[0]?.text, textOf(messages[2]));
    await settled(s.registry);
    const summary = JSON.parse(await readFile(join(s.storeDir, SESSION, "context.json"), "utf8"));
    assert.equal(summary.tasks[0].recalls, 1);
  } finally {
    await close(s);
  }
});

test("jev_recall rejects a handle of another session, paths and traversal", async () => {
  const s = await session({ request: "shadow" });
  try {
    const schema = s.fake.tools.get("jev_recall")?.parameters as unknown as { properties: Record<string, { type: string }>; required: string[]; additionalProperties: boolean };
    assert.deepEqual(Object.keys(schema.properties), ["handle"], "a handle only, never a path parameter");
    assert.equal(schema.properties.handle?.type, "string");
    assert.deepEqual(schema.required, ["handle"]);
    assert.equal(schema.additionalProperties, false);
    await assert.rejects(s.fake.runTool("jev_recall", { handle: `spill:other-session:${"a".repeat(64)}` }), /foreign_session/);
    await assert.rejects(s.fake.runTool("jev_recall", { handle: "../../etc/passwd" }), /invalid_handle/);
    await assert.rejects(s.fake.runTool("jev_recall", { handle: join(s.storeDir, SESSION, "a".repeat(64)) }), /invalid_handle/);
    await assert.rejects(s.fake.runTool("jev_recall", { handle: `spill:${SESSION}:../../x` }), /invalid_handle/);
    await assert.rejects(s.fake.runTool("jev_recall", {}), /invalid_handle/);
  } finally {
    await close(s);
  }
});

test("recalled content is not dropped again in the same request", async () => {
  const s = await session({ request: "on", on: true });
  try {
    const recalledText = payload("r0", "R");
    const messages = conversation(turn("c0"), turn("r0", "jev_recall", recalledText), turn("c1"));
    const result = await s.context(messages);
    assert.ok(result?.messages);
    assert.equal(result.messages[4], messages[4], "the jev_recall result is the same object");
    assert.equal(textOf(result.messages[4]), recalledText);
    assert.ok(isSpillNotice(textOf(result.messages[2])));
    assert.ok(isSpillNotice(textOf(result.messages[6])));
  } finally {
    await close(s);
  }
});

test("jev_recall is registered only with context enabled and refuses once context is off", async () => {
  const off = await session({ request: "off" });
  try {
    assert.equal(off.fake.tools.has("jev_recall"), false);
    assert.equal(await off.context(conversation()), undefined);
    assert.equal(off.jev.requests.length, 0);
  } finally {
    await close(off);
  }
  const s = await session({ request: "shadow" });
  try {
    assert.equal(s.fake.tools.has("jev_recall"), true);
    await writeFile(s.h.configPath, JSON.stringify({ mode: "shadow", context: { request: "off" } }));
    await s.fake.emit("session_start", { reason: "new" });
    await assert.rejects(s.fake.runTool("jev_recall", { handle: `spill:${SESSION}:${"a".repeat(64)}` }), /上下文裁剪未启用/);
  } finally {
    await close(s);
  }
});

test("summaryReplacement other than off makes the config invalid and the adapter off", async () => {
  const s = await session({ request: "on", summaryReplacement: "on" });
  try {
    const status = await s.status();
    assert.match(status, /Jev: off/);
    assert.match(status, /config: invalid \(context\.summaryReplacement must be off/);
    assert.match(status, /上下文裁剪（请求级）：关闭/);
    assert.match(status, /摘要替换：关闭（原生路径）/);
    assert.equal(await s.context(conversation()), undefined);
    assert.equal(s.jev.requests.length, 0);
  } finally {
    await close(s);
  }
  const read = (text: string) => loadConfig({ home: "/h", path: "/h/c.json", readText: async () => text });
  assert.equal((await read(JSON.stringify({ context: { summaryReplacement: "replace" } }))).source, "invalid");
  assert.equal((await read(JSON.stringify({ context: { request: "maybe" } }))).source, "invalid");
  assert.equal((await read(JSON.stringify({ context: { storeDir: "relative/dir" } }))).source, "invalid");
  assert.equal((await read(JSON.stringify({ context: { limits: { recentTurns: -1 } } }))).source, "invalid");
  const defaults = await read(JSON.stringify({}));
  assert.deepEqual(defaults.config.context, { request: "off", summaryReplacement: "off", limits: {}, storeDir: "/h/.pi/agent/pi-jev-harness/context" });
  const set = await read(JSON.stringify({ context: { request: "shadow", summaryReplacement: "off", limits: { minChars: 10, maxSessionBytes: 1024 }, storeDir: "/s" } }));
  assert.deepEqual(set.config.context, { request: "shadow", summaryReplacement: "off", limits: { minChars: 10, maxSessionBytes: 1024 }, storeDir: "/s" });
});

test("/jev status shows the request-level switch and summary replacement separately", async () => {
  const s = await session({ request: "off" });
  try {
    const status = await s.status();
    assert.match(status, /^上下文裁剪（请求级）：关闭$/m);
    assert.match(status, /^摘要替换：关闭（原生路径）$/m);
  } finally {
    await close(s);
  }
  const shadow = await session({ request: "shadow" });
  try {
    assert.match(await shadow.status(), /^上下文裁剪（请求级）：仅观察（本任务候选 0，可省约 0 字符）$/m);
    await shadow.fake.command("mode off");
    assert.match(await shadow.status(), /^上下文裁剪（请求级）：关闭$/m);
  } finally {
    await close(shadow);
  }
});

test("M4: a same-task follow-up reuses decisions; a new user task is a new revision and asks again", async () => {
  const s = await session({ request: "on", on: true });
  try {
    const messages = conversation();
    const first = await s.context(messages);
    assert.ok(first?.messages);
    const asked = s.jev.requests.length;
    assert.ok(asked >= 1);
    // Follow-up request in the same task (e.g. after another tool turn): cached, same bytes, no ask.
    const again = await s.context(messages);
    assert.equal(s.jev.requests.length, asked, "same task: no new Jev request");
    assert.deepEqual(again?.messages?.map(textOf), first.messages.map(textOf), "same task: identical replacement bytes");
    // A new user task invalidates the old task's decisions (technical §8 rule 4).
    await s.fake.emit("before_agent_start", { prompt: "now rename parsePort to parsePortNumber" });
    assert.ok((await s.context(messages))?.messages);
    assert.equal(s.jev.requests.length, asked * 2, "new task revision: decisions are made again");
  } finally {
    await close(s);
  }
});

test("T041 defect 4: a reduce capped by the remaining per-task budget applies the paid answers and reports truthful stats", async () => {
  const s = await session({ request: "on", on: true, maxRequestsPerTask: 1 });
  try {
    // Two windows' worth of old results would need two asks; only one is left.
    const big = (id: string) => turn(id, "read", `${id}:` + "Q".repeat(40_000));
    const messages = conversation(big("p0"), big("p1"), big("p2"));
    const result = await s.context(messages);
    assert.equal(s.jev.requests.length, 1, "never more than the per-task budget");
    assert.ok(result?.messages, "the paid answer is applied");
    assert.ok(result.messages.some((m) => m.role === "toolResult" && isSpillNotice(textOf(m))), "at least one result was archived");
    assert.ok(result.messages.some((m) => m.role === "toolResult" && !isSpillNotice(textOf(m))), "results beyond the budget stay verbatim");
    await settled(s.registry);
    const lines = (await readFile(join(s.storeDir, SESSION, "context.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.applied, true);
    assert.equal(last.reason, "reduced");
    assert.equal(last.stats.asks, 1);
    assert.ok(last.decisions.some((d: { reason: string }) => d.reason === "unscored_budget"), "unscored results are recorded as budget-limited");
    assert.match(await s.status(), /上下文裁剪（请求级）：已应用（/);
  } finally {
    await close(s);
  }
});

test("T049: a budget spent on failed Jev requests is reported as a Jev outage in the status and fallback reasons", async () => {
  const s = await session({ request: "on", on: true, maxRequestsPerTask: 2, jev: () => new Response("unavailable", { status: 503 }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal(await s.context(conversation()), undefined, "originals are sent while Jev is down");
    assert.ok(s.jev.requests.length > 0, "the failed requests were sent");
    const status = await s.status();
    assert.match(status, /上下文裁剪（请求级）：已回退（Jev 不可用（http_error），本任务 Jev 请求预算已被失败请求用完）/);
    assert.match(status, /fallback reasons: .*context: Jev 不可用（http_error）/);
    await settled(s.registry);
    const summary = JSON.parse(await readFile(join(s.storeDir, SESSION, "context.json"), "utf8"));
    assert.match(summary.tasks[0].fallback, /^Jev 不可用（http_error）/);
  } finally {
    await close(s);
  }
});
