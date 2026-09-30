/**
 * `pi-jev run`: start ONE Pi session in an explicit workspace with the pi-jev extension, send the
 * task once, stream terse progress to stderr, wait until Pi settles, dispose, then read the run
 * products the extension wrote. It is not an agent loop: it never re-prompts.
 *
 * The task outcome comes only from `<runsDir>/<runId>/run.json`. Without it the status is
 * `native_off` when the adapter's effective mode is off (it writes nothing by design; the CLI
 * learns the mode from the same config loader and environment the extension uses), otherwise
 * `artifacts_missing` (task status unknown); never `completed`. A provider error seen on the
 * session events (every model request failed) is reported, credentials scrubbed, as `sessionError`.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, readJevKey } from "../adapters/pi/config.ts";
import { MAX_OUTCOME_DETAIL_CHARS, MODEL_FAILURE_STAGE, scrubCredentials } from "../adapters/pi/harness.ts";
import { RUN_FILES, TASK_STATUS_LABELS, type RunJson, type TaskStatus } from "../harness/index.ts";
import { CliError, readOptional, resolveRunsDir, type CliDeps, type RunSession, type RunSignal } from "./context.ts";
import { loadRun, renderRun, type LoadedRun } from "./report.ts";

export type RunStatus = TaskStatus | "artifacts_missing" | "native_off";

/** Reason of a `native_off` run: the adapter was off, so no run products exist. */
export const NATIVE_OFF_REASON = "Jev 增强关闭，未记录运行产物";

/** Script-readable result of `pi-jev run --json`. */
export interface RunResult {
  runId: string;
  /**
   * From `run.json`; without it `native_off` when the adapter's effective mode is off, else
   * `artifacts_missing` (absent or unreadable; task status unknown); `cancelled` when
   * `--max-time` aborted the session and `run.json` still says `completed`.
   */
  status: RunStatus;
  workspace: string;
  changes: RunJson["changes"];
  verification: RunJson["verification"];
  verificationWaiver?: RunJson["verificationWaiver"];
  /** Structured completion state from `run.json` (T036); null without it or when the adapter recorded none. */
  completion: NonNullable<RunJson["completion"]> | null;
  /** Routing outcomes from `run.json` (T045); omitted when absent. */
  routing?: RunJson["routing"];
  /** Blocking, failure, or stop reasons from `run.json`, then the CLI's own (timeout, session error, cleanup warnings, missing products). */
  reasons: string[];
  remaining: string[];
  /** Run directory (`summary.md`, `run.json`, `receipts.jsonl`); null for `native_off`, which writes none. */
  report: string | null;
  /**
   * Session start/prompt failure; without `run.json`, else the last provider error of a model
   * request (credentials scrubbed). The command exits 1 when set.
   */
  sessionError: string | null;
  /** `--max-time` elapsed and the session was aborted. */
  timedOut: boolean;
  /** SIGINT/SIGTERM received during the run (the session was aborted); null otherwise. */
  interrupted: RunSignal | null;
}

export interface RunOutcome {
  result: RunResult;
  loaded: LoadedRun | null;
  /** `--json` was given. */
  json: boolean;
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** `--max-time`: a positive number with unit ms/s/m/h; a bare number is seconds. */
export function parseDuration(text: string): number {
  const match = DURATION.exec(text.trim());
  const ms = match ? Number(match[1]) * UNIT_MS[(match[2] ?? "s") as keyof typeof UNIT_MS] : Number.NaN;
  if (!(ms > 0) || !Number.isFinite(ms)) throw new CliError(`--max-time 无法识别：${text}（示例：90s、10m、1h）`);
  return Math.round(ms);
}

/**
 * `aborted()`: the CLI itself aborted the session (signal or `--max-time`). Pi then ends the turn
 * with stopReason `error` ("This operation was aborted"); that is the cancel, not a model failure.
 */
function progress(deps: CliDeps, scrub: (text: string) => string, aborted: () => boolean): (event: AgentSessionEvent) => void {
  let midLine = false;
  const line = (text: string) => {
    deps.err(`${midLine ? "\n" : ""}${text}\n`);
    midLine = false;
  };
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deps.err(event.assistantMessageEvent.delta);
      midLine = !event.assistantMessageEvent.delta.endsWith("\n");
    } else if (event.type === "tool_execution_start") line(`[工具] ${event.toolName}`);
    else if (event.type === "tool_execution_end" && event.isError) line(`[工具失败] ${event.toolName}`);
    else if (event.type === "agent_settled") line("[会话已结束]");
    else if (event.type === "message_end") {
      const failure = providerFailure(event.message);
      if (failure) line(`[${aborted() ? "已中止" : MODEL_FAILURE_STAGE}] ${scrub(failure)}`);
    }
  };
}

