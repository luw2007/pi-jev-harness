/**
 * One bench run: fresh workspace copy, isolated HOME/agent dir/run dir, `pi-jev run` through the
 * real CLI entry, then the task's acceptance command in the copy. Timing covers submission to the
 * end of acceptance. Nothing here touches the user's ~/.pi.
 */
import { spawn } from "node:child_process";
import { cp, glob, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchArm, BenchTask, Outcome, ResultRecord } from "./types.ts";

export interface ProcResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

/** Spawn argv with a hard kill timeout; never throws. */
export function runProc(argv: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ProcResult> {
  return new Promise((resolveProc) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveProc({ exit: null, stdout, stderr, timedOut, error: String(error) });
      return;
    }
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveProc({ exit: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveProc({ exit: code, stdout, stderr, timedOut, error: null });
    });
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@localhost",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@localhost",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const r = await runProc(["git", ...args], { cwd, env: { ...env, ...GIT_ENV }, timeoutMs: 120_000 });
  if (r.exit !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.error}`);
}

/** Fresh copy of the task's fixed start: fixture copy + fixed-date commit, or shared clone at a commit. */
export async function prepareWorkspace(task: BenchTask, fixturesDir: string, dest: string, env: NodeJS.ProcessEnv): Promise<void> {
  if ("fixture" in task.repo) {
    await cp(join(fixturesDir, task.repo.fixture), dest, { recursive: true });
    await git(["init", "-q", "-b", "main"], dest, env);
    await git(["add", "-A", "."], dest, env);
    await git(["commit", "-q", "-m", "fixture"], dest, env);
  } else {
    await git(["clone", "-q", "--shared", "--no-checkout", task.repo.git, dest], tmpdir(), env);
    await git(["checkout", "-q", "--detach", task.repo.commit], dest, env);
  }
}

/** Local fake Jev: every request gets 503 (unavailable) and is counted. */
export async function startFakeJev(): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    n++;
    req.resume();
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"bench fake jev: unavailable"}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/`, count: () => n, close: () => new Promise((ok) => server.close(() => ok())) };
}

export interface ModelSetup {
  /** Pi provider name. */
  provider: string;
  /** Model id as listed in the provider's `models`. */
  model: string;
  /** Provider block written to the temp agent dir's models.json. */
  providerBlock: Record<string, unknown>;
  thinking: string;
  /** Pi agent-level retry of transient provider errors; Pi's default is on. */
  retry: boolean;
  /** The model block carries pricing; without it Pi reports cost 0, which the bench records as unknown. */
  priced: boolean;
  /** Env the provider needs (resolved API key or the `$NAME` it references); only `pi-jev run` gets it. */
  env: Record<string, string>;
}

export interface RunContext {
  harnessRoot: string;
  fixturesDir: string;
  outDir: string;
  model: ModelSetup;
  jev: "fake" | "real";
  baseEnv: NodeJS.ProcessEnv;
}

/** Non-secret variables passed through to child processes; everything else is dropped. */
const ENV_ALLOW = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TZ"];

export function minimalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (base[k] !== undefined) out[k] = base[k];
  return out;
}

/** The CLI overrides a `completed` run.json to `cancelled` on SIGINT/SIGTERM (src/cli/run.ts); its --json output wins. */
export function cliCancelled(result: { status?: string; interrupted?: string | null } | null): boolean {
  return result?.status === "cancelled" || (result?.interrupted !== undefined && result.interrupted !== null);
}

export function outcomeOf(p: ProcResult, result: { status?: string; timedOut?: boolean; sessionError?: string | null; interrupted?: string | null } | null, runStatus: string | null): Outcome {
  if (p.error !== null && p.exit === null && !p.timedOut) return "spawn_error";
  if (p.timedOut || result?.timedOut || result?.status === "timed_out") return "timeout";
  if (cliCancelled(result)) return "cancelled";
  if (result?.sessionError) return "session_error";
  // mode off: the CLI reports native_off and writes no run.json; keep that category.
  if (runStatus === null) return result?.status === "native_off" ? "native_off" : "artifacts_missing";
  return runStatus as Outcome;
}

