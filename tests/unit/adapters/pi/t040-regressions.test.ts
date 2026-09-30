/**
 * T040 host verification: regressions for defects confirmed on the real Pi 0.87.1 host.
 * These tests fail on de06f3a and describe the expected behavior.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { JEV_URL, KEY, fakeFetch, fakePi, harness, load, validAnswer } from "./fake-host.ts";

const MESSAGE_BASE = { provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };

// Real host (T040 §3.8): with mode shadow and context.request shadow, `pi -p` sent
// tools [read,bash,edit,write,jev_acceptance_gate,foreman_assess,jev_route,jev_recall] to the provider,
// while the same session with context.request off sends no jev_recall. Product §4.1: shadow does not
// change the tool set. Pi 0.87.1 activates a tool registered after load (_refreshToolRegistry), so the
// fake below does the same.
test("T040: shadow never adds jev_recall to the model's active tools, even with context.request shadow", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: "off" }, context: { request: "shadow" } }));
    const fake = fakePi();
    const register = fake.pi.registerTool.bind(fake.pi);
    (fake.pi as { registerTool: typeof register }).registerTool = (tool) => {
      register(tool);
      if (!fake.active().includes(tool.name)) fake.setActive([...fake.active(), tool.name]);
    };
    load(fake, h.deps({ fetch: fakeFetch(validAnswer).fetch, env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL } }));
    await fake.emit("session_start", { reason: "startup" });
    await fake.emit("before_agent_start", { prompt: "Explain src/app.js" });
    assert.ok(!fake.active().includes("jev_recall"), `shadow exposes jev_recall to the model: ${JSON.stringify(fake.active())}`);
    await fake.emit("session_shutdown", { reason: "quit" });
  } finally { await h.cleanup(); }
});

// Real host (T040 §3.7): after a task whose run.json was written as `failed`, `/jev status` showed
// "当前任务：verification_unavailable". The status line must not contradict the archived task status.
test("T040: /jev status shows the archived status of a task that ended in a model error", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, router: { tools: false } }));
    const ws = join(h.dir, "ws");
    await mkdir(ws, { recursive: true });
    const fake = fakePi({ cwd: ws });
    load(fake, h.deps({ fetch: fakeFetch(validAnswer).fetch, env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL, PI_JEV_RUN_ID: "t040err" } }));
    await fake.emit("session_start", { reason: "startup" });
    await fake.emit("before_agent_start", { prompt: "Explain src/app.js" });
    await fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", ...MESSAGE_BASE } });
    await fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "error", context: { pendingMessages: [] } });
    await fake.emit("agent_settled", {});
    const run = JSON.parse(await readFile(join(h.dir, ".pi", "agent", "pi-jev-harness", "runs", "t040err", "run.json"), "utf8")) as { status: string };
    assert.equal(run.status, "failed");
    const line = (await fake.command("status")).split("\n").find((l) => l.startsWith("当前任务："));
    assert.match(line ?? "", new RegExp(`^当前任务：${run.status}`), `status line ${line} vs run.json ${run.status}`);
    await fake.emit("session_shutdown", { reason: "quit" });
  } finally { await h.cleanup(); }
});
