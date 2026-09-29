/**
 * CLI fixes for the wave 1-4 review (L1, L2, M3) and defect 3, from the real entry points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession } from "../../../src/cli/context.ts";
import { REDACTED, buildShareExport } from "../../../src/cli/export.ts";
import type { LoadedRun } from "../../../src/cli/report.ts";
import type { RunJson } from "../../../src/harness/index.ts";

// Credential-shaped samples are assembled at runtime so no literal secret sits in the source.
const j = (...parts: string[]) => parts.join("");
const LETTERS_SECRET = "abcdefghijklmnopqrstuvwx";
const PROVIDER_KEY = j("sk-", "proj-", "ABCDEFGH12345678abcdefgh");

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-t043-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function deps(root: string, overrides: Partial<CliDeps> = {}): CliDeps & { stdout(): string } {
  let out = "";
  const d: CliDeps = {
    env: {},
    home: join(root, "home"),
    cwd: root,
    configPath: join(root, "missing.json"),
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: () => {},
    execFile: () => "0.87.1\n",
    ...overrides,
  };
  return Object.assign(d, { stdout: () => out });
}

function session(overrides: Partial<RunSession> = {}): RunSession {
  return {
    subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
    prompt: async () => {},
    waitForIdle: async () => {},
    abort: async () => {},
    dispose: () => {},
    ...overrides,
  };
}

test("L1: the share export redacts a string carrying a letters-only JSON credential", () => {
  const workspace = j('/srv/{"api', 'Key": "', LETTERS_SECRET, '"}');
  const run = { schemaVersion: 1, runId: "run_t043", status: "completed", workspace, changes: [], verification: [], reasons: [], remaining: [], usage: {} } as unknown as RunJson;
  const loaded: LoadedRun = { dir: "/tmp/run_t043", text: JSON.stringify(run), run, task: null, summaryPresent: false };
  const x = buildShareExport(loaded, "", deps("/tmp/none"));
  assert.equal(x.workspace, REDACTED);
  assert.ok(!JSON.stringify(x).includes(LETTERS_SECRET));
});

test("L2: an abort that fails after the session already settled is still reported", async () => {
  await withTemp(async (root) => {
    let settle!: () => void;
    const s = session({
      prompt: () => new Promise<void>((done) => (settle = done)),
      // The session ends at once; the abort call itself rejects a moment later.
      abort: () => {
        settle();
        return new Promise<void>((_, fail) => setTimeout(() => fail(new Error("abort transport broke")), 20));
      },
    });
    const d = deps(root, { createSession: async () => s });
    assert.equal(await main(["run", "--json", "--max-time", "10ms", "task"], d), 1);
    const result = JSON.parse(d.stdout()) as { timedOut: boolean; sessionError: string | null; reasons: string[] };
    assert.equal(result.timedOut, true);
    assert.match(result.sessionError ?? "", /中止会话失败：abort transport broke/);
  });
});

test("T041 defect 3: a session-creation failure carrying a provider key is scrubbed", async () => {
  await withTemp(async (root) => {
    const d = deps(root, { createSession: async () => { throw new Error(`401 Incorrect API key provided: ${PROVIDER_KEY}`); } });
    assert.equal(await main(["run", "--json", "task"], d), 1);
    const result = JSON.parse(d.stdout()) as { sessionError: string };
    assert.match(result.sessionError, /^启动 Pi 会话失败：/);
    assert.ok(!d.stdout().includes("ABCDEFGH12345678"), d.stdout());
  });
});

test("T041 defect 3: a failed abort carrying a provider key is scrubbed", async () => {
  await withTemp(async (root) => {
    let settle!: () => void;
    const s = session({
      prompt: () => new Promise<void>((done) => (settle = done)),
      abort: async () => {
        settle();
        throw new Error(`abort failed for ${PROVIDER_KEY}`);
      },
    });
    const d = deps(root, { createSession: async () => s });
    await main(["run", "--json", "--max-time", "10ms", "task"], d);
    assert.match(JSON.parse(d.stdout()).sessionError, /中止会话失败/);
    assert.ok(!d.stdout().includes("ABCDEFGH12345678"), d.stdout());
  });
});

test("M3: with context.request off, doctor reports jev_recall as disabled by config, not missing", async () => {
  await withTemp(async (root) => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ mode: "shadow", context: { request: "off" } }));
    const json = deps(root, { configPath });
    assert.equal(await main(["doctor", "--json"], json), 0);
    const reg = JSON.parse(json.stdout()).registration as { status: string; expected: { name: string; required: boolean; registered: boolean }[] };
    assert.equal(reg.status, "ok");
    assert.deepEqual(reg.expected.find((e) => e.name === "jev_recall"), { kind: "tool", name: "jev_recall", required: false, registered: false });
    const text = deps(root, { configPath });
    await main(["doctor"], text);
    assert.match(text.stdout(), /  - jev_recall：按配置未启用\n/);
    assert.doesNotMatch(text.stdout(), /部分预期项未注册/);
  });
});

test("M3: with context.request shadow, doctor sees jev_recall registered and reports ok", async () => {
  await withTemp(async (root) => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ mode: "shadow", context: { request: "shadow" } }));
    const d = deps(root, { configPath });
    assert.equal(await main(["doctor", "--json"], d), 0);
    const reg = JSON.parse(d.stdout()).registration as { status: string; tools: string[] };
    assert.equal(reg.status, "ok");
    assert.ok(reg.tools.includes("jev_recall"));
  });
});

test("replay <run-id> finds the run under PI_JEV_RUNS_DIR like report does", async () => {
  await withTemp(async (root) => {
    const runsDir = join(root, "custom-runs");
    const dir = join(runsDir, "run_t043-replay");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "receipts.jsonl"), "");
    const missing = deps(root);
    assert.equal(await main(["replay", "run_t043-replay", "--json"], missing), 1, "not under the default directory");
    const viaEnv = deps(root, { env: { PI_JEV_RUNS_DIR: runsDir } });
    assert.equal(await main(["replay", "run_t043-replay", "--json"], viaEnv), 0);
  });
});