export interface SessionLogStats {
  /** Assistant messages, errored attempts included. */
  attempts: number;
  errors: number;
  /** Tool results flagged `isError`. */
  toolErrors: number;
  toolResults: number;
  /** Sums over attempts; null when any attempt lacks the figure. */
  input: number | null;
  output: number | null;
  cost: number | null;
  /** Attempts that carried a usage object. */
  usageKnown: number;
  /** Lines that were not valid JSON (e.g. truncated by a kill); skipped, counted. */
  malformed: number;
}

type LogEntry = { type?: string; message?: { role?: string; stopReason?: string; isError?: boolean; usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } } } };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse the run's Pi session logs; null when no log file exists. Malformed lines are skipped and counted. */
export async function readSessionLogs(sessionsDir: string): Promise<SessionLogStats | null> {
  const files: string[] = [];
  try {
    for await (const f of glob("**/*.jsonl", { cwd: sessionsDir })) files.push(join(sessionsDir, f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const s: SessionLogStats = { attempts: 0, errors: 0, toolErrors: 0, toolResults: 0, input: 0, output: 0, cost: 0, usageKnown: 0, malformed: 0 };
  const add = (key: "input" | "output" | "cost", v: number | null) => {
    s[key] = s[key] === null || v === null ? null : s[key]! + v;
  };
  for (const f of files.sort())
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let e: LogEntry;
      try {
        e = JSON.parse(line) as LogEntry;
      } catch {
        s.malformed++;
        continue;
      }
      if (e?.type !== "message" || !e.message) continue;
      const m = e.message;
      if (m.role === "toolResult") {
        s.toolResults++;
        if (m.isError === true) s.toolErrors++;
      }
      if (m.role !== "assistant") continue;
      s.attempts++;
      if (m.stopReason === "error") s.errors++;
      if (m.usage) s.usageKnown++;
      add("input", num(m.usage?.input));
      add("output", num(m.usage?.output));
      add("cost", num(m.usage?.cost?.total));
    }
  return s;
}

/** Assistant messages (including errored attempts) in the run's Pi session files; null when none were found. */
export async function countModelAttempts(sessionsDir: string): Promise<{ attempts: number; errors: number } | null> {
  const s = await readSessionLogs(sessionsDir);
  return s === null ? null : { attempts: s.attempts, errors: s.errors };
}

const figure = (value: number | null, known: number, sources: number) => ({ value, known, sources });

/** Replace `{taskDir}` in acceptance argv with the task file's directory (outside the agent's workspace). */
export function acceptanceArgv(task: BenchTask): string[] {
  return task.acceptance.map((a) => (task.taskDir ? a.replaceAll("{taskDir}", task.taskDir) : a));
}

export async function runOne(ctx: RunContext, task: BenchTask, arm: BenchArm, rep: number, order: number): Promise<ResultRecord> {
  const base = join(ctx.outDir, "runs", `${task.id}__${arm.id}__r${rep}`);
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "pi-jev-bench-"));
  let fake: Awaited<ReturnType<typeof startFakeJev>> | null = null;
  try {
    const home = join(scratch, "home");
    const agentDir = join(home, ".pi", "agent");
    const workspace = join(scratch, "ws");
    const runsDir = join(base, "products");
    await mkdir(join(agentDir, "pi-jev-harness"), { recursive: true });
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: ctx.model.provider, defaultModel: ctx.model.model, defaultThinkingLevel: ctx.model.thinking, ...(ctx.model.retry ? {} : { retry: { enabled: false } }) }, null, 2),
    );
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [ctx.model.provider]: ctx.model.providerBlock } }, null, 2));
    await writeFile(join(agentDir, "pi-jev-harness", "config.json"), JSON.stringify(arm.config, null, 2));
    const common: NodeJS.ProcessEnv = { ...minimalEnv(ctx.baseEnv), HOME: home };
    const env: NodeJS.ProcessEnv = { ...common, ...ctx.model.env, ...arm.env, PI_CODING_AGENT_DIR: agentDir, PI_JEV_RUNS_DIR: runsDir };
    if (ctx.jev === "fake") {
      fake = await startFakeJev();
      env.PI_JEV_URL = fake.url;
      env.TYPESAFE_API_KEY = "bench-fake-key";
    } else if (ctx.baseEnv.TYPESAFE_API_KEY) env.TYPESAFE_API_KEY = ctx.baseEnv.TYPESAFE_API_KEY;
    await prepareWorkspace(task, ctx.fixturesDir, workspace, common);

    const startedAt = new Date();
    const t0 = performance.now();
    const cli = join(ctx.harnessRoot, "src", "cli.ts");
    const p = await runProc([process.execPath, cli, "run", "--cwd", workspace, "--json", "--max-time", `${task.timeoutSec}s`, task.prompt], {
      cwd: workspace,
      env,
      timeoutMs: (task.timeoutSec + 60) * 1000,
    });
    const acc0 = performance.now();
    // Acceptance gets no provider or Jev secrets.
    const acc = await runProc(acceptanceArgv(task), { cwd: workspace, env: { ...common }, timeoutMs: 120_000 });
    const t1 = performance.now();
    const jevRequests = fake ? fake.count() : null;

    await writeFile(join(base, "cli.stdout.json"), p.stdout);
    await writeFile(join(base, "cli.stderr.log"), p.stderr);
    await writeFile(join(base, "acceptance.log"), `exit=${acc.exit} timedOut=${acc.timedOut}\n--- stdout\n${acc.stdout}\n--- stderr\n${acc.stderr}`);

    let result: { status?: string; timedOut?: boolean; sessionError?: string | null; interrupted?: string | null; report?: string | null } | null = null;
    try {
      result = JSON.parse(p.stdout);
    } catch {
      result = null;
    }
    let runJson: { status?: string; usage?: Record<string, { value: number | null } | undefined> } | null = null;
    if (result?.report) {
      try {
        runJson = JSON.parse(await readFile(join(result.report, "run.json"), "utf8"));
      } catch {
        runJson = null;
      }
    }
    const runStatus = cliCancelled(result) ? "cancelled" : typeof runJson?.status === "string" ? runJson.status : null;
    const log = await readSessionLogs(join(agentDir, "sessions"));
    const outcome = outcomeOf(p, result, runStatus);
    const timedOut = outcome === "timeout";
    const rj = runJson?.usage;
    const rjIn = rj?.input?.value ?? null;
    const rjOut = rj?.output?.value ?? null;
    return {
      taskId: task.id,
      category: task.category,
      arm: arm.id,
      rep,
      order,
      startedAt: startedAt.toISOString(),
      runStatus,
      outcome,
      cliExit: p.exit,
      timedOut,
      sessionError: result?.sessionError ?? p.error,
      acceptance: { exit: acc.exit, timedOut: acc.timedOut, durationMs: Math.round(t1 - acc0) },
      // A timed-out or cancelled run never counts as completed, whatever the workspace looks like.
      passed: acc.exit === 0 && !timedOut && outcome !== "cancelled",
      durationMs: Math.round(t1 - t0),
      usage: log
        ? {
            costUsd: figure(ctx.model.priced ? log.cost : null, ctx.model.priced && log.cost !== null ? log.attempts : 0, log.attempts),
            input: figure(log.input, log.usageKnown, log.attempts),
            output: figure(log.output, log.usageKnown, log.attempts),
          }
        : null,
      usageCrossCheck:
        rj && log ? { runJsonInput: rjIn, runJsonOutput: rjOut, match: rjIn === null || rjOut === null ? null : rjIn === log.input && rjOut === log.output } : null,
      invalidToolCalls: log ? log.toolErrors : null,
      jevRequests,
      modelAttempts: log?.attempts ?? null,
      modelErrors: log?.errors ?? null,
      malformedLogLines: log?.malformed ?? null,
      runDir: base,
    };
  } finally {
    await fake?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
