import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PiModel } from "../../../../src/adapters/pi/tools.ts";
import { fakeFetch, fakePi, hang, harness, KEY, load, sourceInfo, TOOLS, validAnswer, settled, type FakePi, type JevRequest } from "./fake-host.ts";

const SHADOW_CONFIG = { mode: "shadow", outbound: { taskIntent: true } };
const SHADOW = JSON.stringify(SHADOW_CONFIG);
const TASK = "Please explain what src/app.ts does";

async function shadowRun(options: {
  config?: string;
  responder?: Parameters<typeof fakeFetch>[0];
  models?: PiModel[];
  tools?: ToolInfo[];
  active?: string[];
  prompt?: string;
  env?: Record<string, string>;
  contextTokens?: number | null;
} = {}) {
  const h = await harness();
  await writeFile(h.configPath, options.config ?? SHADOW);
  const jev = fakeFetch(options.responder);
  const fake = fakePi({ models: options.models, tools: options.tools, active: options.active, contextTokens: options.contextTokens });
  const registry = load(fake, h.deps({ fetch: jev.fetch, ...(options.env ? { env: options.env } : {}) }));
  await fake.emit("session_start", { reason: "startup" });
  const results = fake.emitSync("before_agent_start", { prompt: options.prompt ?? TASK });
  return { h, jev, fake, results, settle: () => settled(registry) };
}

async function finish(fake: FakePi) {
  await fake.emit("session_shutdown", { reason: "quit" });
}

test("off mode sends zero Jev requests", async () => {
  const h = await harness();
  try {
    const jev = fakeFetch();
    const fake = fakePi();
    load(fake, h.deps({ fetch: jev.fetch }));
    await fake.emit("session_start", { reason: "startup" });
    const results = fake.emitSync("before_agent_start", { prompt: TASK });
    await finish(fake);
    assert.deepEqual(results, [undefined]);
    assert.equal(jev.requests.length, 0);
    assert.match(await fake.command("status"), /Jev: off[\s\S]*Jev requests this session: 0/);
    assert.equal(await h.telemetryText(), "");
  } finally { await h.cleanup(); }
});

test("switching to off at runtime stops new Jev requests", async () => {
  const { h, jev, fake } = await shadowRun();
  try {
    await finish(fake);
    const sent = jev.requests.length;
    assert.ok(sent > 0);
    const fake2 = fakePi();
    await writeFile(h.configPath, SHADOW);
    load(fake2, h.deps({ fetch: jev.fetch }));
    await fake2.emit("session_start", { reason: "startup" });
    assert.match(await fake2.command("mode off"), /Jev: off/);
    fake2.emitSync("before_agent_start", { prompt: TASK });
    await finish(fake2);
    assert.equal(jev.requests.length, sent);
  } finally { await h.cleanup(); }
});

test("shadow records routes without calling setActiveTools, setModel or setThinkingLevel", async () => {
  const { h, jev, fake, results, settle } = await shadowRun();
  try {
    assert.deepEqual(results, [undefined], "handler returns nothing that changes the run");
    await settle();
    await finish(fake);
    assert.deepEqual(fake.setterCalls, []);
    assert.deepEqual(jev.questionIds(), ["tool"], "T051: never a model question");
    const kinds = (await h.events()).map((event) => `${event.kind}:${event.outcome}`).sort();
    assert.deepEqual(kinds, ["jev_attempt:ok", "route_tools:ok"]);
    assert.match(await fake.command("status"), /Jev requests this session: 1/);
  } finally { await h.cleanup(); }
});