/** The provider error of a failed assistant message; undefined for any other message. */
function providerFailure(message: unknown): string | undefined {
  const m = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (m.role !== "assistant" || m.stopReason !== "error") return undefined;
  return typeof m.errorMessage === "string" && m.errorMessage ? m.errorMessage : "stopReason error";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface DriveResult {
  /** Prompt or abort failure (credentials scrubbed); null when the session ran to its settled end (or was aborted on timeout or signal). */
  sessionError: string | null;
  /** Unsubscribe/dispose failures after the run; they never replace the session outcome. */
  cleanupWarnings: string[];
  /** Last provider error (raw); cleared by a later successful assistant message (Pi retry). */
  providerError: string | null;
  /** `--max-time` elapsed and the session was aborted. */
  timedOut: boolean;
  /** First SIGINT/SIGTERM received during the run; the session was aborted. */
  interrupted: RunSignal | null;
  /** After the abort the session did not settle within the grace period. */
  graceExpired: boolean;
}

const DEFAULT_ABORT_GRACE_MS = 10_000;
/** Conventional exit code of a process ended by a second interrupt. */
const SECOND_SIGNAL_EXIT = 130;

/**
 * Drive one session to its settled end. `--max-time` or the first SIGINT/SIGTERM aborts it through
 * the SDK's `abort()`, then waits at most `abortGraceMs` for it to settle (the adapter writes the
 * cancelled run.json at `agent_settled`); a second signal exits at once with 130. Signal handlers
 * live only while the session runs. Always unsubscribes and disposes, each independently.
 */
async function drive(session: RunSession, task: string, maxMs: number | undefined, deps: CliDeps, scrub: (text: string) => string): Promise<DriveResult> {
  let aborting: Promise<void> | undefined;
  const show = progress(deps, scrub, () => aborting !== undefined);
  let providerError: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && (event.message as { role?: unknown }).role === "assistant") {
      const failure = providerFailure(event.message);
      // A turn ended by our own abort is the cancel, not a provider error.
      if (failure !== undefined) {
        if (aborting === undefined) providerError = failure;
      }
      else if ((event.message as { stopReason?: unknown }).stopReason !== "aborted") providerError = null;
    } else if (event.type === "auto_retry_end" && !event.success && event.finalError) providerError = event.finalError;
    show(event);
  });
  let timedOut = false;
  let interrupted: RunSignal | null = null;
  let abortError: string | null = null;
  let promptError: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let expire: () => void = () => {};
  const grace = new Promise<"expired">((resolve) => (expire = () => resolve("expired")));
  const abort = () => {
    if (aborting) return;
    graceTimer = setTimeout(expire, deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
    aborting = session.abort().then(
      () => undefined,
      (error: unknown) => void (abortError = `中止会话失败：${scrub(message(error))}`),
    );
  };
  const timer =
    maxMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          deps.err("[超时] 超过 --max-time，正在中止会话\n");
          abort();
        }, maxMs);
  const removeSignals = deps.signals?.subscribe((signal) => {
    if (interrupted !== null) {
      deps.err(`[${signal}] 再次收到中断，立即退出\n`);
      deps.signals!.exit(SECOND_SIGNAL_EXIT);
      return;
    }
    interrupted = signal;
    deps.err(`[${signal}] 正在取消会话并记录已产生的改动（再次中断将立即退出）\n`);
    abort();
  });
  // prompt() resolves after the run; waitForIdle() also covers settle-time continuations.
  const running = (async () => {
    await session.prompt(task);
    await session.waitForIdle();
  })();
  let graceExpired = false;
  try {
    graceExpired = (await Promise.race([running, grace])) === "expired";
  } catch (error) {
    // After an abort (timeout or signal) the rejected prompt is the expected end, not a session failure.
    if (aborting === undefined) promptError = scrub(message(error));
  } finally {
    clearTimeout(timer);
    removeSignals?.();
  }
  if (graceExpired) running.catch(() => undefined);
  // The session may settle before the abort call itself fails; wait (bounded) so that failure is reported.
  else if (aborting) graceExpired = (await Promise.race([aborting, grace])) === "expired";
  clearTimeout(graceTimer);
  const sessionError = promptError ?? abortError;
  const cleanupWarnings: string[] = [];
  try {
    unsubscribe();
  } catch (error) {
    cleanupWarnings.push(`清理警告：取消会话订阅失败：${message(error)}`);
  }
  try {
    session.dispose();
  } catch (error) {
    cleanupWarnings.push(`清理警告：释放 Pi 会话失败：${message(error)}`);
  }
  return { sessionError, cleanupWarnings, providerError, timedOut, interrupted, graceExpired };
}

