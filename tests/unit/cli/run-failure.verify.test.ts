/**
 * T041 verification of T039 end to end: `pi-jev run` (`main`) drives a session whose events reach
 * the REAL pi-jev extension (`createExtension`) on the fake Pi host, so run.json, receipts and
 * the CLI output come from production code on both sides. No real Pi, Jev, provider or model.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../../src/adapters/pi/config.ts";
import { EXIT, main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession } from "../../../src/cli/context.ts";
import { createTelemetryWriter } from "../../../src/telemetry/index.ts";
import { fakeFetch, fakePi, load, validAnswer } from "../adapters/pi/fake-host.ts";

const JEV_KEY = "jevkey-LIVE-0123456789abcdef";
const SECRET = "sk-proj-ABCDEFGH12345678abcdefgh";
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface Scenario {
  /** Adapter config file content; null leaves no file (defaults: off). */
  config: Record<string, unknown> | string | null;
  /** Failed assistant messages, in order (Pi retries). */
  providerErrors?: string[];
  /** Assistant answer before settling (a successful turn). */
  answer?: string;
  /** agent_before_settle outcome. */
  outcome?: "completed" | "error" | "aborted";
  /** prompt() rejects with this after the events. */
  promptError?: Error;
  /** PI_JEV_RUNS_DIR handed to the CLI (and so to the extension). */
  runsDir?: (root: string) => Promise<string>;
}

interface Result {
  code: number;
  out: string;
  err: string;
  root: string;
  home: string;
  runFiles: string[];
}