test("shadow handler returns before Jev answers", async () => {
  const { h, jev, fake, results } = await shadowRun({ responder: hang });
  try {
    assert.deepEqual(results, [undefined]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(jev.requests.length > 0, "request is in flight while the handler already returned");
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("Jev payload holds only intent and tool names/descriptions", async () => {
  const long = "x".repeat(20_000);
  const h = await harness();
  try {
    await writeFile(h.configPath, SHADOW);
    const jev = fakeFetch();
    const fake = fakePi();
    load(fake, h.deps({ fetch: jev.fetch }));
    await fake.emit("session_start", { reason: "startup" });
    fake.emitSync("before_agent_start", { prompt: long, systemPrompt: "SYSTEM-PROMPT-TEXT" });
    await finish(fake);
    for (const request of jev.requests) {
      assert.equal((request.body.state.task as string).length, 16_000);
      const text = JSON.stringify(request.body);
      assert.ok(!text.includes("SYSTEM-PROMPT-TEXT"));
      assert.ok(!text.includes('"properties"'), "tool schemas are not sent");
    }
    const tool = jev.requests.find((request) => request.body.questions.tool)!;
    assert.deepEqual(Object.keys(tool.body.questions.tool!.criteria), ["read", "bash", "edit", "needs_clarification"]);
    assert.ok(!jev.requests.some((request) => request.body.questions.model), "T051: no model question");
  } finally { await h.cleanup(); }
});

test("repeated load in one process registers once and records one diagnostic", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, SHADOW);
    const registry = {};
    const first = fakePi();
    const second = fakePi();
    load(first, h.deps({ fetch: fakeFetch().fetch }), registry);
    load(second, h.deps({ fetch: fakeFetch().fetch }), registry);
    assert.equal(first.commands.size, 1);
    assert.equal(first.listeners.get("before_agent_start")?.length, 1);
    assert.equal(second.commands.size, 0);
    assert.equal(second.listeners.size, 0);
    assert.deepEqual([...first.tools.keys()].sort(), ["foreman_assess", "jev_acceptance_gate", "jev_route"]);
    assert.equal(second.tools.size, 0);
    await first.emit("session_start", { reason: "startup" });
    assert.match(await first.command("status"), /duplicate loads ignored: 1/);
    await finish(first);
    const events = await h.events();
    const diagnostics = events.filter((event) => event.source === "adapter:duplicate_load");
    assert.deepEqual(diagnostics.map(({ kind, outcome }) => ({ kind, outcome })), [{ kind: "diagnostic", outcome: "skipped" }]);
    assert.ok(events.every((event) => !event.kind.startsWith("route_")), "a duplicate load is not a routing decision");
    // After shutdown the claim is released: a reloaded runtime registers again.
    const reloaded = fakePi();
    load(reloaded, h.deps({ fetch: fakeFetch().fetch }), registry);
    assert.equal(reloaded.commands.size, 1);
  } finally { await h.cleanup(); }
});

test("damaged config forces off, explains in status and is not overwritten", async () => {
  const h = await harness();
  try {
    const damaged = '{"mode": "shadow", ';
    await writeFile(h.configPath, damaged);
    const jev = fakeFetch();
    const fake = fakePi();
    load(fake, h.deps({ fetch: jev.fetch }));
    await fake.emit("session_start", { reason: "startup" });
    fake.emitSync("before_agent_start", { prompt: TASK });
    const status = await fake.command("status");
    assert.match(status, /Jev: off/);
    assert.match(status, /config: invalid \(config file is not valid JSON\)/);
    assert.match(await fake.command("mode shadow"), /staying off/);
    await finish(fake);
    assert.equal(jev.requests.length, 0);
    assert.equal(await readFile(h.configPath, "utf8"), damaged);
  } finally { await h.cleanup(); }
});

test("missing config file means off with defaults", async () => {
  const h = await harness();
  try {
    const fake = fakePi();
    load(fake, h.deps({ fetch: fakeFetch().fetch }));
    await fake.emit("session_start", { reason: "startup" });
    assert.match(await fake.command("status"), /Jev: off[\s\S]*config: defaults/);
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("/jev mode on reports the effective capabilities; mode on, shadow and off apply to this session only", async () => {
  const h = await harness();
  try {
    const fake = fakePi();
    load(fake, h.deps({ fetch: fakeFetch().fetch }));
    await fake.emit("session_start", { reason: "startup" });
    assert.match(await fake.command("status"), /Jev: off/);
    const on = await fake.command("mode on");
    assert.match(on, /Jev: on \(this session\); 实际生效：工具路由：仅观察；模型路由：由 magpie 负责（harness 不处理）；上下文裁剪（请求级）：关闭；摘要替换：关闭（原生路径）；强制评审：无；完成验收：不可用（outbound\.taskIntent=false，不发请求）；续跑：仅观察/);
    assert.match(await fake.command("status"), /Jev: on[\s\S]*工具路由：仅观察\n模型路由：由 magpie 负责（harness 不处理）\n上下文裁剪（请求级）：关闭\n摘要替换：关闭（原生路径）/);
    assert.match(await fake.command("mode shadow"), /Jev: shadow \(this session\)/);
    assert.match(await fake.command("status"), /工具路由：仅观察/);
    assert.equal(await readFile(h.configPath, "utf8").catch(() => "absent"), "absent", "mode change is not persisted");
    await finish(fake);
  } finally { await h.cleanup(); }
});

test("unknown tools in the snapshot never enter the catalog", async () => {
  const tools: ToolInfo[] = [...TOOLS, { name: "Bad-Name!", description: "invalid id", parameters: {}, sourceInfo: sourceInfo("ext") }];
  const { h, jev, fake } = await shadowRun({ tools, active: ["read", "bash", "edit", "ghost_tool", "Bad-Name!"] });
  try {
    await finish(fake);
    const tool = jev.requests.find((request) => request.body.questions.tool)!;
    assert.deepEqual(Object.keys(tool.body.questions.tool!.criteria), ["read", "bash", "edit", "needs_clarification"]);
    assert.deepEqual(fake.setterCalls, []);
  } finally { await h.cleanup(); }
});

test("session shutdown cancels in-flight Jev requests", async () => {
  const { h, jev, fake } = await shadowRun({ responder: hang });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(jev.requests.length > 0);
    await finish(fake);
    assert.ok(jev.requests.every((request) => request.signal?.aborted));
    const outcomes = (await h.events()).filter((event) => event.kind.startsWith("route_")).map((event) => event.outcome);
    assert.deepEqual(outcomes, ["unavailable"]);
    await finish(fake); // idempotent
  } finally { await h.cleanup(); }
});

test("Jev timeout is recorded as unavailable and leaves the host untouched", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { h, fake, results } = await shadowRun({ config: JSON.stringify({ ...SHADOW_CONFIG, budget: { waitMs: 30 } }), responder: hang });
  try {
    assert.deepEqual(results, [undefined]);
    mock.timers.tick(30);
    mock.timers.reset();
    await fake.emit("session_shutdown", { reason: "quit" }); // waits for the routes the budget already aborted
    const routes = (await h.events()).filter((event) => event.kind.startsWith("route_"));
    assert.deepEqual(routes.map((event) => event.outcome), ["unavailable"]);
    assert.match(await fake.command("status"), /fallback reasons: .*wait_budget/);
    assert.deepEqual(fake.setterCalls, []);
  } finally { mock.timers.reset(); await h.cleanup(); }
});

test("malformed Jev answers are recorded as unavailable and leave the host untouched", async () => {
  const malformed = (request: JevRequest) => {
    const response = validAnswer(request);
    return response.json().then((body: { answers: Record<string, { probabilities: Record<string, number> }> }) => {
      for (const answer of Object.values(body.answers)) for (const id of Object.keys(answer.probabilities)) answer.probabilities[id] = 0.9;
      return new Response(JSON.stringify(body), { status: 200 });
    });
  };
  const { h, fake, results, settle } = await shadowRun({ responder: malformed });
  try {
    assert.deepEqual(results, [undefined]);
    await settle();
    await finish(fake);
    const events = await h.events();
    assert.deepEqual(events.filter((event) => event.kind === "jev_attempt").map((event) => event.source), ["jev:malformed"]);
    assert.deepEqual(events.filter((event) => event.kind.startsWith("route_")).map((event) => event.outcome), ["unavailable"]);
    assert.deepEqual(fake.setterCalls, []);
  } finally { await h.cleanup(); }
});

test("the Jev key never reaches telemetry or status", async () => {
  const { h, jev, fake } = await shadowRun();
  try {
    await finish(fake);
    assert.ok(jev.requests.length > 0);
    const text = await h.telemetryText();
    assert.ok(text.length > 0);
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(TASK), "task text stays out of telemetry");
    assert.ok(!(await fake.command("status")).includes(KEY));
  } finally { await h.cleanup(); }
});

test("default outbound scope sends zero Jev requests and records withheld", async () => {
  const { h, jev, fake } = await shadowRun({ config: JSON.stringify({ mode: "shadow" }) });
  try {
    const status = await fake.command("status");
    await finish(fake);
    assert.equal(jev.requests.length, 0);
    assert.match(status, /任务意图出站未开启/);
    assert.match(status, /Jev requests this session: 0/);
    const routes = (await h.events()).map((event) => `${event.kind}:${event.outcome}:${event.source}`).sort();
    assert.deepEqual(routes, ["route_tools:withheld:outbound:not_authorized"]);
  } finally { await h.cleanup(); }
});

test("prompt containing an sk- key sends zero Jev requests", async () => {
  const secret = ["sk", "proj", "AbCdEf0123456789"].join("-");
  const { h, jev, fake } = await shadowRun({ prompt: `Use ${secret} to call the API` });
  try {
    await finish(fake);
    assert.equal(jev.requests.length, 0);
    const text = await h.telemetryText();
    assert.ok(!text.includes(secret));
    const routes = (await h.events()).map((event) => `${event.kind}:${event.outcome}:${event.source}`).sort();
    assert.deepEqual(routes, ["route_tools:withheld:outbound:credential_detected"]);
    assert.ok(!(await fake.command("status")).includes(secret));
  } finally { await h.cleanup(); }
});

test("every credential category withholds the request; plain prompts still go out", async () => {
  const plainKey = "tsafe0live0key0value0x9";
  const env = { TYPESAFE_API_KEY: plainKey, PI_JEV_URL: "http://jev.test/v1/systemone" };
  // Assembled at runtime so no credential-shaped literal sits in the source.
  const prompts = {
    github: `clone with ${"ghp"}_${"abcdefghijklmnop1234"}`,
    slack: `post via ${"xox"}b-${"1234567890-abcdefgh"}`,
    aws: `the id is ${"AKIA"}${"ABCDEFGHIJKLMNOP"} ok`,
    pem: `${"-----BEGIN"} RSA ${"PRIVATE KEY-----"}\nMIIEabc`,
    password: `login with ${"password"}=hunter2`,
    token: `set ${"token"} = abc123 in the env`,
    jevKey: `the key is ${plainKey}`,
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    const { h, jev, fake } = await shadowRun({ prompt, env });
    try {
      await finish(fake);
      assert.equal(jev.requests.length, 0, `${name} leaked a request`);
      const events = await h.events();
      assert.equal(events.length, 1, name);
      assert.ok(events.every((event) => event.source === "outbound:credential_detected"), name);
      assert.ok(!(await h.telemetryText()).includes(prompt), name);
    } finally { await h.cleanup(); }
  }
  const { h, jev, fake } = await shadowRun({ prompt: "Explain the password reset flow and the token bucket in src/rate.ts", env });
  try {
    await finish(fake);
    assert.ok(jev.requests.length > 0, "a prompt that only mentions credentials is not a credential");
  } finally { await h.cleanup(); }
});
