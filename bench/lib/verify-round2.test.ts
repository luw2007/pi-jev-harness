/**
 * Verifier round 2 (@ 48732b0): re-checks the round-1 findings through real entry points
 * where possible (bench/run.ts CLI, runOne with a stub harness root) and pins the report math.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeReport } from "./report-core.ts";
import { runOne, runProc, type RunContext } from "./runner.ts";
import type { BenchArm, BenchMeta, BenchTask, ResultRecord } from "./types.ts";
import { startFakeLlm } from "./fake-llm.ts";

const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));
const fig = (value: number | null) => ({ value, known: value === null ? 0 : 1, sources: 1 });
const rec = (task: string, arm: string, rep: number, passed: boolean): ResultRecord => ({
  taskId: task,
  category: "small_fix",
  arm,
  rep,
  order: 0,
  startedAt: "2026-01-01T00:00:00Z",
  runStatus: null,
  outcome: passed ? "native_off" : "incomplete",
  cliExit: 2,
  timedOut: false,
  sessionError: null,
  acceptance: { exit: passed ? 0 : 1, timedOut: false, durationMs: 1 },
  passed,
  durationMs: 100,
  usage: { costUsd: fig(null), input: fig(1), output: fig(1) },
  invalidToolCalls: 0,
  jevRequests: null,
  runDir: "/x",
});
const meta = (arms: BenchArm[]): BenchMeta => ({ startedAt: "t", seed: 1, repeat: 3, concurrency: 1, model: "m", jev: "fake", costAvailable: false, arms, tasks: [] });
const AB = meta([
  { id: "B", label: "B", config: {} },
  { id: "A", label: "A", baseline: true, config: {} },
]);
const tid = (i: number) => `t${String(i).padStart(2, "0")}`;
const completion = (r: ReturnType<typeof computeReport>, arm = "B") => r.comparisons.find((c) => c.arm === arm)!.metrics.find((m) => m.metric === "completionRate")!;
const claim = (r: ReturnType<typeof computeReport>, arm = "B") => r.limitations.find((l) => l.startsWith(`${arm} 相对`))!;

test("R2-1: 30 tasks x3 repeats, B fails all repeats on 6 tasks -> -20pp mean, CI lower bound < -2pp, no claim", () => {
  const records = Array.from({ length: 30 }, (_, i) => [1, 2, 3].flatMap((rep) => [rec(tid(i), "A", rep, true), rec(tid(i), "B", rep, i >= 6)])).flat();
  const r = computeReport(records, AB);
  const c = completion(r);
  assert.equal(r.baseline, "A", "baseline comes from meta, not from arm order");
  assert.equal(c.diffs.length, 30);
  assert.ok(Math.abs(c.interval.estimate! + 0.2) < 1e-9, String(c.interval.estimate));
  assert.ok(c.interval.lo! < -0.02 && c.interval.hi! < 0, JSON.stringify(c.interval));
  assert.match(claim(r), /样本不足以支持 2 个百分点非劣结论/);
});

test("R2-1: per-task repeats are averaged (B fails 1 of 3 repeats on 6 tasks -> -6.67pp)", () => {
  const records = Array.from({ length: 30 }, (_, i) => [1, 2, 3].flatMap((rep) => [rec(tid(i), "A", rep, true), rec(tid(i), "B", rep, !(i < 6 && rep === 1))])).flat();
  const c = completion(computeReport(records, AB));
  assert.ok(Math.abs(c.interval.estimate! - -(6 / 30 / 3)) < 1e-9, String(c.interval.estimate));
});

test("R2-1: positive control: 30 identical tasks claim non-inferiority; 29 do not", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => [rec(tid(i), "A", 1, true), rec(tid(i), "B", 1, true)]).flat();
  assert.match(claim(computeReport(mk(30), AB)), /高于 -2 个百分点/);
  assert.match(claim(computeReport(mk(29), AB)), /样本不足/);
});

test("R2-1 DEFECT: the >=30-task gate must count paired tasks, not all tasks seen", () => {
  // 30 tasks ran for A, but only 10 have a B result (e.g. the bench aborted mid-way).
  // Only 10 paired units exist, so no non-inferiority claim may be made.
  const records = Array.from({ length: 30 }, (_, i) => [rec(tid(i), "A", 1, true), ...(i < 10 ? [rec(tid(i), "B", 1, true)] : [])]).flat();
  const r = computeReport(records, AB);
  assert.equal(completion(r).diffs.length, 10);
  assert.doesNotMatch(claim(r), /高于 -2 个百分点/, claim(r));
});

test("R2 minor: baseline must be declared in meta; missing baseline throws", () => {
  assert.throws(() => computeReport([rec("t", "A", 1, true)], meta([{ id: "A", label: "A", config: {} }])), /baseline/);
  assert.throws(() => computeReport([rec("t", "A", 1, true)], null), /baseline/);
});

// ---- bench/run.ts guards: abort before meta.json ----

async function runBench(args: string[], armsFile?: object): Promise<{ status: number | null; stderr: string; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bench-v2-cli-"));
  const out = join(dir, "out");
  const extra: string[] = [];
  if (armsFile) {
    await writeFile(join(dir, "arms.json"), JSON.stringify(armsFile));
    extra.push("--arms-file", join(dir, "arms.json"));
  }
  const r = spawnSync(process.execPath, [join(BENCH, "run.ts"), "--tasks", join(BENCH, "tasks", "smoke", "*.json"), "--out", out, "--models-json", "/nonexistent/models.json", ...extra, ...args], { encoding: "utf8", env: { ...process.env, BENCH_DENY_MODELS: "blocked" } });
  return { status: r.status, stderr: r.stderr, out };
}

test("R2-4: rejected arm configs and BENCH_DENY_MODELS hits abort before meta.json (models.json not even read)", async () => {
  const A = { id: "A", label: "A", baseline: true, config: { mode: "off" } };
  const cases: [string[], object | undefined, RegExp][] = [
    [["--provider", "p", "--model", "blocked-chat"], undefined, /blocked/],
    [["--provider", "blocked", "--model", "x"], undefined, /blocked/],
    [["--provider", "p", "--model", "m", "--arms", "A,ON"], { arms: [A, { id: "ON", label: "on", config: { mode: "on" } }] }, /rejected by pi-jev loadConfig/],
    [["--provider", "p", "--model", "m", "--arms", "A,X"], { arms: [A, { id: "X", label: "x", config: { mode: "shadow", unknownField: 1 } }] }, /rejected/],
    [["--provider", "p", "--model", "m", "--arms", "A,X"], { arms: [A, { id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_X: "relay/Blocked-V4" } }] }, /blocked/],
    [["--provider", "p", "--model", "m", "--arms", "B"], undefined, /baseline/],
  ];
  for (const [args, arms, re] of cases) {
    const r = await runBench(args, arms);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(existsSync(join(r.out, "meta.json")), false, `meta.json written for ${args.join(" ")}`);
    await rm(dirname(r.out), { recursive: true, force: true });
  }
});

// ---- runOne with a stub harness root (no Pi, no model) ----

async function stubHarness(root: string, dumpDir: string, stdout: object): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  // Written as plain JS inside a .ts path: runOne always spawns <root>/src/cli.ts.
  await writeFile(
    join(root, "src", "cli.ts"),
    `require("node:fs").writeFileSync(${JSON.stringify(join(dumpDir, "cli-env.json"))}, JSON.stringify(process.env));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(stdout))});\nprocess.exit(2);\n`,
  );
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}');
}

function ctxFor(root: string, out: string, fixturesDir: string): RunContext {
  return {
    harnessRoot: root,
    fixturesDir,
    outDir: out,
    jev: "fake",
    baseEnv: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-user-secret", TYPESAFE_API_KEY: "user-jev-key", ANTHROPIC_API_KEY: "sk-ant" },
    model: { provider: "p", model: "m", providerBlock: {}, thinking: "off", retry: false, priced: false, env: { BENCH_MODEL_API_KEY: "model-key" } },
  };
}

const armOff: BenchArm = { id: "A", label: "A", baseline: true, config: { mode: "off" } };

test("R2 minor: CLI-reported timeout never counts as completed; acceptance env carries no secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-v2-run-"));
  const saved = process.env.TMPDIR;
  try {
    const root = join(dir, "harness");
    await stubHarness(root, dir, { status: "timed_out", timedOut: true, report: null, sessionError: null });
    const taskDir = join(dir, "tasks");
    await mkdir(taskDir);
    const dump = join(dir, "acc-env.json");
    const task: BenchTask = {
      id: "t",
      category: "small_fix",
      repo: { fixture: "tiny-fix" },
      prompt: "p",
      acceptance: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))`],
      timeoutSec: 30,
      taskDir,
    };
    process.env.TMPDIR = join(dir, "tmp");
    await mkdir(process.env.TMPDIR);
    const r = await runOne(ctxFor(root, join(dir, "out"), join(BENCH, "fixtures")), task, armOff, 1, 0);
    assert.equal(r.acceptance.exit, 0);
    assert.equal(r.outcome, "timeout");
    assert.equal(r.passed, false, "timed-out run must not be completed even though acceptance passed");
    assert.equal(r.invalidToolCalls, null, "no session log -> null, not 0");
    assert.equal(r.usage, null);
    assert.equal(r.modelAttempts, null);

    const cliEnv = JSON.parse(await readFile(join(dir, "cli-env.json"), "utf8")) as Record<string, string>;
    assert.equal(cliEnv.BENCH_MODEL_API_KEY, "model-key");
    assert.equal(cliEnv.TYPESAFE_API_KEY, "bench-fake-key", "fake Jev key, never the user's");
    assert.equal(cliEnv.OPENAI_API_KEY, undefined);
    assert.equal(cliEnv.ANTHROPIC_API_KEY, undefined);
    const accEnv = JSON.parse(await readFile(dump, "utf8")) as Record<string, string>;
    for (const k of ["BENCH_MODEL_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PI_JEV_URL", "PI_CODING_AGENT_DIR"]) assert.equal(accEnv[k], undefined, k);
    assert.deepEqual(await readdir(process.env.TMPDIR), [], "scratch dir removed");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("R2-5: prepareWorkspace failure still closes the fake Jev and removes the scratch dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-v2-fail-"));
  const saved = process.env.TMPDIR;
  const servers = () => process.getActiveResourcesInfo().filter((x) => x === "TCPServerWrap").length;
  try {
    const root = join(dir, "harness");
    await stubHarness(root, dir, {});
    process.env.TMPDIR = join(dir, "tmp");
    await mkdir(process.env.TMPDIR);
    const before = servers();
    const task: BenchTask = { id: "t", category: "small_fix", repo: { fixture: "no-such-fixture" }, prompt: "p", acceptance: ["true"], timeoutSec: 5, taskDir: dir };
    await assert.rejects(runOne(ctxFor(root, join(dir, "out"), join(BENCH, "fixtures")), task, armOff, 1, 0));
    await new Promise((ok) => setImmediate(ok));
    assert.equal(servers(), before, "fake Jev server still listening");
    assert.deepEqual(await readdir(process.env.TMPDIR), [], "scratch dir left behind");
    assert.equal(existsSync(join(dir, "cli-env.json")), false, "CLI must not run after workspace failure");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- relative repo.git through bench/run.ts (real CLI, local fake LLM) ----

test("R2 minor: relative repo.git resolves against the task file dir and checks out the fixed commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-v2-git-"));
  const llm = await startFakeLlm();
  try {
    const repo = join(dir, "repos", "src");
    await mkdir(repo, { recursive: true });
    const g = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("init", "-q", "-b", "main");
    await writeFile(join(repo, "f.txt"), "one\n");
    g("add", "f.txt");
    g("commit", "-q", "-m", "one");
    const first = g("rev-parse", "HEAD").stdout.trim();
    await writeFile(join(repo, "f.txt"), "two\n");
    g("commit", "-qam", "two");
    await mkdir(join(dir, "tasks"));
    await writeFile(
      join(dir, "tasks", "g.json"),
      JSON.stringify({ id: "g", category: "read_explain", repo: { git: "../repos/src", commit: first }, prompt: "say ok", acceptance: ["node", "-e", "process.exit(require('fs').readFileSync('f.txt','utf8')==='one\\n'?0:1)"], timeoutSec: 60 }),
    );
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({ providers: { fakeprov: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "fake-key", models: [{ id: "fake-model", name: "F", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }),
    );
    const out = join(dir, "out");
    // Async: the fake LLM lives in this process, so a blocking spawnSync would starve it.
    const r = await runProc([process.execPath, join(BENCH, "run.ts"), "--tasks", join(dir, "tasks", "*.json"), "--arms", "A", "--repeat", "1", "--out", out, "--provider", "fakeprov", "--model", "fake-model", "--models-json", join(dir, "models.json"), "--thinking", "off"], { cwd: tmpdir(), env: process.env, timeoutMs: 120_000 });
    assert.equal(r.exit, 0, r.stderr);
    const res = JSON.parse((await readFile(join(out, "results.jsonl"), "utf8")).trim()) as ResultRecord;
    assert.equal(res.acceptance.exit, 0, "workspace should be at the first commit");
    assert.equal(res.passed, true);
    assert.equal(res.outcome, "native_off");
  } finally {
    await llm.close();
    await rm(dir, { recursive: true, force: true });
  }
});
