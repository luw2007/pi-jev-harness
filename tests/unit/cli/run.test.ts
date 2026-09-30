import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EXIT, main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession, RunSessionOptions } from "../../../src/cli/context.ts";
import { parseDuration } from "../../../src/cli/run.ts";
import type { TaskStatus } from "../../../src/harness/index.ts";

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-run-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface FakeOptions {
  /** run.json status the fake extension writes; null writes nothing. */
  status?: TaskStatus | null;
  promptError?: Error;
  createError?: Error;
  /** prompt() never resolves until abort() is called. */
  hang?: boolean;
  /** Assistant `errorMessage`s emitted as failed model requests (Pi retries), in order. */
  providerErrors?: string[];
  /** A successful assistant reply after the failed ones (Pi retry succeeded). */
  recovered?: boolean;
  /** run.json reasons; defaults to one generic reason for any status but completed. */
  reasons?: string[];
}

interface Fake {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  calls: RunSessionOptions[];
  prompts: string[];
  disposed: () => number;
  aborted: () => number;
}

function fake(root: string, options: FakeOptions = {}, overrides: Partial<CliDeps> = {}): Fake {
  let out = "";
  let err = "";
  let disposed = 0;
  let aborted = 0;
  const calls: RunSessionOptions[] = [];
  const prompts: string[] = [];
  // run.json only exists in shadow; tests of off mode pass their own configPath.
  const shadowConfig = join(root, "shadow-config.json");
  writeFileSync(shadowConfig, JSON.stringify({ mode: "shadow" }));
  const deps: CliDeps = {
    env: {},
    home: join(root, "home"),
    cwd: root,
    configPath: shadowConfig,
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    execFile: () => {
      throw new Error("run must not spawn processes");
    },
    createSession: async (opts) => {
      calls.push(opts);
      if (options.createError) throw options.createError;
      const listeners: ((event: AgentSessionEvent) => void)[] = [];
      const emit = (event: unknown) => listeners.forEach((l) => l(event as AgentSessionEvent));
      let release: () => void = () => {};
      const session: RunSession = {
        subscribe: (listener) => {
          listeners.push(listener);
          return () => void listeners.splice(listeners.indexOf(listener), 1);
        },
        prompt: async (text) => {
          prompts.push(text);
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
          emit({ type: "tool_execution_start", toolName: "edit", toolCallId: "t1", args: {} });
          if (options.hang) await new Promise<void>((resolve) => (release = resolve));
          if (options.promptError) throw options.promptError;
          for (const errorMessage of options.providerErrors ?? []) {
            emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } });
            emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: errorMessage });
          }
          if (options.recovered) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
          const status = options.status === undefined ? "completed" : options.status;
          if (status !== null) {
            const dir = join(opts.env.PI_JEV_RUNS_DIR!, opts.env.PI_JEV_RUN_ID!);
            await mkdir(dir, { recursive: true });
            await writeFile(
              join(dir, "run.json"),
              JSON.stringify({
                schemaVersion: 1,
                runId: opts.env.PI_JEV_RUN_ID,
                status,
                workspace: opts.cwd,
                changes: [{ path: "src/a.ts", change: "modified" }],
                verification: [{ name: "unit", status: status === "completed" ? "passed" : "not_run", evidenceRefs: [] }],
                reasons: options.reasons ?? (status === "completed" ? [] : ["还缺回归测试"]),
                remaining: status === "completed" ? [] : ["补回归测试"],
                usage: {},
                report: { dir, summary: "summary.md", receipts: "receipts.jsonl", artifacts: [] },
              }),
            );
          }
          emit({ type: "agent_settled" });
        },
        waitForIdle: async () => {},
        abort: async () => {
          aborted++;
          release();
        },
        dispose: () => void disposed++,
      };
      return session;
    },
    ...overrides,
  };
  return { deps, out: () => out, err: () => err, calls, prompts, disposed: () => disposed, aborted: () => aborted };
}

test("run: completed run.json exits 0 with script-readable fields", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    const code = await main(["run", "--json", "fix", "the", "pager"], f.deps);
    assert.equal(code, EXIT.ok);
    const result = JSON.parse(f.out());
    assert.match(result.runId, /^run_[0-9a-f-]{36}$/);
    assert.equal(result.status, "completed");
    assert.equal(result.workspace, root);
    assert.deepEqual(result.changes, [{ path: "src/a.ts", change: "modified" }]);
    assert.equal(result.verification[0].status, "passed");
    assert.equal(result.report, join(root, "home", ".pi", "agent", "pi-jev-harness", "runs", result.runId));
    assert.equal(result.sessionError, null);
    assert.deepEqual(f.prompts, ["fix the pager"], "the task is sent exactly once");
    assert.equal(f.disposed(), 1);
    assert.match(f.err(), /working/);
    assert.match(f.err(), /\[工具\] edit/);
  });
});

