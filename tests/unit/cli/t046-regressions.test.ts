/**
 * T046 (host verification round 2): real Ctrl-C on `pi-jev run` during a bash tool. Pi 0.87.1 ends
 * the aborted turn with an assistant message `stopReason: "error"`, `errorMessage: "This operation
 * was aborted"`. run.json and the JSON result correctly say 用户取消, but the stderr progress stream
 * printed `[模型请求失败] This operation was aborted`, telling the user a provider failed when they
 * cancelled. Observed on the real host (runs cc1/cc2/cc3):
 *   [SIGINT] 正在取消会话并记录已产生的改动（再次中断将立即退出）
 *   [工具失败] bash
 *   [模型请求失败] This operation was aborted
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EXIT, main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession, RunSignal } from "../../../src/cli/context.ts";

test("T046: after SIGINT the progress stream does not label the aborted turn as 模型请求失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-t046-"));
  try {
    let out = "";
    let err = "";
    let handler: ((signal: RunSignal) => void) | null = null;
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    const config = join(root, "config.json");
    const deps: CliDeps = {
      env: {},
      home: join(root, "home"),
      cwd: root,
      configPath: config,
      harnessRoot: join(root, "harness"),
      out: (text) => void (out += text),
      err: (text) => void (err += text),
      execFile: () => { throw new Error("no spawn"); },
      abortGraceMs: 200,
      signals: { subscribe: (h) => { handler = h; return () => void (handler = null); }, exit: () => {} },
      createSession: async (opts) => {
        await writeFile(config, JSON.stringify({ mode: "shadow" }));
        const listeners: ((event: AgentSessionEvent) => void)[] = [];
        const emit = (event: unknown) => listeners.forEach((l) => l(event as AgentSessionEvent));
        let release: () => void = () => {};
        const session: RunSession = {
          subscribe: (l) => { listeners.push(l); return () => void listeners.splice(listeners.indexOf(l), 1); },
          prompt: async () => {
            emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: {} });
            started();
            await new Promise<void>((resolve) => (release = resolve));
            // What Pi 0.87.1 emits after session.abort() while bash runs (real host, T046).
            emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", isError: true, result: { content: [{ type: "text", text: "Command aborted" }] } });
            emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" } });
            const dir = join(opts.env.PI_JEV_RUNS_DIR!, opts.env.PI_JEV_RUN_ID!);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, "run.json"), JSON.stringify({
              schemaVersion: 1, runId: opts.env.PI_JEV_RUN_ID, status: "cancelled", workspace: opts.cwd,
              changes: [], verification: [],
              completion: { status: "not_assessed", stopAllowed: null, assessment: null, continuations: { used: 0, max: 2 } },
              reasons: ["用户取消：任务被中止（工具执行中收到中止）"], remaining: [], usage: {},
              report: { dir, summary: "summary.md", receipts: "receipts.jsonl", artifacts: [] },
            }));
            emit({ type: "agent_settled" });
          },
          waitForIdle: async () => {},
          abort: async () => release(),
          dispose: () => {},
        };
        return session;
      },
    };
    const code = main(["run", "--json", "run the tests"], deps);
    await running;
    assert.ok(handler, "signal handler installed");
    (handler as (signal: RunSignal) => void)("SIGINT");
    assert.equal(await code, EXIT.notCompleted);
    assert.equal(JSON.parse(out).status, "cancelled");
    assert.doesNotMatch(err, /模型请求失败/, `a user cancel is not reported as a model request failure:\n${err}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
