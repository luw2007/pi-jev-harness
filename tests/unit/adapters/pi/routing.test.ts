/**
 * T037: tool routing applied in mode `on`, `jev_route`, router feature modes and their status lines.
 * Fake host only: `setActiveTools` follows Pi (registered names only) unless a test overrides it.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { loadConfig, MODEL_ROUTING_IGNORED_NOTE } from "../../../../src/adapters/pi/config.ts";
import { MODEL_ROUTING_LINE as MODEL_LINE } from "../../../../src/adapters/pi/host.ts";
import type { PiModel } from "../../../../src/adapters/pi/tools.ts";
import { fakeFetch, fakePi, harness, load, settled, sourceInfo, TOOLS, type FakePi, type JevRequest } from "./fake-host.ts";

const TASK = "Fix the off-by-one in src/app.ts";
const EXTRA: ToolInfo[] = ["grep", "write", "web"].map((name) => ({
  name, description: `The ${name} tool`, parameters: { type: "object", properties: { q: { type: "string" } } }, sourceInfo: sourceInfo(name === "web" ? "ext" : "builtin"),
}));
const ROUTING_TOOLS: ToolInfo[] = [...TOOLS, ...EXTRA];
/** `web` is registered but disabled. */
const NATIVE = ["read", "bash", "edit", "grep", "write"];

function config(tools: unknown, extra: Record<string, unknown> = {}) {
  return { mode: "shadow", outbound: { taskIntent: true }, router: { tools }, ...extra };
}

/** Answers every question; the tool question picks `toolId`. */
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

async function session(options: {
  config: Record<string, unknown>;
  mode?: "on" | "shadow";
  responder?: Parameters<typeof fakeFetch>[0];
  onSetActiveTools?: (names: string[], call: number) => string[];
  env?: Record<string, string>;
  models?: PiModel[];
}) {
  const h = await harness();
  await writeFile(h.configPath, JSON.stringify(options.config));
  const jev = fakeFetch(options.responder ?? choose("edit"));
  const fake = fakePi({ tools: ROUTING_TOOLS, active: NATIVE, onSetActiveTools: options.onSetActiveTools, models: options.models });
  const registry = load(fake, h.deps({ fetch: jev.fetch, ...(options.env ? { env: options.env } : {}) }));
  await fake.emit("session_start", { reason: "startup" });
  if ((options.mode ?? "on") === "on") await fake.command("mode on");
  return { h, jev, fake, settle: () => settled(registry) };
}

const statusLine = async (fake: FakePi, prefix: string) =>
  (await fake.command("status")).split("\n").find((line) => line.startsWith(prefix));

async function toolEvents(h: Awaited<ReturnType<typeof harness>>) {
  return (await h.events()).filter((event) => event.kind === "route_tools").map((event) => `${event.outcome}:${event.source}`);
}

async function finish(fake: FakePi) {
  await fake.emit("session_shutdown", { reason: "quit" });
}

test("on + router.tools on applies the routed bundle before the run, verifies it and gives it back at task end", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    const results = await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(results, [undefined], "no prompt or message change");
    // Root edit + prerequisite read + resident read/search and exec tools, in host order; only write removed (T045 E2: bash stays).
    assert.deepEqual(fake.setActiveToolsArgs, [["read", "bash", "edit", "grep"]]);
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "grep"]);
    assert.equal(jev.requests.length, 1, "only the tool question");
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：已应用（4 个工具，1 个前置；常驻：read,grep,bash）");
    await fake.emit("agent_settled", {});
    assert.deepEqual(fake.active(), NATIVE, "owned removals given back in the original order");
    assert.equal(fake.setActiveToolsArgs.length, 2);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：已应用（4 个工具，1 个前置；常驻：read,grep,bash；任务结束已恢复）");
    await finish(fake);
    assert.deepEqual(await toolEvents(h), ["ok:tools:selected", "ok:tools:applied", "ok:tools:restored"]);
    assert.deepEqual(fake.setterCalls.filter((call) => call !== "setActiveTools"), [], "model and thinking are never set");
  } finally { await h.cleanup(); }
});