test("run: env given to the session carries PI_JEV_RUN_ID and PI_JEV_RUNS_DIR", async () => {
  await withTemp(async (root) => {
    const ws = join(root, "ws");
    await mkdir(ws);
    const runs = join(root, "custom-runs");
    const f = fake(root, {}, { env: { PI_JEV_RUNS_DIR: runs, KEEP: "1" } });
    const code = await main(["run", "--cwd", "ws", "--json", "task"], f.deps);
    assert.equal(code, EXIT.ok);
    const result = JSON.parse(f.out());
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.cwd, ws);
    assert.equal(f.calls[0]!.env.PI_JEV_RUN_ID, result.runId);
    assert.equal(f.calls[0]!.env.PI_JEV_RUNS_DIR, runs);
    assert.equal(f.calls[0]!.env.KEEP, "1");
    assert.equal(f.calls[0]!.extensionPath, join(root, "harness", "src", "adapters", "pi", "index.ts"));
    assert.equal(result.report, join(runs, result.runId));
  });
});

test("run: config harness.runsDir is used when PI_JEV_RUNS_DIR is unset", async () => {
  await withTemp(async (root) => {
    const runs = join(root, "cfg-runs");
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ harness: { runsDir: runs } }));
    const f = fake(root, {}, { configPath });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.ok);
    assert.equal(f.calls[0]!.env.PI_JEV_RUNS_DIR, runs);
  });
});

test("run: incomplete run.json exits 2 and shows reasons", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { status: "incomplete" });
    assert.equal(await main(["run", "task"], f.deps), EXIT.notCompleted);
    assert.match(f.out(), /状态：已结束，仍未完成（incomplete）/);
    assert.match(f.out(), /还缺回归测试/);
  });
});

test("run: missing run.json is artifacts_missing and exits 1, never completed", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { status: null });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.equal(result.status, "artifacts_missing");
    assert.equal(result.sessionError, null);
    assert.ok(result.reasons.some((r: string) => r.includes("run.json")));
    assert.equal(f.disposed(), 1);
  });
});

test("run: missing --cwd directory exits 1 before creating a session", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    assert.equal(await main(["run", "--cwd", "nope", "task"], f.deps), EXIT.error);
    assert.equal(f.calls.length, 0);
    assert.match(f.err(), /工作区不存在/);
    assert.equal(f.out(), "");
  });
});

test("run: session prompt throwing exits 1 and still disposes", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { promptError: new Error("provider down") });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.equal(result.sessionError, "provider down");
    assert.equal(result.status, "artifacts_missing");
    assert.equal(f.disposed(), 1);
  });
});

test("run: session creation failing exits 1 with the error", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { createError: new Error("no model") });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.error);
    assert.match(JSON.parse(f.out()).sessionError, /no model/);
  });
});

test("run: --max-time aborts the session and reports the timeout", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { hang: true, status: "cancelled" });
    assert.equal(await main(["run", "--json", "--max-time", "20ms", "task"], f.deps), EXIT.notCompleted);
    const result = JSON.parse(f.out());
    assert.equal(result.timedOut, true);
    assert.equal(result.status, "cancelled");
    assert.equal(f.aborted(), 1);
    assert.equal(f.disposed(), 1);
  });
});

test("run: empty task or bad --max-time is a usage error without a session", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    assert.equal(await main(["run"], f.deps), EXIT.error);
    assert.equal(await main(["run", "--max-time", "soon", "task"], f.deps), EXIT.error);
    assert.equal(f.calls.length, 0);
  });
});

test("parseDuration: units and bare seconds", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("5"), 5_000);
  assert.throws(() => parseDuration("0s"));
  assert.throws(() => parseDuration("-1s"));
});

// T031 verifier regression: on the real host a --max-time abort left run.json `completed` and exited 0.
test("T031: a timed-out run never exits 0, whatever run.json says", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { hang: true, status: "completed" });
    const code = await main(["run", "--json", "--max-time", "20ms", "task"], f.deps);
    const result = JSON.parse(f.out());
    assert.equal(result.timedOut, true);
    assert.notEqual(code, EXIT.ok, "an aborted run is not a completed task");
  });
});

test("T035: a timed-out run whose run.json says completed is reported as cancelled in text output", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { hang: true, status: "completed" });
    assert.equal(await main(["run", "--max-time", "20ms", "task"], f.deps), EXIT.notCompleted);
    assert.match(f.out(), /命令行判定状态：.*（cancelled）/);
    assert.match(f.out(), /超过 --max-time 20ms/);
    assert.equal(f.disposed(), 1);
  });
});

