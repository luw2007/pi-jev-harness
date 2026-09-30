/**
 * T045: host-verified adapter defects on the fake host. E2 (the exec tool stays resident under
 * tool routing), E3 (a user abort is cancelled at every timing), E7 (routing outcomes in the run
 * record; telemetry runId equals run.json runId).
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { fakeFetch, fakePi, harness, JEV_URL, KEY, load, sourceInfo, TOOLS, validAnswer, type FakePi, type JevRequest } from "./fake-host.ts";

const TASK = "Fix the off-by-one in src/app.js";
const EXTRA: ToolInfo[] = ["grep", "find", "ls", "write"].map((name) => ({
  name, description: `The ${name} tool`, parameters: { type: "object", properties: { q: { type: "string" } } }, sourceInfo: sourceInfo("builtin"),
}));
const NATIVE = ["read", "bash", "edit", "grep", "find", "ls", "write"];
const MESSAGE_BASE = { provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };
const RUN_ID = "run_0f0e0d0c-0b0a-4908-8706-050403020100";

/** The tool question picks `edit`; every other question gets a valid answer. */
function chooseEdit(request: JevRequest): Response {
  if (!("tool" in request.body.questions)) return validAnswer(request);
  const answers = Object.fromEntries(Object.entries(request.body.questions).map(([id, question]) => {
    const ids = Object.keys(question.criteria);
    const choice = id === "tool" ? "edit" : ids.find((option) => option !== "needs_clarification") ?? ids[0]!;
    const rest = 0.3 / (ids.length - 1);
    return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(ids.map((option) => [option, option === choice ? 0.7 : rest])) }];
  }));
  return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
}

const unavailable = () => new Response("busy", { status: 503 });

async function session(options: { tools?: string; responder?: (request: JevRequest) => Response; env?: Record<string, string>; mode?: "on" | "shadow" } = {}) {
  const h = await harness();
  const ws = join(h.dir, "ws");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "app.js"), "export const answer = 41;\n");
  await writeFile(h.configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: options.tools ?? "off" } }));
  const jev = fakeFetch(options.responder ?? chooseEdit);
  const fake = fakePi({ tools: [...TOOLS, ...EXTRA], active: NATIVE, cwd: ws });
  load(fake, h.deps({ fetch: jev.fetch, env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL, ...options.env } }));
  await fake.emit("session_start", { reason: "startup" });
  if ((options.mode ?? "on") === "on") await fake.command("mode on");
  const runsDir = join(h.dir, ".pi", "agent", "pi-jev-harness", "runs");
  return {
    h, fake, jev, ws,
    async products() {
      const names = await readdir(runsDir).catch(() => [] as string[]);
      return Promise.all(names.sort().map(async (name) => ({
        run: JSON.parse(await readFile(join(runsDir, name, "run.json"), "utf8")) as Record<string, any>,
        summary: await readFile(join(runsDir, name, "summary.md"), "utf8"),
      })));
    },
  };
}

const statusLine = async (fake: FakePi, prefix: string) =>
  (await fake.command("status")).split("\n").find((line) => line.startsWith(prefix));

const setSignal = (fake: FakePi, signal: AbortSignal | undefined) => void ((fake.ctx as { signal?: AbortSignal }).signal = signal);

// ---- E2 ----

test("E2: applied tool routing keeps bash resident with read/grep/find/ls; routed tools on top", async () => {
  const s = await session({ tools: "on" });
  try {
    await s.fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(s.fake.setActiveToolsArgs, [["read", "bash", "edit", "grep", "find", "ls"]], "only write is removed");
    assert.ok(s.fake.active().includes("bash"), "the check/exec tool stays exposed");
    assert.equal(await statusLine(s.fake, "工具路由："), "工具路由：已应用（6 个工具，1 个前置；常驻：read,grep,find,ls,bash）");
    await s.fake.emit("agent_settled", {});
    assert.deepEqual(s.fake.active(), NATIVE);
    const [product] = await s.products();
    assert.deepEqual(product!.run.routing.tools, {
      outcome: "applied", tools: ["read", "bash", "edit", "grep", "find", "ls"], resident: ["read", "grep", "find", "ls", "bash"],
    });
  } finally { await s.h.cleanup(); }
});

// ---- E3 ----