export async function runTask(argv: readonly string[], deps: CliDeps): Promise<RunOutcome> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { cwd: { type: "string" }, json: { type: "boolean" }, "max-time": { type: "string" } },
  });
  const task = positionals.join(" ").trim();
  if (task.length === 0) throw new CliError("缺少任务描述：pi-jev run [--cwd <目录>] <任务>");
  // Pi would run a leading "/" as an extension or prompt-template command, not as the task.
  if (task.startsWith("/")) throw new CliError(`任务不能以 / 开头（Pi 会把它当作命令执行，而不是任务）：${task}`);
  const maxMs = values["max-time"] === undefined ? undefined : parseDuration(values["max-time"]);
  const workspace = resolve(deps.cwd, values.cwd ?? ".");
  const info = await stat(workspace).catch(() => null);
  if (!info?.isDirectory()) throw new CliError(`工作区不存在或不是目录：${workspace}`);
  if (!deps.createSession) throw new CliError("当前环境没有可用的 Pi 会话，无法执行 run。");

  const runsDir = await resolveRunsDir(deps);
  const runId = `run_${randomUUID()}`;
  const dir = join(runsDir, runId);
  const reasons: string[] = [];
  let timedOut = false;
  let interrupted: RunSignal | null = null;
  let graceExpired = false;
  let sessionError: string | null = null;
  let cleanupWarnings: string[] = [];
  let providerError: string | null = null;
  const env = { ...deps.env, PI_JEV_RUN_ID: runId, PI_JEV_RUNS_DIR: runsDir };
  const jevKey = readJevKey(deps.env);
  const scrub = (text: string) => scrubCredentials(text, jevKey).slice(0, MAX_OUTCOME_DETAIL_CHARS);
  deps.err(`运行编号：${runId}\n工作区：${workspace}\n`);
  let session: RunSession | null = null;
  try {
    session = await deps.createSession({ cwd: workspace, env, extensionPath: join(deps.harnessRoot, "src", "adapters", "pi", "index.ts") });
  } catch (error) {
    sessionError = `启动 Pi 会话失败：${scrub(message(error))}`;
  }
  if (session !== null)
    ({ sessionError, cleanupWarnings, providerError, timedOut, interrupted, graceExpired } = await drive(session, task, maxMs, deps, scrub));
  if (timedOut) reasons.push(`超过 --max-time ${values["max-time"]}，会话已中止。`);
  if (interrupted !== null) reasons.push(`收到 ${interrupted}（用户取消），会话已中止。`);
  if (graceExpired) reasons.push(`中止后 ${Math.round((deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS) / 1000)}s 内会话未结束，没有等到运行产物。`);
  if (sessionError !== null) reasons.push(`会话失败：${sessionError}`);
  reasons.push(...cleanupWarnings);

  let loaded: LoadedRun | null = null;
  let nativeOff = false;
  if ((await readOptional(join(dir, RUN_FILES.run))) === null) {
    // Same loader, home and environment as the extension: its effective mode, without run products.
    nativeOff = (await loadConfig({ home: deps.home, path: deps.configPath, env })).config.mode === "off";
    reasons.push(nativeOff ? NATIVE_OFF_REASON : `产物不完整：${dir} 中没有 ${RUN_FILES.run}，任务状态未知。`);
    if (providerError !== null) {
      const text = scrub(providerError);
      reasons.push(`${MODEL_FAILURE_STAGE}：${text}`);
      sessionError ??= text;
    }
  } else {
    try {
      loaded = await loadRun(dir, deps);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      reasons.push(`${error.message}任务状态未知。`);
    }
  }
  const run = loaded?.run;
  // An aborted session cannot have finished its task, whatever run.json says.
  const abortedCompleted = (timedOut || interrupted !== null) && run?.status === "completed";
  if (abortedCompleted)
    reasons.push(`${RUN_FILES.run} 记录为 completed，但会话因${timedOut ? " --max-time " : `收到 ${interrupted} `}被中止：按 cancelled（已取消）处理。`);
  return {
    loaded,
    json: values.json === true,
    result: {
      runId,
      status: abortedCompleted ? "cancelled" : (run?.status ?? (nativeOff ? "native_off" : "artifacts_missing")),
      workspace,
      changes: run?.changes ?? [],
      verification: run?.verification ?? [],
      ...(run?.verificationWaiver ? { verificationWaiver: run.verificationWaiver } : {}),
      completion: run?.completion ?? null,
      ...(run?.routing ? { routing: run.routing } : {}),
      reasons: [...(run?.reasons ?? []), ...reasons],
      remaining: run?.remaining ?? [],
      report: nativeOff ? null : dir,
      sessionError,
      timedOut,
      interrupted,
    },
  };
}

export function renderRunResult({ result, loaded }: Pick<RunOutcome, "result" | "loaded">): string {
  const own = result.reasons.slice(loaded?.run.reasons?.length ?? 0);
  const overridden = loaded !== null && result.status !== loaded.run.status;
  const lines = loaded
    ? [
        ...(overridden ? [`命令行判定状态：${TASK_STATUS_LABELS[result.status as TaskStatus]}（${result.status}）：会话被中止（${result.timedOut ? "超时" : result.interrupted}），以下 ${RUN_FILES.run} 中的状态不作为结果`, ""] : []),
        renderRun(loaded).trimEnd(),
      ]
    : result.status === "native_off"
      ? [`状态：${NATIVE_OFF_REASON}（native_off）`, `运行编号：${result.runId}`, `工作区：${result.workspace}`]
      : [`状态：产物缺失，任务状态未知（artifacts_missing）`, `运行编号：${result.runId}`, `工作区：${result.workspace}`, "", `报告位置：${result.report}`];
  if (own.length > 0) lines.push("", "命令行结果", ...own.map((r) => `- ${r}`));
  return `${lines.join("\n")}\n`;
}