test("T035: a task starting with / is a usage error before any session", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    assert.equal(await main(["run", "/jev mode off"], f.deps), EXIT.error);
    assert.equal(await main(["run", "--", "  /jev", "mode off"], f.deps), EXIT.error);
    assert.equal(f.calls.length, 0);
    assert.match(f.err(), /不能以 \/ 开头/);
    assert.equal(f.out(), "");
  });
});

// T039: every model request failed; off mode writes nothing by design.
const SECRET = "sk-proj-ABCDEFGH12345678abcdefgh";

test("T039: run.json status failed exits 1 and shows the adapter's failure reason", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { status: "failed", reasons: ["模型请求失败：503 resource_pressure"], providerErrors: ["503 resource_pressure"] });
    assert.equal(await main(["run", "task"], f.deps), EXIT.error);
    assert.match(f.out(), /状态：执行失败/);
    assert.match(f.out(), /模型请求失败：503 resource_pressure/);
    const g = fake(root, { status: "failed", reasons: ["模型请求失败：503"] });
    assert.equal(await main(["run", "--json", "task"], g.deps), EXIT.error);
    assert.equal(JSON.parse(g.out()).status, "failed");
  });
});

test("T039: shadow, no run.json, provider errors: artifacts_missing with the scrubbed provider error as sessionError", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { status: null, providerErrors: [`401 Incorrect API key provided: ${SECRET}`, "503 resource_pressure"] });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.equal(result.status, "artifacts_missing");
    assert.equal(result.sessionError, "503 resource_pressure", "the last provider error");
    assert.ok(result.reasons.includes("模型请求失败：503 resource_pressure"), JSON.stringify(result.reasons));
    assert.ok(result.reasons.some((r: string) => r.includes("run.json")), JSON.stringify(result.reasons));
    assert.ok(!f.out().includes("sk-proj-") && !f.err().includes("sk-proj-"), "no key reaches stdout or stderr");
    assert.match(f.err(), /\[模型请求失败\] 401 Incorrect API key provided: \[已移除：疑似凭据\]/);

    const h = fake(root, { status: null, providerErrors: [`401 Incorrect API key provided: ${SECRET}`] });
    assert.equal(await main(["run", "task"], h.deps), EXIT.error);
    assert.match(h.out(), /artifacts_missing/);
    assert.match(h.out(), /模型请求失败：401 Incorrect API key provided: \[已移除：疑似凭据\]/);
    assert.ok(!h.out().includes("sk-proj-"));
  });
});

test("T039: a provider error followed by a successful reply (Pi retry) is not a session error", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { status: null, providerErrors: ["503"], recovered: true });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.equal(result.status, "artifacts_missing");
    assert.equal(result.sessionError, null);
  });
});

test("T039: effective mode off (no config, or invalid config) without run.json is native_off, exit 2", async () => {
  await withTemp(async (root) => {
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, "{ not json");
    for (const configPath of [join(root, "missing.json"), invalid]) {
      const f = fake(root, { status: null }, { configPath });
      assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.notCompleted, configPath);
      const result = JSON.parse(f.out());
      assert.equal(result.status, "native_off");
      assert.equal(result.sessionError, null);
      assert.deepEqual(result.reasons, ["Jev 增强关闭，未记录运行产物"]);
    }
    const g = fake(root, { status: null }, { configPath: join(root, "missing.json") });
    assert.equal(await main(["run", "task"], g.deps), EXIT.notCompleted);
    assert.match(g.out(), /状态：Jev 增强关闭，未记录运行产物（native_off）/);
    assert.doesNotMatch(g.out(), /artifacts_missing|报告位置/);
  });
});

test("T039: mode off with provider errors is native_off carrying the scrubbed provider error, exit 1", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { status: null, providerErrors: [`503 upstream; token=${SECRET}`] }, { configPath: join(root, "missing.json") });
    assert.equal(await main(["run", "--json", "task"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.equal(result.status, "native_off");
    assert.equal(result.sessionError, "503 upstream; [已移除：疑似凭据]");
    assert.deepEqual(result.reasons, ["Jev 增强关闭，未记录运行产物", "模型请求失败：503 upstream; [已移除：疑似凭据]"]);
    const g = fake(root, { status: null, providerErrors: ["503 resource_pressure"] }, { configPath: join(root, "missing.json") });
    assert.equal(await main(["run", "task"], g.deps), EXIT.error);
    assert.match(g.out(), /native_off/);
    assert.match(g.out(), /模型请求失败：503 resource_pressure/);
  });
});