async function run(scenario: Scenario, args: string[] = ["--json"]): Promise<Result & { cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-run-verify-"));
  const home = join(root, "home");
  const ws = join(root, "ws");
  await mkdir(ws, { recursive: true });
  const configPath = join(home, ".pi", "agent", "pi-jev-harness", "config.json");
  if (scenario.config !== null) {
    await mkdir(join(home, ".pi", "agent", "pi-jev-harness"), { recursive: true });
    await writeFile(configPath, typeof scenario.config === "string" ? scenario.config : JSON.stringify(scenario.config));
  }
  const env: Record<string, string> = { TYPESAFE_API_KEY: JEV_KEY, PI_JEV_URL: "http://jev.test/v1/systemone" };
  if (scenario.runsDir) env.PI_JEV_RUNS_DIR = await scenario.runsDir(root);
  let out = "";
  let err = "";
  const pending: Promise<unknown>[] = [];
  const deps: CliDeps = {
    env,
    home,
    cwd: root,
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    execFile: () => { throw new Error("run must not spawn processes"); },
    async createSession(opts) {
      const fake = fakePi({ cwd: opts.cwd });
      const jev = fakeFetch(validAnswer);
      load(fake, {
        env: opts.env,
        loadConfig: () => loadConfig({ home, path: configPath, env: opts.env }),
        fetch: jev.fetch,
        createTelemetry: (dir) => createTelemetryWriter({ dir, now: Date.now }),
      }, {});
      await fake.emit("session_start", { reason: "startup" });
      const listeners: ((event: AgentSessionEvent) => void)[] = [];
      const cli = (event: unknown) => listeners.forEach((listener) => listener(event as AgentSessionEvent));
      const both = async (type: string, payload: Record<string, unknown>) => {
        await fake.emit(type, payload);
        cli({ type, ...payload });
      };
      const session: RunSession = {
        subscribe(listener) {
          listeners.push(listener);
          return () => void listeners.splice(listeners.indexOf(listener), 1);
        },
        async prompt(text) {
          await fake.emit("before_agent_start", { prompt: text });
          for (const errorMessage of scenario.providerErrors ?? []) {
            await both("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage, provider: "p", model: "m", usage: USAGE, timestamp: 0 } });
            cli({ type: "auto_retry_end", success: false, attempt: 1, finalError: errorMessage });
          }
          if (scenario.answer !== undefined)
            await both("message_end", { message: { role: "assistant", content: [{ type: "text", text: scenario.answer }], stopReason: "stop", provider: "p", model: "m", usage: USAGE, timestamp: 0 } });
          await fake.emit("agent_before_settle", { entries: [], continue: false, outcome: scenario.outcome ?? (scenario.providerErrors?.length ? "error" : "completed"), context: { pendingMessages: [] } });
          await both("agent_settled", {});
          if (scenario.promptError) throw scenario.promptError;
        },
        waitForIdle: async () => {},
        abort: async () => {},
        dispose() {
          pending.push(fake.emit("session_shutdown", { reason: "quit" }));
        },
      };
      return session;
    },
  };
  const code = await main(["run", ...args, "--cwd", ws, "task"], deps);
  await Promise.all(pending);
  const runFiles: string[] = [];
  const runsRoot = env.PI_JEV_RUNS_DIR ?? join(home, ".pi", "agent", "pi-jev-harness", "runs");
  for (const name of await readdir(runsRoot).catch(() => [] as string[]))
    for (const file of await readdir(join(runsRoot, name)).catch(() => [] as string[])) runFiles.push(await readFile(join(runsRoot, name, file), "utf8"));
  return { code, out, err, root, home, runFiles, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const SHADOW = { mode: "shadow", outbound: { taskIntent: true }, router: { tools: "off" } };

test("shadow + every request fails with a key-bearing provider error: failed, exit 1, no key in run.json, receipts, summary, stdout or stderr", async () => {
  for (const args of [["--json"], []]) {
    const r = await run({ config: SHADOW, providerErrors: [`401 {"message":"Incorrect API key provided: ${SECRET}"}`, `401 {"message":"bad key ${JEV_KEY}"}`] }, args);
    try {
      assert.equal(r.code, EXIT.error, args.join(" "));
      if (args.length) {
        const result = JSON.parse(r.out);
        assert.equal(result.status, "failed");
        assert.equal(result.sessionError, null, "run.json exists: the failure lives in its reasons");
        assert.ok(result.reasons.some((reason: string) => reason.startsWith("模型请求失败：")), JSON.stringify(result.reasons));
      } else assert.match(r.out, /状态：执行失败（failed）/);
      assert.equal(r.runFiles.length, 3, "summary.md, run.json, receipts.jsonl");
      for (const text of [r.out, r.err, ...r.runFiles]) {
        assert.ok(!text.includes(SECRET), "provider key leaked");
        assert.ok(!text.includes(JEV_KEY), "Jev key leaked");
      }
      assert.match(r.err, /\[模型请求失败\] 401 .*\[已移除：疑似凭据\]/);
    } finally { await r.cleanup(); }
  }
});

test("a prompt() rejection carrying a provider key is scrubbed before it becomes sessionError", async () => {
  const r = await run({ config: SHADOW, providerErrors: ["503"], promptError: new Error(`401 Incorrect API key provided: ${SECRET}`) });
  try {
    assert.equal(r.code, EXIT.error);
    const result = JSON.parse(r.out);
    assert.ok(result.sessionError, "the prompt failure is reported");
    assert.ok(!r.out.includes(SECRET), `sessionError / reasons leak the key: ${result.sessionError}`);
  } finally { await r.cleanup(); }
});

test("no config (effective off): native_off, exit 2, and nothing at all under the harness directory", async () => {
  const r = await run({ config: null, answer: "ok" });
  try {
    assert.equal(r.code, EXIT.notCompleted);
    assert.equal(JSON.parse(r.out).status, "native_off");
    assert.deepEqual(await readdir(join(r.home, ".pi", "agent", "pi-jev-harness")).catch(() => "absent"), "absent", "off writes nothing (no runs, telemetry or context)");
  } finally { await r.cleanup(); }
});

test("config file with mode on (refused) is invalid, so effective off: native_off exit 2, not artifacts_missing", async () => {
  const r = await run({ config: { mode: "on" }, answer: "ok" });
  try {
    assert.equal(r.code, EXIT.notCompleted);
    assert.equal(JSON.parse(r.out).status, "native_off");
  } finally { await r.cleanup(); }
});

test("shadow but the extension could not write (runs dir is a file): artifacts_missing, exit 1, never completed", async () => {
  const r = await run({ config: SHADOW, answer: "ok", runsDir: async (root) => { const file = join(root, "not-a-dir"); await writeFile(file, "x"); return file; } });
  try {
    assert.equal(r.code, EXIT.error);
    const result = JSON.parse(r.out);
    assert.equal(result.status, "artifacts_missing");
    assert.equal(result.sessionError, null);
  } finally { await r.cleanup(); }
});

test("exit-code matrix through the real extension: completed 0, cancelled 2, failed 1", async () => {
  const cases: [Scenario, string, number][] = [
    [{ config: SHADOW, answer: "The answer is 41." }, "completed", EXIT.ok],
    [{ config: SHADOW, answer: "partial", outcome: "aborted" }, "cancelled", EXIT.notCompleted],
    [{ config: SHADOW, providerErrors: ["503 resource_pressure"] }, "failed", EXIT.error],
  ];
  for (const [scenario, status, code] of cases) {
    const r = await run(scenario);
    try {
      assert.equal(JSON.parse(r.out).status, status, status);
      assert.equal(r.code, code, status);
    } finally { await r.cleanup(); }
  }
});
