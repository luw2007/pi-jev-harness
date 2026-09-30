/**
 * T045: host-verified CLI defects. E1 (Ctrl-C leaves a cancelled run), `--json` carries
 * `completion`, E10 (export labels keep parenthesised separators), doctor probes the resolved runsDir.
 * Signals are simulated through the injectable `signals` hook; no real signal reaches this process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EXIT, main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession, RunSignal } from "../../../src/cli/context.ts";
import { buildShareExport } from "../../../src/cli/export.ts";
import type { LoadedRun } from "../../../src/cli/report.ts";
import type { RunJson } from "../../../src/harness/index.ts";

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-t045-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const COMPLETION = { status: "incomplete", stopAllowed: false, assessment: "acceptance", continuations: { used: 1, max: 2 } };

interface SignalFake {
  deps: CliDeps;
  out(): string;
  err(): string;
  /** Deliver a signal to the handler `run` installed; throws when none is installed. */
  send(signal: RunSignal): void;
  installed(): number;
  exits: number[];
  aborted(): number;
}

/**
 * A session whose prompt hangs after its first tool call. `abort()` lets it write run.json with
 * `abortStatus` (the adapter's cancelled record) unless `abortHangs`.
 */
function signalFake(root: string, options: { abortStatus?: string; abortHangs?: boolean; status?: string } = {}): SignalFake {
  let out = "";
  let err = "";
  let aborted = 0;
  let handler: ((signal: RunSignal) => void) | null = null;
  let installed = 0;
  const exits: number[] = [];
  const shadowConfig = join(root, "shadow-config.json");
  let onStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => (onStarted = resolve));
  const deps: CliDeps = {
    env: {},
    home: join(root, "home"),
    cwd: root,
    configPath: shadowConfig,
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    execFile: () => { throw new Error("no spawn"); },
    abortGraceMs: 50,
    signals: {
      subscribe(h) {
        installed++;
        handler = h;
        return () => { installed--; handler = null; };
      },
      exit: (code) => void exits.push(code),
    },
    createSession: async (opts) => {
      await writeFile(shadowConfig, JSON.stringify({ mode: "shadow" }));
      const listeners: ((event: AgentSessionEvent) => void)[] = [];
      let release: (status: string) => void = () => {};
      // Synchronous on purpose: abort() -> release -> run.json -> settled stays within microtasks, so the
      // `abortGraceMs` timer (a macrotask) can never win the race however loaded the machine is (T050).
      const writeRun = (status: string) => {
        const dir = join(opts.env.PI_JEV_RUNS_DIR!, opts.env.PI_JEV_RUN_ID!);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "run.json"), JSON.stringify({
          schemaVersion: 1, runId: opts.env.PI_JEV_RUN_ID, status, workspace: opts.cwd,
          changes: [{ path: "src/a.ts", change: "modified" }], verification: [],
          completion: COMPLETION,
          reasons: status === "completed" ? [] : ["用户取消：任务被中止（Request was aborted）"], remaining: [], usage: {},
          report: { dir, summary: "summary.md", receipts: "receipts.jsonl", artifacts: [] },
        }));
      };
      const session: RunSession = {
        subscribe: (l) => { listeners.push(l); return () => void listeners.splice(listeners.indexOf(l), 1); },
        prompt: async () => {
          listeners.forEach((l) => l({ type: "tool_execution_start", toolName: "edit", toolCallId: "t1", args: {} } as unknown as AgentSessionEvent));
          if (options.status) { writeRun(options.status); return; }
          onStarted();
          const status = await new Promise<string>((resolve) => (release = resolve));
          writeRun(status);
          listeners.forEach((l) => l({ type: "agent_settled" } as unknown as AgentSessionEvent));
        },
        waitForIdle: async () => {},
        abort: async () => {
          aborted++;
          if (!options.abortHangs) release(options.abortStatus ?? "cancelled");
        },
        dispose: () => {},
      };
      if (options.status) onStarted();
      return session;
    },
  };
  return {
    deps, out: () => out, err: () => err, exits, aborted: () => aborted, installed: () => installed,
    send(signal) {
      if (!handler) throw new Error("no signal handler installed");
      handler(signal);
    },
    // exposed for tests that must wait for the prompt to hang
    ...{ started },
  } as SignalFake & { started: Promise<void> };
}

test("E1: SIGINT during run aborts the session, waits for the cancelled run.json, prints the result and exits notCompleted", async () => {
  await withTemp(async (root) => {
    const f = signalFake(root) as SignalFake & { started: Promise<void> };
    const running = main(["run", "--json", "fix it"], f.deps);
    await f.started;
    assert.equal(f.installed(), 1, "handlers installed for the run");
    f.send("SIGINT");
    const code = await running;
    assert.equal(code, EXIT.notCompleted);
    assert.equal(f.aborted(), 1, "the session is aborted through the SDK abort()");
    assert.deepEqual(f.exits, [], "the first signal never exits the process");
    assert.equal(f.installed(), 0, "handlers removed after the run");
    const result = JSON.parse(f.out());
    assert.equal(result.status, "cancelled");
    assert.equal(result.interrupted, "SIGINT");
    assert.deepEqual(result.changes, [{ path: "src/a.ts", change: "modified" }], "changes so far are reported");
    assert.match(result.report, /run_/);
    assert.equal(result.sessionError, null);
    assert.ok(result.reasons.some((r: string) => r.includes("SIGINT")));
  });
});

