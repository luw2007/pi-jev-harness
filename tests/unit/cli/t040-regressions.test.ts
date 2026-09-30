/**
 * T040 host verification: CLI regressions for defects confirmed from the real entry points.
 * These tests fail on de06f3a and describe the expected behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession } from "../../../src/cli/context.ts";

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-t040-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function deps(root: string, overrides: Partial<CliDeps> = {}): CliDeps & { stdout(): string } {
  let out = "";
  const d: CliDeps = {
    env: {},
    home: join(root, "home"),
    cwd: root,
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: () => {},
    execFile: () => "0.87.1\n",
    ...overrides,
  };
  return Object.assign(d, { stdout: () => out });
}

// Real host (T040 §3.4): with context.request shadow, a live `pi` session registers jev_recall and
// sends it to the provider, yet `pi-jev doctor` prints "jev_recall：未注册" and
// "（部分预期项未注册）", because it never emits session_start. Doctor must report real state.
test("T040: doctor does not report jev_recall as missing when context.request enables it", async () => {
  await withTemp(async (root) => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true }, context: { request: "shadow" } }));
    const d = deps(root, { configPath, env: { TYPESAFE_API_KEY: "tsk-t040-secret-0123456789" } });
    assert.equal(await main(["doctor", "--json"], d), 0);
    const reg = JSON.parse(d.stdout()).registration as { status: string; expected: { name: string; registered: boolean }[] };
    const recall = reg.expected.find((e) => e.name === "jev_recall");
    assert.ok(recall?.registered !== false || reg.status === "ok", `doctor: ${JSON.stringify(reg.expected)} status ${reg.status}`);
  });
});

// Real host (T040 §3.3 g): mode off → status native_off, but `report` names a run directory that
// was never created (the CLI's own reason says no run products were recorded).
test("T040: a native_off result does not point report at a run directory that does not exist", async () => {
  await withTemp(async (root) => {
    const session: RunSession = {
      subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      abort: async () => {},
      dispose: () => {},
    };
    const d = deps(root, { configPath: join(root, "missing.json"), createSession: async () => session });
    await main(["run", "--json", "task"], d);
    const result = JSON.parse(d.stdout()) as { status: string; report: string | null };
    assert.equal(result.status, "native_off");
    assert.ok(result.report === null || existsSync(result.report), `report ${result.report} does not exist`);
  });
});

// Real host (T040 §3.5): `pi-jev run` wrote the run under PI_JEV_RUNS_DIR (it also honors config
// `harness.runsDir`), but `pi-jev report <run-id>` with the same environment looked only in
// ~/.pi/agent/pi-jev-harness/runs and answered "产物不完整 … 没有 run.json", exit 1
// (src/cli/context.ts resolveRunTarget → defaultRunDir). report/replay by id must find the run where run put it.
test("T040: report <run-id> finds a run written under PI_JEV_RUNS_DIR or harness.runsDir", async () => {
  await withTemp(async (root) => {
    const runsDir = join(root, "custom-runs");
    const runId = "run_t040-custom";
    const dir = join(runsDir, runId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify({ schemaVersion: 1, runId, status: "completed", workspace: root, changes: [], verification: [], reasons: [], remaining: [], usage: {}, report: { dir, summary: "summary.md", receipts: "receipts.jsonl", artifacts: [] } }));
    await writeFile(join(dir, "receipts.jsonl"), "");
    assert.equal(await main(["report", dir, "--json"], deps(root, { configPath: join(root, "missing.json") })), 0, "the fixture run is reportable by path");
    const viaEnv = deps(root, { env: { PI_JEV_RUNS_DIR: runsDir }, configPath: join(root, "missing.json") });
    assert.equal(await main(["report", runId, "--json"], viaEnv), 0, "PI_JEV_RUNS_DIR");
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ mode: "shadow", harness: { runsDir } }));
    const viaConfig = deps(root, { configPath });
    assert.equal(await main(["report", runId, "--json"], viaConfig), 0, "harness.runsDir");
  });
});