async function abortCase(prepare: (s: Awaited<ReturnType<typeof session>>) => Promise<void>) {
  const s = await session();
  try {
    await s.fake.emit("before_agent_start", { prompt: TASK });
    await prepare(s);
    await s.fake.emit("agent_settled", {});
    const [product] = await s.products();
    return product!.run;
  } finally {
    setSignal(s.fake, undefined);
    await s.h.cleanup();
  }
}

test("E3: a user abort is cancelled with 用户取消 at every timing", async () => {
  const cases: Record<string, (s: Awaited<ReturnType<typeof session>>) => Promise<void>> = {
    // Model request in flight: Pi reports stopReason aborted.
    "request in flight": async (s) => {
      await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted", ...MESSAGE_BASE } });
    },
    // During tool execution: the tool/stream rejects, Pi reports stopReason error while its run signal is aborted; no before_settle.
    "tool execution (signal)": async (s) => {
      await s.fake.emit("tool_call", { toolName: "bash", toolCallId: "b1", input: { command: "sleep 5" } });
      setSignal(s.fake, AbortSignal.abort());
      await s.fake.emit("tool_result", { toolCallId: "b1", toolName: "bash", input: {}, content: [{ type: "text", text: "Command aborted" }], isError: true, details: undefined });
      await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", ...MESSAGE_BASE } });
      setSignal(s.fake, undefined); // Pi clears the run signal before before_settle
      await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "error", context: { pendingMessages: [] } });
    },
    // Same, but no signal was observable: the AbortError text is the last resort.
    "tool execution (text)": async (s) => {
      await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", ...MESSAGE_BASE } });
      await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "error", context: { pendingMessages: [] } });
    },
    // At the settle boundary.
    "before settle": async (s) => {
      await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "aborted", context: { pendingMessages: [] } });
    },
  };
  for (const [name, prepare] of Object.entries(cases)) {
    const run = await abortCase(prepare);
    assert.equal(run.status, "cancelled", name);
    assert.ok((run.reasons as string[]).some((r) => r.startsWith("用户取消")), `${name}: ${(run.reasons as string[]).join(" | ")}`);
  }
});

test("E3: a provider error without any abort stays failed", async () => {
  const run = await abortCase(async (s) => {
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", ...MESSAGE_BASE } });
    await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "error", context: { pendingMessages: [] } });
  });
  assert.equal(run.status, "failed");
});

// ---- E7 ----

test("E7: a routing fallback is in run.json and summary.md; telemetry runId equals run.json runId", async () => {
  const s = await session({ tools: "on", responder: unavailable, env: { PI_JEV_RUN_ID: RUN_ID } });
  try {
    await s.fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(s.fake.setActiveToolsArgs, [], "native tools kept");
    await s.fake.emit("agent_settled", {});
    await s.fake.emit("session_shutdown", { reason: "quit" });
    const [product] = await s.products();
    assert.equal(product!.run.runId, RUN_ID);
    assert.equal(product!.run.routing.tools.outcome, "fallback");
    assert.match(product!.run.routing.tools.reason, /路由不可用/);
    assert.equal("model" in product!.run.routing, false, "T051: no model part");
    assert.match(product!.summary, /^路由：工具 已回退（路由不可用：[^）]*）$/m);
    const events = await s.h.events();
    assert.ok(events.length > 0);
    assert.deepEqual([...new Set(events.map((e) => e.runId))], [RUN_ID], "every telemetry event carries the run.json runId");
  } finally { await s.h.cleanup(); }
});

test("E7: without PI_JEV_RUN_ID, task telemetry uses the generated run.json runId; shadow routing is observed", async () => {
  const s = await session({ tools: "shadow", mode: "shadow" });
  try {
    await s.fake.emit("before_agent_start", { prompt: TASK });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.fake.emit("agent_settled", {});
    await s.fake.emit("session_shutdown", { reason: "quit" });
    const [product] = await s.products();
    assert.deepEqual(product!.run.routing.tools, { outcome: "observed", tools: ["read", "edit"] });
    const routeEvents = (await s.h.events()).filter((e) => e.kind === "route_tools");
    assert.ok(routeEvents.length > 0);
    for (const event of routeEvents) assert.equal(event.runId, product!.run.runId);
  } finally { await s.h.cleanup(); }
});