test("E1: a run.json still completed after SIGINT is reported as cancelled", async () => {
  await withTemp(async (root) => {
    const f = signalFake(root, { abortStatus: "completed" }) as SignalFake & { started: Promise<void> };
    const running = main(["run", "task"], f.deps);
    await f.started;
    f.send("SIGTERM");
    assert.equal(await running, EXIT.notCompleted);
    assert.match(f.out(), /已取消（cancelled）/);
    assert.match(f.out(), /SIGTERM/);
  });
});

test("E1: a second signal exits at once with 130; an abort that never settles is bounded", async () => {
  await withTemp(async (root) => {
    const f = signalFake(root, { abortHangs: true }) as SignalFake & { started: Promise<void> };
    const running = main(["run", "--json", "task"], f.deps);
    await f.started;
    f.send("SIGINT");
    f.send("SIGINT");
    assert.deepEqual(f.exits, [130]);
    // The fake exit does not end this test process: the bounded wait still returns.
    const code = await running;
    assert.equal(code, EXIT.error, "no run.json: artifacts_missing");
    const result = JSON.parse(f.out());
    assert.equal(result.status, "artifacts_missing");
    assert.ok(result.reasons.some((r: string) => r.includes("未结束")), result.reasons.join("\n"));
    assert.equal(f.installed(), 0);
  });
});

test("E1: handlers are installed only while the run lasts", async () => {
  await withTemp(async (root) => {
    const f = signalFake(root, { status: "completed" });
    // completed without any verification is still what run.json says; only the handler lifetime matters here
    await main(["run", "--json", "task"], f.deps);
    assert.equal(f.installed(), 0);
    assert.throws(() => f.send("SIGINT"), /no signal handler/);
  });
});

test("--json carries run.json completion; human output shows one completion line", async () => {
  await withTemp(async (root) => {
    const f = signalFake(root, { status: "incomplete" });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.notCompleted);
    assert.deepEqual(JSON.parse(f.out()).completion, COMPLETION);
    const g = signalFake(root, { status: "incomplete" });
    await main(["run", "task"], g.deps);
    const lines = g.out().split("\n").filter((line) => line.startsWith("完成验收："));
    assert.equal(lines.length, 1, g.out());
    assert.match(lines[0]!, /未通过（incomplete，acceptance）.*续跑 1\/2/);
  });
});

test("E10: export fallback labels do not split inside parentheses", () => {
  const run = { schemaVersion: 1, runId: "run_t045", status: "incomplete", workspace: "/w", changes: [], verification: [], reasons: [], remaining: [], usage: {} } as unknown as RunJson;
  const loaded: LoadedRun = { dir: "/tmp/run_t045", text: "", run, task: null, summaryPresent: false };
  const receipt = (reason: string) => JSON.stringify({ receipt: { execution: { status: "executed", reason, evidence: [] } } });
  const text = [
    receipt("validation failed (shadow; not blocked): path escapes root; tool result error (exit code 1)"),
    receipt("validation failed (shadow, not blocked): x"),
  ].join("\n");
  const x = buildShareExport(loaded, text, { env: {}, home: "/nohome", cwd: "/", harnessRoot: "/", out: () => {}, err: () => {}, execFile: () => "" });
  assert.deepEqual(x.fallbackReasons.map((r) => r.label).sort(), [
    "tool result error (exit code 1)",
    "validation failed (shadow, not blocked)",
    "validation failed (shadow; not blocked)",
  ]);
});

test("T043 leftover: doctor probes the resolved runsDir (PI_JEV_RUNS_DIR, then harness.runsDir)", async () => {
  await withTemp(async (root) => {
    const base = { home: join(root, "home"), cwd: root, harnessRoot: join(root, "harness"), out: () => {}, err: () => {}, execFile: () => "0.87.1\n" };
    let out = "";
    const envRuns = join(root, "env-runs");
    await main(["doctor", "--json"], { ...base, env: { PI_JEV_RUNS_DIR: envRuns }, configPath: join(root, "none.json"), out: (t) => void (out += t) });
    assert.equal(JSON.parse(out).runsDir.path, envRuns);
    const cfgRuns = join(root, "cfg-runs");
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ harness: { runsDir: cfgRuns } }));
    out = "";
    await main(["doctor", "--json"], { ...base, env: {}, configPath, out: (t) => void (out += t) });
    assert.equal(JSON.parse(out).runsDir.path, cfgRuns);
    out = "";
    assert.equal(await main(["doctor", "--json"], { ...base, env: { PI_JEV_RUNS_DIR: "relative/runs" }, configPath, out: (t) => void (out += t) }), EXIT.ok);
    const probe = JSON.parse(out).runsDir;
    assert.equal(probe.writable, false);
    assert.match(probe.reason, /绝对路径/);
  });
});

test("E7: report shows the tool routing line from run.json; a legacy model part is ignored (T051)", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run_t045r");
    await mkdir(dir);
    await writeFile(join(dir, "run.json"), JSON.stringify({
      schemaVersion: 1, runId: "run_t045r", status: "incomplete", workspace: "/w", changes: [], verification: [], reasons: [], remaining: [], usage: {},
      routing: { tools: { outcome: "fallback", reason: "路由不可用：http_503" }, model: { outcome: "off" } },
      report: { dir, summary: "summary.md", receipts: "receipts.jsonl", artifacts: [] },
    }));
    let out = "";
    const code = await main(["report", dir], { env: {}, home: join(root, "home"), cwd: root, harnessRoot: root, out: (t) => void (out += t), err: () => {}, execFile: () => "" });
    assert.equal(code, EXIT.notCompleted);
    assert.match(out, /^路由：工具 已回退（路由不可用：http_503）$/m);
  });
});
