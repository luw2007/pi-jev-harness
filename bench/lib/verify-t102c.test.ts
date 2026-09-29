/** Verifier: bench cancellation classification, end to end through runOne with a stub CLI (no Pi, no model). */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeReport, renderReport } from "./report-core.ts";
import { cliCancelled, outcomeOf, runOne, type ProcResult, type RunContext } from "./runner.ts";
import type { BenchArm, BenchMeta, BenchTask, ResultRecord } from "./types.ts";

const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));
const proc = (exit: number | null, timedOut = false): ProcResult => ({ exit, stdout: "", stderr: "", timedOut, error: null });

// ---- outcomeOf / cliCancelled unit edges ----

test("T102c: interrupted set but CLI status completed -> cancelled", () => {
  assert.equal(outcomeOf(proc(0), { status: "completed", timedOut: false, sessionError: null, interrupted: "SIGTERM" }, "completed"), "cancelled");
});

test("T102c: interrupted null / absent does not cancel", () => {
  assert.equal(cliCancelled({ status: "completed", interrupted: null }), false);
  assert.equal(cliCancelled({ status: "completed" }), false);
  assert.equal(cliCancelled(null), false);
  assert.equal(outcomeOf(proc(0), { status: "completed", interrupted: null }, "completed"), "completed");
});

test("T102c: timeout wins over cancellation (CLI timedOut, proc timeout, status timed_out)", () => {
  // The CLI reports status cancelled + timedOut true when --max-time aborts a `completed` run.
  assert.equal(outcomeOf(proc(2), { status: "cancelled", timedOut: true, interrupted: null }, "cancelled"), "timeout");
  assert.equal(outcomeOf(proc(null, true), { status: "cancelled", interrupted: "SIGINT" }, "cancelled"), "timeout");
  assert.equal(outcomeOf(proc(null, true), null, null), "timeout");
});

test("T102c: cancelled beats sessionError", () => {
  assert.equal(outcomeOf(proc(2), { status: "cancelled", sessionError: "aborted", interrupted: "SIGINT" }, "completed"), "cancelled");
});

test("T102c: native_off with report null still native_off (no run.json read)", () => {
  assert.equal(outcomeOf(proc(2), { status: "native_off", report: null, interrupted: null } as never, null), "native_off");
});

// ---- runOne with a stub CLI that writes a run.json saying `completed` ----

async function stubHarness(root: string, stdout: Record<string, unknown>, runJsonStatus: string | null): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  const reportDir = join(root, "report");
  await mkdir(reportDir, { recursive: true });
  if (runJsonStatus !== null) await writeFile(join(reportDir, "run.json"), JSON.stringify({ status: runJsonStatus }));
  const out = { ...stdout, report: stdout.report === null ? null : reportDir };
  await writeFile(join(root, "src", "cli.ts"), `process.stdout.write(${JSON.stringify(JSON.stringify(out))});\nprocess.exit(2);\n`);
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}');
}

const armOn: BenchArm = { id: "B", label: "B", config: {} };
const armOff: BenchArm = { id: "A", label: "A", baseline: true, config: { mode: "off" } };

