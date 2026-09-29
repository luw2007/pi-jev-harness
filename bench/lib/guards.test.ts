import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkArm, checkModel } from "./arms.ts";
import { acceptanceArgv, minimalEnv, outcomeOf, readSessionLogs } from "./runner.ts";
import type { BenchArm } from "./types.ts";

const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));

test("every runnable arm in arms.json is accepted by the product's loadConfig", async () => {
  const { arms } = JSON.parse(await readFile(join(BENCH, "arms.json"), "utf8")) as { arms: BenchArm[] };
  for (const arm of arms) assert.equal(await checkArm(arm), null, arm.id);
  assert.ok(arms.some((a) => a.id === "D" && !a.unsupported));
});

test("a config the adapter rejects aborts the arm instead of running as off", async () => {
  assert.match((await checkArm({ id: "X", label: "x", config: { mode: "on" } }))!, /rejected by pi-jev loadConfig/);
  assert.match((await checkArm({ id: "X", label: "x", config: { mode: "shadow", bogus: 1 } }))!, /rejected/);
  assert.match((await checkArm({ id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_X: "blocked/blocked-v4" } }, ["blocked"]))!, /BENCH_DENY_MODELS/);
  assert.equal(await checkArm({ id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_X: "blocked/blocked-v4" } }, []), null);
  assert.match((await checkArm({ id: "X", label: "x", config: {}, unsupported: "no" }))!, /not runnable/);
  // The arm's env is validated too: an invalid PI_JEV_RUNS_DIR would make the adapter fall back to off.
  assert.match((await checkArm({ id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_RUNS_DIR: "relative/dir" } }))!, /rejected/);
  assert.equal(checkModel("prov", "model-5", ["blocked"]), null);
  assert.notEqual(checkModel("prov", "Blocked-V4", ["blocked"]), null);
  assert.equal(checkModel("prov", "Blocked-V4", []), null, "no default denylist");
});

test("session logs: tool isError, per-attempt usage, malformed lines tolerated; unknown usage is null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-guard-"));
  try {
    await mkdir(join(dir, "s"));
    const lines = [
      { type: "message", message: { role: "assistant", stopReason: "toolUse", usage: { input: 100, output: 10, cost: { total: 0 } } } },
      { type: "message", message: { role: "toolResult", isError: true } },
      { type: "message", message: { role: "toolResult", isError: false } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "[工具失败] in text" }], usage: { input: 120, output: 5, cost: { total: 0 } } } },
    ];
    await writeFile(join(dir, "s", "a.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"type":"mess`);
    const s = (await readSessionLogs(dir))!;
    assert.equal(s.toolErrors, 1);
    assert.equal(s.toolResults, 2);
    assert.equal(s.attempts, 2);
    assert.equal(s.input, 220);
    assert.equal(s.output, 15);
    assert.equal(s.malformed, 1);
    await writeFile(join(dir, "s", "b.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } })}\n`);
    const t = (await readSessionLogs(dir))!;
    assert.equal(t.input, null, "an attempt without usage makes the total unknown, not 0");
    assert.equal(await readSessionLogs(join(dir, "missing")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timed-out CLI result is a timeout outcome even if run.json says completed", () => {
  const p = { exit: 2, stdout: "", stderr: "", timedOut: false, error: null };
  assert.equal(outcomeOf(p, { status: "timed_out" }, "completed"), "timeout");
  assert.equal(outcomeOf(p, { timedOut: true }, "completed"), "timeout");
  assert.equal(outcomeOf(p, {}, "completed"), "completed");
  assert.equal(outcomeOf(p, { status: "native_off" }, null), "native_off");
  assert.equal(outcomeOf(p, { status: "artifacts_missing" }, null), "artifacts_missing");
});

test("child env keeps only non-secret variables; acceptance argv expands {taskDir}", () => {
  const env = minimalEnv({ PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk", BENCH_MODEL_API_KEY: "k", TYPESAFE_API_KEY: "t" });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.deepEqual(acceptanceArgv({ id: "t", category: "small_fix", repo: { fixture: "f" }, prompt: "p", acceptance: ["node", "{taskDir}/c.mjs"], timeoutSec: 1, taskDir: "/tasks" }), ["node", "/tasks/c.mjs"]);
});