test("a shadow session never applies tools, even with router.tools on", async () => {
  const { h, jev, fake, settle } = await session({ config: config("on"), mode: "shadow" });
  try {
    assert.deepEqual(fake.emitSync("before_agent_start", { prompt: TASK }), [undefined], "shadow returns without waiting");
    await settle();
    await fake.emit("agent_settled", {});
    assert.equal(jev.requests.length, 1);
    assert.deepEqual(fake.setterCalls, []);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：仅观察");
    await finish(fake);
    assert.deepEqual(await toolEvents(h), ["ok:tools:selected"]);
  } finally { await h.cleanup(); }
});

test("session on with router.tools shadow never applies tools", async () => {
  const { h, jev, fake, settle } = await session({ config: config("shadow") });
  try {
    assert.deepEqual(fake.emitSync("before_agent_start", { prompt: TASK }), [undefined]);
    await settle();
    await fake.emit("agent_settled", {});
    assert.equal(jev.requests.length, 1);
    assert.deepEqual(fake.setterCalls, []);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：仅观察");
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("a read-back mismatch records a fallback and restores the pre-apply tool set", async () => {
  // The host drops grep on the first call only (e.g. it did not take the set as asked).
  const onSetActiveTools = (names: string[], call: number) => (call === 1 ? names.filter((name) => name !== "grep") : names);
  const { h, fake } = await session({ config: config("on"), onSetActiveTools });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(fake.setActiveToolsArgs, [["read", "bash", "edit", "grep"], NATIVE]);
    assert.deepEqual(fake.active(), NATIVE);
    const status = await fake.command("status");
    assert.ok(status.split("\n").includes("工具路由：已回退（生效校验不一致，已恢复）"), status);
    assert.match(status, /fallback reasons: .*tools: apply read-back mismatch; restored/);
    await fake.emit("agent_settled", {});
    assert.equal(fake.setActiveToolsArgs.length, 2, "nothing owned: task end changes nothing");
    await finish(fake);
    assert.deepEqual(await toolEvents(h), ["ok:tools:selected", "fallback:tools:apply_mismatch"]);
  } finally { await h.cleanup(); }
});

test("an external mid-task change is kept; task end gives back only the tools we removed", async () => {
  const { h, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "grep"]);
    // The user or another extension enables web and disables grep mid-task.
    fake.setActive(["read", "bash", "edit", "web"]);
    await fake.emit("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "README.md" } });
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：外部改动已保留");
    assert.equal(fake.setActiveToolsArgs.length, 1, "the external change is not overwritten mid-task");
    await fake.emit("agent_settled", {});
    // write (ours) comes back; grep stays disabled and web stays enabled (not ours).
    assert.deepEqual(fake.active(), ["read", "bash", "edit", "write", "web"]);
    await finish(fake);
    assert.deepEqual(await toolEvents(h), ["ok:tools:selected", "ok:tools:applied", "skipped:tools:external_change_kept", "ok:tools:restored"]);
  } finally { await h.cleanup(); }
});

test("a new task first gives back the previous task's removals, so it routes from the native set", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    await fake.emit("before_agent_start", { prompt: "Now add a test for it" }); // no agent_settled in between
    assert.deepEqual(fake.setActiveToolsArgs, [["read", "bash", "edit", "grep"], NATIVE, ["read", "bash", "edit", "grep"]]);
    const second = jev.requests[1]!;
    assert.deepEqual(Object.keys(second.body.questions.tool!.criteria), [...NATIVE, "needs_clarification"], "catalog is the native set");
    await finish(fake);
    assert.deepEqual(fake.active(), NATIVE, "shutdown gives back owned removals");
  } finally { await h.cleanup(); }
});

test("routing without a bundle keeps the native tools and records the fallback reason", async () => {
  const cases = [
    { name: "Jev HTTP error", responder: () => new Response("down", { status: 500 }), line: /^工具路由：已回退（路由不可用：/ },
    { name: "no Jev key", env: { PI_JEV_URL: "http://jev.test/v1/systemone" }, line: /^工具路由：已回退（路由不可用：no_key）$/ },
    { name: "needs clarification", responder: choose("needs_clarification"), line: /^工具路由：已回退（需要澄清，未选工具）$/ },
    { name: "outbound not allowed", config: { ...config("on"), outbound: { taskIntent: false } }, line: /^工具路由：已回退（任务意图出站未开启）$/ },
  ];
  for (const item of cases) {
    const { h, fake } = await session({ config: item.config ?? config("on"), responder: item.responder, env: item.env });
    try {
      await fake.emit("before_agent_start", { prompt: TASK });
      assert.deepEqual(fake.setterCalls, [], item.name);
      assert.deepEqual(fake.active(), NATIVE, item.name);
      assert.match((await statusLine(fake, "工具路由："))!, item.line, item.name);
      await finish(fake);
      assert.ok((await toolEvents(h)).includes("fallback:tools:native_kept"), item.name);
    } finally { await h.cleanup(); }
  }
});

