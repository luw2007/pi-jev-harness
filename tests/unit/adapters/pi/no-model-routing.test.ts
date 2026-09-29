/**
 * model routing is magpie's. The Pi adapter never asks Jev a model question, never observes
 * or suggests a model, never sets the model or thinking level, and ignores a legacy
 * `router.models` config subtree with one note. Tool routing is unchanged. Fake host only.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { MODEL_ROUTING_IGNORED_NOTE } from "../../../../src/adapters/pi/config.ts";
import { MODEL_ROUTING_LINE } from "../../../../src/adapters/pi/host.ts";
import { fakeFetch, fakePi, harness, load, MODELS, settled, validAnswer, type FakePi } from "./fake-host.ts";

const TASK = "Fix the off-by-one in src/app.ts";
const LEGACY_MODELS = { mode: "on", allow: ["prov/alpha", "prov/beta"], providerPriority: ["prov"] };
const SETTLE = { entries: [], continue: false, outcome: "completed", context: { pendingMessages: [] } };

const lines = async (fake: FakePi) => (await fake.command("status")).split("\n");

async function start(config: Record<string, unknown>, mode: "off" | "shadow" | "on") {
  const h = await harness();
  await writeFile(h.configPath, JSON.stringify(config));
  const jev = fakeFetch(validAnswer);
  const fake = fakePi();
  const registry = load(fake, h.deps({ fetch: jev.fetch }));
  await fake.emit("session_start", { reason: "startup" });
  if (mode !== "shadow") await fake.command(`mode ${mode}`);
  return { h, jev, fake, settle: () => settled(registry) };
}

test("a legacy router.models subtree keeps the file valid, is ignored, and is noted once in status", async () => {
  const s = await start({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow", models: LEGACY_MODELS } }, "shadow");
  try {
    const status = await lines(s.fake);
    assert.ok(status.includes("Jev: shadow (this session)"), status.join(" | "));
    assert.equal(status.filter((line) => line === MODEL_ROUTING_IGNORED_NOTE).length, 1);
    assert.ok(status.includes("工具路由：仅观察"), "router.tools still applies");
    await s.fake.emit("session_shutdown", { reason: "quit" });
  } finally { await s.h.cleanup(); }
  const clean = await start({ mode: "shadow", router: { tools: "off" } }, "shadow");
  try {
    assert.ok(!(await lines(clean.fake)).includes(MODEL_ROUTING_IGNORED_NOTE));
    await clean.fake.emit("session_shutdown", { reason: "quit" });
  } finally { await clean.h.cleanup(); }
});

test("status shows the magpie model line in off, shadow and on; the tool routing line stays", async () => {
  for (const mode of ["off", "shadow", "on"] as const) {
    const s = await start({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "on", models: LEGACY_MODELS } }, mode);
    try {
      const status = await lines(s.fake);
      assert.deepEqual(status.filter((line) => line.startsWith("模型路由：")), [MODEL_ROUTING_LINE], mode);
      assert.equal(status.filter((line) => line.startsWith("工具路由：")).length, 1, mode);
      await s.fake.emit("session_shutdown", { reason: "quit" });
    } finally { await s.h.cleanup(); }
  }
});

test("no model question, no model setter and no route_model event in shadow or on, even after a user model_select", async () => {
  for (const mode of ["shadow", "on"] as const) {
    const s = await start({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow", models: LEGACY_MODELS } }, mode);
    try {
      assert.equal(s.fake.listeners.has("model_select"), false, "no model observation");
      await s.fake.emit("model_select", { source: "set", previousModel: MODELS[0], model: MODELS[1] });
      await s.fake.emit("before_agent_start", { prompt: TASK });
      await s.settle();
      assert.deepEqual(s.jev.questionIds(), ["tool"], `${mode}: tool routing only`);
      await s.fake.emit("agent_before_settle", SETTLE);
      await s.fake.emit("agent_settled", {});
      await s.fake.emit("session_shutdown", { reason: "quit" });
      assert.ok(!s.jev.questionIds().includes("model"), mode);
      assert.ok(s.jev.requests.every((request) => !JSON.stringify(request.body).includes("prov/beta")), `${mode}: no model candidate leaves the machine`);
      assert.deepEqual(s.fake.setterCalls.filter((call) => call !== "setActiveTools"), [], mode);
      const events = await s.h.events();
      assert.ok(events.every((event) => event.kind !== "route_model" && !String(event.source ?? "").startsWith("model:")), mode);
      assert.ok(events.some((event) => event.kind === "route_tools"), `${mode}: tool routing still recorded`);
    } finally { await s.h.cleanup(); }
  }
});

test("jev_route returns only the tool decision; run.json routing has only the tools part", async () => {
  const s = await start({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "shadow", models: LEGACY_MODELS } }, "shadow");
  try {
    await s.fake.emit("before_agent_start", { prompt: TASK });
    const body = (await s.fake.runTool("jev_route", { intent: TASK })).details as Record<string, unknown>;
    assert.equal(body.reused, true);
    assert.ok(body.tools, "tool decision present");
    assert.equal("model" in body, false);
    assert.equal("modelRouting" in body, false);
    await s.fake.emit("agent_before_settle", SETTLE);
    await s.fake.emit("agent_settled", {});
    await s.fake.emit("session_shutdown", { reason: "quit" });
    const runsDir = join(s.h.dir, ".pi", "agent", "pi-jev-harness", "runs");
    const [name] = await readdir(runsDir);
    const run = JSON.parse(await readFile(join(runsDir, name!, "run.json"), "utf8")) as { routing: Record<string, unknown> };
    assert.deepEqual(Object.keys(run.routing), ["tools"]);
    assert.doesNotMatch(await readFile(join(runsDir, name!, "summary.md"), "utf8"), /模型/);
  } finally { await s.h.cleanup(); }
});