async function runStub(stdout: Record<string, unknown>, runJsonStatus: string | null, arm: BenchArm, accExit = 0): Promise<ResultRecord> {
  const dir = await mkdtemp(join(tmpdir(), "bench-t102c-"));
  try {
    const root = join(dir, "harness");
    await stubHarness(root, stdout, runJsonStatus);
    const task: BenchTask = { id: "t", category: "small_fix", repo: { fixture: "tiny-fix" }, prompt: "p", acceptance: ["node", "-e", `process.exit(${accExit})`], timeoutSec: 30, taskDir: dir };
    const ctx: RunContext = {
      harnessRoot: root,
      fixturesDir: join(BENCH, "fixtures"),
      outDir: join(dir, "out"),
      jev: "fake",
      baseEnv: { PATH: process.env.PATH },
      model: { provider: "p", model: "m", providerBlock: {}, thinking: "off", retry: false, priced: false, env: {} },
    };
    return await runOne(ctx, task, arm, 1, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("T102c runOne: SIGINT with run.json completed + acceptance pass -> cancelled, not passed", async () => {
  const r = await runStub({ status: "cancelled", timedOut: false, sessionError: null, interrupted: "SIGINT" }, "completed", armOn);
  assert.equal(r.acceptance.exit, 0);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.runStatus, "cancelled");
  assert.equal(r.passed, false);
});

test("T102c runOne: interrupted set but CLI status completed -> cancelled", async () => {
  const r = await runStub({ status: "completed", timedOut: false, sessionError: null, interrupted: "SIGTERM" }, "completed", armOn);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.runStatus, "cancelled");
  assert.equal(r.passed, false);
});

test("T102c runOne: timeout + cancelled -> timeout, not passed", async () => {
  const r = await runStub({ status: "cancelled", timedOut: true, sessionError: null, interrupted: null }, "completed", armOn);
  assert.equal(r.outcome, "timeout");
  assert.equal(r.timedOut, true);
  assert.equal(r.passed, false);
});

test("T102c runOne: plain completed still passes", async () => {
  const r = await runStub({ status: "completed", timedOut: false, sessionError: null, interrupted: null }, "completed", armOn);
  assert.equal(r.outcome, "completed");
  assert.equal(r.runStatus, "completed");
  assert.equal(r.passed, true);
});

test("T102c runOne: native_off with report null -> native_off, runStatus null, passes on acceptance", async () => {
  const r = await runStub({ status: "native_off", timedOut: false, sessionError: null, interrupted: null, report: null }, null, armOff);
  assert.equal(r.outcome, "native_off");
  assert.equal(r.runStatus, null);
  assert.equal(r.passed, true);
});

test("T102c runOne: native_off interrupted -> cancelled, not passed", async () => {
  const r = await runStub({ status: "native_off", timedOut: false, sessionError: null, interrupted: "SIGINT", report: null }, null, armOff);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.passed, false);
});

// ---- report aggregation with a cancelled arm ----

const fig = (value: number | null) => ({ value, known: value === null ? 0 : 1, sources: 1 });
function rec(task: string, arm: string, outcome: ResultRecord["outcome"], runStatus: string | null, passed: boolean): ResultRecord {
  return {
    taskId: task,
    category: "small_fix",
    arm,
    rep: 1,
    order: 0,
    startedAt: "2026-01-01T00:00:00Z",
    runStatus,
    outcome,
    cliExit: 2,
    timedOut: outcome === "timeout",
    sessionError: null,
    acceptance: { exit: 0, timedOut: false, durationMs: 10 },
    passed,
    durationMs: 100,
    usage: { costUsd: fig(0.01), input: fig(1), output: fig(1) },
    invalidToolCalls: 0,
    jevRequests: null,
    runDir: "/x",
  };
}

test("T102c report: cancelled arm counts neither as completed nor as false completion", async () => {
  const meta: BenchMeta = {
    startedAt: "t", seed: 1, repeat: 1, concurrency: 1, model: "m", jev: "fake", tasks: [],
    arms: [
      { id: "A", label: "A", baseline: true, config: {} },
      { id: "B", label: "B", config: {} },
    ],
  };
  // Records built the way runOne builds them for a cancelled run (acceptance exit 0).
  const recs = [
    rec("t1", "A", "completed", "completed", true),
    rec("t2", "A", "completed", "completed", true),
    rec("t1", "B", "cancelled", "cancelled", false),
    rec("t2", "B", "completed", "completed", true),
  ];
  const report = computeReport(recs, meta);
  const all = report.arms;
  const b = all.find((a) => a.arm === "B")!;
  assert.equal(b.completed, 1);
  assert.equal(b.completionRate, 0.5);
  assert.deepEqual(b.outcomes, { cancelled: 1, completed: 1 });
  assert.equal(b.falseCompletions, 0);
  assert.equal(b.passedNotCompleted, 0);
  assert.match(renderReport(report), /cancelled=1/);
});
