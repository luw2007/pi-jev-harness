/**
 * Verifier round 3 (T102 @ a04bc1f): repo-source precheck before meta.json, no scratch leak when a
 * sibling run fails at --concurrency 2, and arm env validated through loadConfig. Drives the real
 * bench/run.ts entry with the local fake LLM (no real model).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkArm } from "./arms.ts";
import { startFakeLlm } from "./fake-llm.ts";
import { runProc } from "./runner.ts";
import type { ResultRecord } from "./types.ts";

const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));
const MAGIC = { id: "magic", category: "read_explain", repo: { fixture: "answer-file" }, prompt: "Read NOTES.md and write only the magic word it names into a new file ANSWER.txt.", acceptance: ["node", "-e", "process.exit(require('fs').readFileSync('ANSWER.txt','utf8').includes('PINEAPPLE')?0:1)"], timeoutSec: 60 };

async function modelsJson(dir: string, baseUrl: string): Promise<string> {
  const p = join(dir, "models.json");
  await writeFile(p, JSON.stringify({ providers: { fakeprov: { baseUrl, api: "openai-completions", apiKey: "fake-key", models: [{ id: "fake-model", name: "F", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }));
  return p;
}

function gitRepo(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  spawnSync("sh", ["-c", "echo x > f.txt && git add f.txt && git commit -qm one"], { cwd: dir, env });
}

test("R3-2: a missing repo source aborts before meta.json (fixture and relative git)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-v3-pre-"));
  try {
    for (const repo of [{ fixture: "no-such-fixture" }, { git: "../nope", commit: "deadbeef" }]) {
      await rm(join(dir, "tasks"), { recursive: true, force: true });
      await mkdir(join(dir, "tasks"));
      await writeFile(join(dir, "tasks", "x.json"), JSON.stringify({ ...MAGIC, id: "x", repo }));
      const out = join(dir, "out");
      const r = spawnSync(process.execPath, [join(BENCH, "run.ts"), "--tasks", join(dir, "tasks", "*.json"), "--arms", "A", "--out", out, "--provider", "p", "--model", "m", "--models-json", "/nonexistent/models.json"], { encoding: "utf8" });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /repo source not found/);
      assert.equal(existsSync(join(out, "meta.json")), false, JSON.stringify(repo));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R3-2: at --concurrency 2 a sibling's bench-side failure leaks no scratch dir and keeps the other runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-v3-conc-"));
  const llm = await startFakeLlm();
  try {
    const repo = join(dir, "repo");
    await mkdir(repo);
    gitRepo(repo);
    await mkdir(join(dir, "tasks"));
    await writeFile(join(dir, "tasks", "a-magic.json"), JSON.stringify(MAGIC));
    // Passes the precheck (repo exists, commit is well-formed) but checkout fails inside runOne,
    // after the scratch dir and fake Jev exist.
    await writeFile(join(dir, "tasks", "b-bad.json"), JSON.stringify({ ...MAGIC, id: "bad", repo: { git: "../repo", commit: "0123456789abcdef0123456789abcdef01234567" } }));
    const scratchRoot = join(dir, "tmp");
    await mkdir(scratchRoot);
    const out = join(dir, "out");
    const r = await runProc(
      [process.execPath, join(BENCH, "run.ts"), "--tasks", join(dir, "tasks", "*.json"), "--arms", "A,B", "--repeat", "1", "--concurrency", "2", "--out", out, "--provider", "fakeprov", "--model", "fake-model", "--models-json", await modelsJson(dir, llm.baseUrl), "--thinking", "off"],
      { cwd: dir, env: { ...process.env, TMPDIR: scratchRoot }, timeoutMs: 180_000 },
    );
    if (process.env.V3_DEBUG) console.error(r.stderr);
    assert.equal(r.exit, 1, "bench-side failures must make the bench exit non-zero");
    assert.match(r.stderr, /2 run\(s\) failed inside the bench/);
    // Pi's own jiti module cache also lands in TMPDIR; only the bench's scratch dirs matter here.
    assert.deepEqual((await readdir(scratchRoot)).filter((n) => n.startsWith("pi-jev-bench-")), [], "scratch dirs leaked");
    const errors = await readFile(join(out, "bench-errors.txt"), "utf8");
    assert.match(errors, /bad rep 1 arm A/);
    assert.match(errors, /bad rep 1 arm B/);
    const recs = (await readFile(join(out, "results.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as ResultRecord);
    assert.deepEqual(recs.map((x) => `${x.taskId}/${x.arm}`).sort(), ["magic/A", "magic/B"]);
    assert.ok(recs.every((x) => x.passed), "sibling runs completed normally");
  } finally {
    await llm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R3-3: arm env is validated through loadConfig (CLI aborts before meta.json)", async () => {
  assert.match((await checkArm({ id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_RUN_ID: "bad/id" } }))!, /rejected by pi-jev loadConfig.*PI_JEV_RUN_ID/);
  assert.match((await checkArm({ id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_RUNS_DIR: "relative/dir" } }))!, /PI_JEV_RUNS_DIR/);
  assert.equal(await checkArm({ id: "X", label: "x", config: { mode: "shadow" }, env: { SOME_FLAG: "1" } }), null);
  const dir = await mkdtemp(join(tmpdir(), "bench-v3-env-"));
  try {
    await writeFile(join(dir, "arms.json"), JSON.stringify({ arms: [{ id: "A", label: "A", baseline: true, config: { mode: "off" } }, { id: "X", label: "x", config: { mode: "shadow" }, env: { PI_JEV_RUN_ID: "bad/id" } }] }));
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, [join(BENCH, "run.ts"), "--tasks", join(BENCH, "tasks", "smoke", "*.json"), "--arms", "A,X", "--arms-file", join(dir, "arms.json"), "--out", out, "--provider", "p", "--model", "m", "--models-json", "/nonexistent/models.json"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /arm X: config rejected/);
    assert.equal(existsSync(join(out, "meta.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