test("jev_route reuses the current task's routing (one request) and says nothing was executed", async () => {
  const { h, jev, fake } = await session({ config: config("on") });
  try {
    await fake.emit("before_agent_start", { prompt: TASK });
    const same = (await fake.runTool("jev_route", { intent: TASK })).details as Record<string, any>;
    assert.equal(jev.requests.length, 1, "identical intent: no second request");
    assert.equal(same.executed, false);
    assert.match(same.note, /没有执行任何任务或工具/);
    assert.equal(same.reused, true);
    assert.deepEqual([same.tools.status, same.tools.rootIds, same.tools.prerequisiteIds, same.tools.appliedToHost], ["selected", ["edit"], ["read"], true]);
    assert.equal("model" in same, false, "T051: no model decision in jev_route");
    assert.equal("modelRouting" in same, false);
    // A different intent is a new route against the per-task budget (maxRequestsPerTask = 2).
    const other = (await fake.runTool("jev_route", { intent: "Search the docs for the rate limiter" })).details as Record<string, any>;
    assert.equal(jev.requests.length, 2);
    assert.deepEqual([other.reused, other.tools.status, other.tools.appliedToHost], [false, "selected", false]);
    const spent = (await fake.runTool("jev_route", { intent: "Yet another intent" })).details as Record<string, any>;
    assert.equal(jev.requests.length, 2, "budget spent: no third request");
    assert.equal(spent.tools.status, "unavailable");
    assert.deepEqual(fake.setActiveToolsArgs, [["read", "bash", "edit", "grep"]], "jev_route never changes the tool set");
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("jev_route in mode off sends nothing", async () => {
  const { h, jev, fake } = await session({ config: config("on"), mode: "shadow" });
  try {
    await fake.command("mode off");
    const result = (await fake.runTool("jev_route", { intent: TASK })).details as Record<string, any>;
    assert.deepEqual([result.executed, result.status], [false, "unavailable"]);
    assert.equal(jev.requests.length, 0);
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("legacy boolean router.tools still loads, mapped to modes; per-feature on is allowed, top-level on is not; router.models is ignored with a note", async () => {
  const load = (value: unknown) => loadConfig({ home: "/home/test", readText: async () => JSON.stringify(value), env: {} });
  const defaults = await loadConfig({ home: "/home/test", readText: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } });
  assert.deepEqual(defaults.config.router, { tools: "shadow" });
  const legacyOn = await load({ router: { tools: true } });
  assert.deepEqual([legacyOn.source, legacyOn.config.router.tools, legacyOn.notes], ["file", "shadow", undefined]);
  const legacyOff = await load({ router: { tools: false } });
  assert.deepEqual([legacyOff.source, legacyOff.config.router.tools], ["file", "off"]);
  // T051: any router.models content (even formerly invalid) is ignored, never parsed.
  for (const models of [{ mode: "on", providerPriority: ["p2", "p1"] }, { enabled: true }, { mode: "on", enabled: true }, { providerPriority: ["p/x"] }, "junk"]) {
    const loaded = await load({ router: { tools: "on", models } });
    assert.deepEqual([loaded.source, loaded.config.router, loaded.notes], ["file", { tools: "on" }, [MODEL_ROUTING_IGNORED_NOTE]], JSON.stringify(models));
  }
  for (const bad of [{ mode: "on" }, { router: { tools: "always" } }, { router: { planner: {} } }])
    assert.equal((await load(bad)).source, "invalid", JSON.stringify(bad));
});

test("status shows the tool routing state and the magpie model line; the model is never touched, even with a legacy router.models", async () => {
  const models = { mode: "on", allow: ["prov/alpha", "prov/beta"] };
  const on = await session({ config: config("on", {}) });
  const legacy = await session({ config: { ...config("on"), router: { tools: "on", models } }, mode: "shadow" });
  const off = await session({ config: config("off") });
  try {
    assert.equal(await statusLine(on.fake, "工具路由："), "工具路由：开启（尚无任务）");
    assert.equal(await statusLine(legacy.fake, "工具路由："), "工具路由：仅观察");
    assert.equal(await statusLine(off.fake, "工具路由："), "工具路由：关闭");
    for (const s of [on, legacy, off]) assert.equal(await statusLine(s.fake, "模型路由："), MODEL_LINE);
    assert.ok((await legacy.fake.command("status")).split("\n").includes(MODEL_ROUTING_IGNORED_NOTE));
    for (const s of [on, legacy]) {
      await s.fake.emit("before_agent_start", { prompt: TASK });
      await s.settle();
      assert.ok(!s.jev.questionIds().includes("model"), "T051: never a model question");
      assert.deepEqual(s.fake.setterCalls.filter((call) => call !== "setActiveTools"), [], "model and thinking are never set");
      assert.ok((await s.h.events()).every((event) => event.kind !== "route_model"));
    }
    const notice = await legacy.fake.command("mode on");
    assert.match(notice, /实际生效：工具路由：[^；]+；模型路由：由 magpie 负责（harness 不处理）；/);
    for (const s of [on, legacy, off]) await finish(s.fake);
  } finally { for (const s of [on, legacy, off]) await s.h.cleanup(); }
});

// ---- T044: this extension's own tools stay resident; jev_recall is active only in effective on ----

const JEV_OWN = ["jev_acceptance_gate", "foreman_assess", "jev_route"];
const JEV_INFOS: ToolInfo[] = JEV_OWN.map((name) => ({
  name, description: `The ${name} tool`, parameters: { type: "object", properties: {} }, sourceInfo: sourceInfo("ext"),
}));

test("T044: applying a routed bundle keeps jev_acceptance_gate, foreman_assess and jev_route resident, recorded apart from routed tools", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify(config("on")));
    const jev = fakeFetch(choose("edit"));
    const fake = fakePi({ tools: [...ROUTING_TOOLS, ...JEV_INFOS], active: [...NATIVE, ...JEV_OWN] });
    load(fake, h.deps({ fetch: jev.fetch }));
    await fake.emit("session_start", { reason: "startup" });
    await fake.command("mode on");
    await fake.emit("before_agent_start", { prompt: TASK });
    assert.deepEqual(fake.setActiveToolsArgs, [["read", "bash", "edit", "grep", ...JEV_OWN]]);
    assert.equal(await statusLine(fake, "工具路由："), "工具路由：已应用（4 个工具，1 个前置；常驻：read,grep,bash,jev_*）");
    await fake.emit("agent_settled", {});
    assert.deepEqual(fake.active(), [...NATIVE, ...JEV_OWN], "task end gives back only the routed removals");
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("T044: jev_recall is active only while context reduction is effectively on; shadow takes it back out", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify(config("off", { context: { request: "on", storeDir: join(h.dir, "store") } })));
    const fake = fakePi({ tools: ROUTING_TOOLS, active: NATIVE });
    // Pi 0.87.1 activates a tool registered after load.
    const register = fake.pi.registerTool.bind(fake.pi);
    (fake.pi as { registerTool: typeof register }).registerTool = (tool) => {
      register(tool);
      if (!fake.active().includes(tool.name)) fake.setActive([...fake.active(), tool.name]);
    };
    load(fake, h.deps({ fetch: fakeFetch(choose("edit")).fetch }));
    await fake.emit("session_start", { reason: "startup" });
    assert.deepEqual(fake.active().filter((id) => id === "jev_recall"), [], "shadow session: not active");
    await fake.command("mode on");
    assert.ok(fake.active().includes("jev_recall"), "on + context.request on: active");
    await fake.command("mode shadow");
    assert.ok(!fake.active().includes("jev_recall"), "back to shadow: removed again");
    assert.deepEqual(fake.active(), [...NATIVE, ...JEV_OWN], "no other tool touched");
    await finish(fake);
  } finally { await h.cleanup(); }
});
