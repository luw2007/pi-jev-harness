/**
 * T041 verification of T037: on-mode tool routing, `jev_route`, router feature modes. Real
 * extension entry on the fake Pi host; Jev is a fake fetch. No real Pi, Jev or model.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../../../src/adapters/pi/config.ts";
import { fakeFetch, fakePi, harness, load, settled, sourceInfo, TOOLS, type FakePi, type JevRequest } from "./fake-host.ts";

const TASK = "Fix the off-by-one in src/app.ts";
const EXTRA: ToolInfo[] = ["grep", "write", "web"].map((name) => ({
  name, description: `The ${name} tool`, parameters: { type: "object", properties: { q: { type: "string" } } }, sourceInfo: sourceInfo(name === "web" ? "ext" : "builtin"),
}));
const ROUTING_TOOLS: ToolInfo[] = [...TOOLS, ...EXTRA];
const NATIVE = ["read", "bash", "edit", "grep", "write"];

function config(tools: unknown, extra: Record<string, unknown> = {}) {
  return { mode: "shadow", outbound: { taskIntent: true }, router: { tools }, ...extra };
}

function choose(toolId: string) {
  return (request: JevRequest): Response => {
    const answers = Object.fromEntries(Object.entries(request.body.questions).map(([id, question]) => {
      const ids = Object.keys(question.criteria);
      const choice = id === "tool" ? toolId : ids.find((option) => option !== "needs_clarification") ?? ids[0]!;
      const rest = 0.3 / (ids.length - 1);
      return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(ids.map((option) => [option, option === choice ? 0.7 : rest])) }];
    }));
    return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function session(options: { config: Record<string, unknown>; mode?: "on" | "shadow"; responder?: Parameters<typeof fakeFetch>[0]; onSetActiveTools?: (names: string[], call: number) => string[]; active?: string[] }) {
  const h = await harness();
  await writeFile(h.configPath, JSON.stringify(options.config));
  const jev = fakeFetch(options.responder ?? choose("edit"));
  const fake = fakePi({ tools: ROUTING_TOOLS, active: options.active ?? NATIVE, onSetActiveTools: options.onSetActiveTools });
  const registry = load(fake, h.deps({ fetch: jev.fetch }));
  await fake.emit("session_start", { reason: "startup" });
  if ((options.mode ?? "on") === "on") await fake.command("mode on");
  return { h, jev, fake, settle: () => settled(registry) };
}

const statusLine = async (fake: FakePi, prefix: string) => (await fake.command("status")).split("\n").find((line) => line.startsWith(prefix));
const toolEvents = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.events()).filter((event) => event.kind === "route_tools").map((event) => `${event.outcome}:${event.source}`);
const quit = (fake: FakePi) => fake.emit("session_shutdown", { reason: "quit" });

test("external change mid-task (user re-enables a removed tool, disables a kept one) is kept; task end adds back only still-missing owned removals", async () => {
  const { h, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "grep"]);
    fake.setActive(["read", "bash", "edit", "write"]); // write was ours to remove; the user brings it back and drops grep
    // No tool_call in between: the change is first seen at task end.
    await fake.emit("agent_settled", {});
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "write"], "grep stays off; write (ours, already back) not duplicated");
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：外部改动已保留");
    await quit(fake);
    assert.deepEqual(await toolEvents(h), ["ok:tools:selected", "ok:tools:applied", "skipped:tools:external_change_kept", "ok:tools:restored"]);
  } finally { await h.cleanup(); }
});

test("an external change is never overwritten by later tool calls, jev_route or a second read-back in the same task", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    fake.setActive(["read", "bash", "edit", "grep", "web"]);
    await fake.emit("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "a" } });
    await fake.emit("tool_call", { toolName: "read", toolCallId: "r2", input: { path: "b" } });
    await fake.runTool("jev_route", { intent: TASK });
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "grep", "web"]);
    assert.equal(fake.setActiveToolsArgs.length, 1);
    assert.equal(jev.requests.length, 1);
    await quit(fake);
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "grep", "write", "web"], "shutdown gives back owned removals only");
    assert.equal((await toolEvents(h)).filter((e) => e === "skipped:tools:external_change_kept").length, 1, "recorded once");
  } finally { await h.cleanup(); }
});

test("switching the session to shadow or off mid-task gives back the owned removals at once", async () => {
  for (const next of ["shadow", "off"]) {
    const { h, fake } = await session({ config: config("on") });
    try {
      await fake.emit("before_agent_start", { prompt: TASK });
      assert.deepEqual(fake.active(), ["read", "bash", "edit", "grep"]);
      await fake.command(`mode ${next}`);
      assert.deepEqual(fake.active(), NATIVE, next);
      await fake.emit("agent_settled", {});
      assert.deepEqual(fake.active(), NATIVE, `${next}: nothing more changes at task end`);
      await quit(fake);
    } finally { await h.cleanup(); }
  }
});

test("a routed bundle over maxBundleTools or maxBundleSchemaBytes is withheld: native tools kept, reason shown", async () => {
  for (const tools of [{ maxBundleTools: 1 }, { maxBundleSchemaBytes: 10 }]) {
    const { h, fake } = await session({ config: config("on", { tools }) });
    try {
      await fake.emit("before_agent_start", { prompt: TASK });
      assert.deepEqual(fake.setActiveToolsArgs, [], JSON.stringify(tools));
      assert.deepEqual(fake.active(), NATIVE);
      assert.match((await statusLine(fake, "工具路由："))!, /^工具路由：已回退（工具包超出限制：.+）$/, JSON.stringify(tools));
      await quit(fake);
      assert.deepEqual(await toolEvents(h), ["withheld:tools:withheld", "fallback:tools:native_kept"]);
    } finally { await h.cleanup(); }
  }
});

test("jev_route called twice with the task's own intent costs no extra request; whitespace differences still reuse", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    const first = (await fake.runTool("jev_route", { intent: TASK })).details as Record<string, any>;
    const second = (await fake.runTool("jev_route", { intent: `  ${TASK}\n` })).details as Record<string, any>;
    const third = (await fake.runTool("jev_route", { intent: TASK, candidates: [...NATIVE].reverse() })).details as Record<string, any>;
    assert.equal(jev.requests.length, 1, "only the automatic route");
    for (const body of [first, second, third]) {
      assert.equal(body.reused, true);
      assert.equal(body.executed, false);
      assert.deepEqual(body.tools.rootIds, ["edit"]);
    }
    await quit(fake);
  } finally { await h.cleanup(); }
});

test("jev_route with the task intent but other candidates is a new request within the per-task budget", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    const body = (await fake.runTool("jev_route", { intent: TASK, candidates: ["read", "grep"] })).details as Record<string, any>;
    assert.equal(body.reused, false);
    assert.equal(jev.requests.length, 2);
    assert.deepEqual(Object.keys(jev.requests[1]!.body.questions.tool!.criteria).filter((id) => id !== "needs_clarification").sort(), ["grep", "read"]);
    assert.equal(body.tools.appliedToHost, false);
    await quit(fake);
  } finally { await h.cleanup(); }
});

test("jev_route with a credential-shaped intent sends nothing and says so", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    const body = (await fake.runTool("jev_route", { intent: "deploy with token=abcdefgh12345678" })).details as Record<string, any>;
    assert.equal(jev.requests.length, 1);
    assert.equal(body.tools.status, "outbound:credential_detected");
    assert.equal(body.executed, false);
    await quit(fake);
  } finally { await h.cleanup(); }
});

test("legacy router.tools: true means shadow: a session in on never applies tools from it", async () => {
  const { h, jev, fake, settle } = await session({ config: config(true) });
  try {
    fake.emitSync("before_agent_start", { prompt: TASK });
    await settle();
    await fake.emit("agent_settled", {});
    assert.equal(jev.requests.length, 1, "still observed");
    assert.deepEqual(fake.setterCalls, []);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：仅观察");
    await quit(fake);
  } finally { await h.cleanup(); }
});

test("legacy config edge values: non-boolean tools are invalid; router.models is ignored (T051)", async () => {
  const read = (value: unknown) => loadConfig({ home: "/h", readText: async () => JSON.stringify(value), env: {} });
  assert.equal((await read({ router: { models: { enabled: "true" } } })).source, "file");
  assert.equal((await read({ router: { tools: "true" } })).source, "invalid");
  assert.equal((await read({ router: { tools: 1 } })).source, "invalid");
  assert.equal((await read({ router: { tools: null } })).source, "invalid");
  const mixed = await read({ router: { tools: false, models: { enabled: true, allow: ["p/m"] } } });
  assert.deepEqual(mixed.config.router, { tools: "off" });
});

test("session on with router.tools shadow never applies, not even after jev_route or a mode re-toggle", async () => {
  const { h, fake, settle } = await session({ config: config("shadow") });
  try {
    fake.emitSync("before_agent_start", { prompt: TASK });
    await settle();
    await fake.runTool("jev_route", { intent: TASK });
    await fake.command("mode shadow");
    await fake.command("mode on");
    fake.emitSync("before_agent_start", { prompt: "second task" });
    await settle();
    await fake.emit("agent_settled", {});
    assert.deepEqual(fake.setterCalls, []);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：仅观察");
    await quit(fake);
    assert.ok(!(await toolEvents(h)).some((e) => /applied|restored|native_kept/.test(e)));
  } finally { await h.cleanup(); }
});

test("read-back mismatch where the host also refuses the restore is reported as unconfirmed, never as applied", async () => {
  // The host keeps only read on every call.
  const { h, fake } = await session({ config: config("on"), onSetActiveTools: () => ["read"] });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(fake.setActiveToolsArgs, [["read", "bash", "edit", "grep"], NATIVE]);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：已回退（生效校验不一致，恢复未确认）");
    assert.match(await fake.command("status"), /tools: apply read-back mismatch; restore unverified/);
    await fake.emit("agent_settled", {});
    assert.equal(fake.setActiveToolsArgs.length, 2, "nothing owned, nothing more set");
    await quit(fake);
    assert.deepEqual(await toolEvents(h), ["ok:tools:selected", "fallback:tools:apply_mismatch"]);
  } finally { await h.cleanup(); }
});

test("read-back that silently adds a tool is a mismatch too, and the pre-apply set is restored", async () => {
  const { h, fake } = await session({ config: config("on"), onSetActiveTools: (names, call) => (call === 1 ? [...names, "web"] : names) });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(fake.active(), NATIVE);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：已回退（生效校验不一致，已恢复）");
    await quit(fake);
  } finally { await h.cleanup(); }
});

test("a stale apply (next task already started while the route was in flight) changes nothing", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const { h, fake } = await session({
    config: config("on"),
    responder: async (request) => {
      if (++calls === 1) await gate;
      return choose("edit")(request);
    },
  });
  try {
    const first = fake.emit("before_agent_start", { prompt: TASK });
    const second = fake.emit("before_agent_start", { prompt: "Now just read the README" });
    release();
    await Promise.all([first, second]);
    assert.equal(fake.setActiveToolsArgs.length, 1, "only the current task's bundle is applied");
    await fake.emit("agent_settled", {});
    assert.deepEqual(fake.active(), NATIVE);
    await quit(fake);
  } finally { await h.cleanup(); }
});
