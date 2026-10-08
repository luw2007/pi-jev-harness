/**
 * Request-level context reduction for the Pi adapter (technical §8, §9.2, §10; product §7.4).
 *
 * Pi 0.87.1 `context` event (dist/core/extensions/types.d.ts, runner.js `emitContext`): fired
 * before each LLM call with `{ type: "context", messages }`, the conversation WITHOUT system
 * messages (Pi restores the prompt and tool state itself). A handler returns
 * `ContextEventResult { messages? }`; returning undefined and not editing `event.messages` in place
 * leaves the request unchanged. Pi passes a structured clone, so the persistent session is never
 * touched here, and this module never edits `event.messages` in place.
 *
 * Effective state = session mode × `context.request`:
 * - off (either is off): nothing is computed, nothing is sent.
 * - shadow: the reducer runs in the background (one at a time per session) and its decisions and
 *   stats are recorded; the handler returns undefined immediately, so the request is the original.
 *   Archives are really written, because a cached drop decision carries its handle and must stay
 *   valid if the session later switches to on.
 * - on (session mode on AND context.request on): the reduced messages are returned only when the
 *   reducer changed something and every archive write succeeded; any other outcome (Jev failure,
 *   budget, credential, cancel/timeout, spill failure) returns undefined, i.e. the originals.
 *
 * Outbound gate: Jev is asked only when `outbound.taskIntent` is true, a key is present, the state
 * (history text) carries no credential shape, and the per-task request budget
 * (`budget.maxRequestsPerTask`, separate counter from routing) is not spent. Otherwise no request
 * is sent and the reason is recorded. The remaining budget is handed to the reducer as its ask cap,
 * so a history needing more asks than are left is reduced partially: answers already paid for and
 * cached decisions still apply, the rest stays verbatim (T041 defect 4). Only a reduction that
 * changed nothing because the budget ran out is reported as a budget fallback.
 *
 * Task revision: each user task (`startTask`, i.e. `before_agent_start`) is a new cache revision,
 * so decisions made for an earlier task are never reused; requests within one task (follow-up
 * turns, tool results, continuations) share the revision and reuse their decisions (M4).
 *
 * Persistent summary replacement (`session_before_compact`) is a separate switch that stays off:
 * nothing here registers it.
 *
 * Run artifacts: the harness run directory is private to `./harness.ts`, so per-event receipt
 * lines go to `<storeDir>/<sessionId>/context.jsonl` and the per-task summary to
 * `<storeDir>/<sessionId>/context.json` (spill.ts ignores non-digest names). Follow-up: move them
 * into the run record once the harness exposes an artifacts extension point.
 */
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import type { HostToolResult } from "../core/port.ts";
import {
  createContextReducer,
  recall,
  storePayload,
  type ContextAsk,
  type ContextLimits,
  type ContextReducer,
  type PiMessage,
  type RecallErrorReason,
  type ReduceOutput,
  type SpillFs,
} from "../../context/index.ts";
import { TYPESAFE_PROFILE, type JevAttempt, type JevClient, type JevErrorKind, type JevProfile } from "../../jev/index.ts";
import type { TelemetryInput, TelemetryOutcome } from "../../telemetry/index.ts";
import { containsCredential, type AdapterConfig, type AdapterMode } from "./config.ts";
import { attemptTokens, createJevAccess, type JevAccess } from "../shared/jev-access.ts";

export const RECALL_TOOL = "jev_recall";

/** Parameters of `jev_recall`: a handle only, never a path. Plain JSON Schema (see host.ts). */
export const RECALL_PARAMETERS = {
  type: "object",
  properties: {
    handle: {
      type: "string",
      description: 'The handle from a "[jev spill: …]" notice in this session, e.g. spill:<session>:<sha256>. Paths are not accepted.',
    },
  },
  required: ["handle"],
  additionalProperties: false,
} as const;

export const CONTEXT_DISABLED_MESSAGE = "jev_recall：上下文裁剪未启用（context.request=off），没有可恢复的存档";

const RECALL_ERRORS: Record<RecallErrorReason, string> = {
  invalid_handle: "handle 格式无效，只接受 spill:<session>:<sha256>，不接受路径",
  foreign_session: "handle 属于其他会话，拒绝读取",
  invalid_session: "当前会话 id 不能用于存档",
  invalid_dir: "存档目录配置无效",
  not_found: "找不到该存档",
  corrupted: "存档内容校验失败",
  io_error: "读取存档失败",
};

/** Same rule as spill.ts: the session id names a directory below `storeDir`. */
const SESSION_RE = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;

export interface ContextHookDeps {
  /** Jev endpoint(s) and credential-scan secrets; default: from `config` (single-url unless `jev.providers`). */
  jev?: JevAccess;
  config: AdapterConfig;
  /** Session run id (`run_<uuid>`) stamped on every telemetry record. */
  runId: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  /** Called before every physical Jev request. */
  onJevRequest: () => void;
  /** Telemetry sink of the host (kinds `context` and `jev_attempt`). */
  record: (event: TelemetryInput) => void;
  /** Called with each on-mode fallback reason (the host lists it under `fallback reasons`). */
  onFallback?: (reason: string) => void;
  /** Archive filesystem; tests inject failures. */
  fs?: SpillFs;
  /** Extra reducer limits (OMP legacy tunables); Pi passes none. */
  limits?: Pick<ContextLimits, "keepThreshold">;
  /** Jev model override (OMP `OMP_JEV_MODEL`); Pi passes none. */
  model?: JevProfile["model"];
}

/**
 * Host-neutral view of the handler context this hook reads (T105 L4). Pi's `ExtensionContext`
 * satisfies it structurally; the OMP adapter builds one from its own context.
 */
export interface ContextHookCtx {
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(): ReadonlyArray<{ id?: string }>;
  };
  signal?: AbortSignal | undefined;
}

type Effective = "off" | "shadow" | "on";
type Withheld = "credential" | "budget";

interface TaskStats {
  task: number;
  events: number;
  /** Jev requests reserved by context in this task. */
  requests: number;
  candidates: number;
  /** Characters the latest computed reduction would save (shadow) or saved (on). */
  savable: number;
  /** Spill notices in the latest applied request. */
  applied: number;
  spillsOk: number;
  spillsFailed: number;
  recalls: number;
  /** Latest on-mode fallback; cleared by the next applied request. */
  fallback?: string;
  /** Error class of this task's latest failed Jev request; cleared by a successful one. */
  lastJevError?: JevErrorKind;
  /** Latest shadow note (why nothing was asked). */
  note?: string;
  last?: {
    reason: string;
    chars: { before: number; after: number };
    estimatedTokens: { before: number; after: number };
  };
}

interface Call {
  decisionId: string;
  withheld?: Withheld;
}

export interface PiContextHook {
  /** `context` handler; never throws, never edits `event.messages`. */
  handle<M>(event: { messages: M[] }, ctx: ContextHookCtx, mode: AdapterMode): Promise<{ messages: M[] } | undefined>;
  /** A new user task (`before_agent_start`): resets the per-task budget and stats. */
  startTask(): void;
  /** `jev_recall` execute: archived content of this session, or a thrown typed error. */
  recallTool(params: unknown, ctx: ContextHookCtx): Promise<HostToolResult>;
  statusLines(mode: AdapterMode): string[];
  /** Cancel in-flight reductions (mode off / shutdown). */
  abort(reason: string): void;
  /** Resolves when background reductions and artifact writes started so far are done. */
  settled(): Promise<void>;
}

export function createPiContextHook(deps: ContextHookDeps): PiContextHook {
  const { config } = deps;
  const settings = config.context;
  const fs = deps.fs ?? (nodeFs as unknown as SpillFs);
  const calls = new Map<AbortSignal, Call>();
  const inflight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const tasks: TaskStats[] = [];
  let task = newTask();
  let generation = 0;
  let branchNo = 0;
  let lastLeaf: string | null | undefined;
  let shadowBusy = false;
  let writes: Promise<void> = Promise.resolve();
  let sessionId: string | undefined;

  function newTask(): TaskStats {
    const next: TaskStats = { task: tasks.length + 1, events: 0, requests: 0, candidates: 0, savable: 0, applied: 0, spillsOk: 0, spillsFailed: 0, recalls: 0 };
    tasks.push(next);
    return next;
  }

  // C9: the `toolContext` chain. Pi (no legacy mapping) stays single-url unless `jev.providers` is set.
  const jev = deps.jev ?? createJevAccess({ config, env: deps.env });
  const client: JevClient | undefined = jev.client("toolContext", {
    fetch: (input, init) => {
      deps.onJevRequest();
      return deps.fetch(input, init);
    },
    now: deps.now,
    newId: () => `att_${deps.newId()}`,
    waitMs: config.budget.waitMs,
    ...(deps.model ? { model: deps.model } : {}),
    onAttempt: (attempt: JevAttempt) =>
      deps.record({ runId: deps.runId, decisionId: attempt.decisionId, attemptId: attempt.attemptId, kind: "jev_attempt",
        outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}`, ...attemptTokens(attempt) }),
  });

  // The reducer's ask is fixed at construction; per-call data rides on the abort signal.
  const ask: ContextAsk = async (request) => {
    const call = request.signal ? calls.get(request.signal) : undefined;
    if (!call || !client) return { ok: false, error: { kind: "invalid_request" } };
    let text: string;
    try {
      text = JSON.stringify(request.state);
    } catch {
      return { ok: false, error: { kind: "invalid_request" } };
    }
    if (containsCredential(text, jev.secrets)) {
      call.withheld = "credential";
      return { ok: false, error: { kind: "invalid_request" } };
    }
    // Backstop only: the reducer is capped at the remaining budget (`maxAsks`) before it asks.
    if (task.requests >= config.budget.maxRequestsPerTask) {
      call.withheld = "budget";
      return { ok: false, error: { kind: "invalid_request" } };
    }
    const current = task;
    current.requests++;
    const result = await client.noul(request.questions, { decisionId: call.decisionId, state: request.state, ...(request.signal ? { signal: request.signal } : {}) });
    // Our own cancel says nothing about Jev's availability.
    if (result.ok) delete current.lastJevError;
    else if (result.error.kind !== "aborted") current.lastJevError = result.error.kind;
    return result;
  };

  const reducer: ContextReducer = createContextReducer({
    ask,
    store: (content, id) =>
      storePayload(settings.storeDir, content, {
        sessionId: id,
        ...(settings.limits.maxPayloadBytes !== undefined ? { maxPayloadBytes: settings.limits.maxPayloadBytes } : {}),
        ...(settings.limits.maxSessionBytes !== undefined ? { maxSessionBytes: settings.limits.maxSessionBytes } : {}),
        fs,
      }),
    clock: deps.now,
    limits: {
      ...(settings.limits.recentTurns !== undefined ? { recentTurns: settings.limits.recentTurns } : {}),
      ...(settings.limits.minChars !== undefined ? { minChars: settings.limits.minChars } : {}),
      ...(deps.limits?.keepThreshold !== undefined ? { keepThreshold: deps.limits.keepThreshold } : {}),
    },
    policyId: `${TYPESAFE_PROFILE.id}/${TYPESAFE_PROFILE.model}`,
  });

  function effective(mode: AdapterMode): Effective {
    if (mode === "off" || settings.request === "off") return "off";
    return mode === "on" && settings.request === "on" ? "on" : "shadow";
  }

  /** Why no Jev request may leave; undefined when asks are allowed. */
  function outboundBlock(): string | undefined {
    if (!config.outbound.taskIntent) return "outbound.taskIntent=false，不发请求";
    if (!client) return "Jev key missing，不发请求";
    return undefined;
  }

  /** Branch identity: a new id whenever the previous leaf is no longer on the current path. */
  function branchOf(ctx: ContextHookCtx): string {
    try {
      const manager = ctx.sessionManager;
      const leaf = manager.getLeafId();
      if (typeof lastLeaf === "string" && leaf !== lastLeaf && !manager.getBranch().some((entry) => entry.id === lastLeaf)) branchNo++;
      lastLeaf = leaf;
    } catch {
      // Unknown tree: keep the current branch id.
    }
    return `b${branchNo}`;
  }

  function queueWrite(write: () => Promise<void>): void {
    const next = writes.then(write).catch(() => {});
    writes = next;
  }

  function sessionDir(): string | undefined {
    return sessionId !== undefined && SESSION_RE.test(sessionId) ? join(settings.storeDir, sessionId) : undefined;
  }

  function summaryJson(): string {
    return `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      request: settings.request,
      summaryReplacement: settings.summaryReplacement,
      tasks: tasks.filter((t) => t.events > 0 || t.recalls > 0).map((t) => ({
        task: t.task,
        events: t.events,
        jevRequests: t.requests,
        candidates: t.candidates,
        spills: { ok: t.spillsOk, failed: t.spillsFailed },
        recalls: t.recalls,
        ...(t.fallback ? { fallback: t.fallback } : {}),
        // Characters are exact; token counts are fast-jev estimates, not billed tokens.
        ...(t.last ? { last: t.last } : {}),
      })),
    }, null, 2)}\n`;
  }

  function persist(line?: Record<string, unknown>): void {
    const dir = sessionDir();
    if (!dir) return;
    const summary = summaryJson();
    queueWrite(async () => {
      await nodeFs.mkdir(dir, { recursive: true, mode: 0o700 });
      if (line) await nodeFs.appendFile(join(dir, "context.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      await nodeFs.writeFile(join(dir, "context.json"), summary, { mode: 0o600 });
    });
  }

  function outcomeOf(out: ReduceOutput | undefined, call: Call, timedOut: boolean, fallback: string | undefined): TelemetryOutcome {
    if (call.withheld === "credential") return "withheld";
    if (call.withheld === "budget") return "unavailable";
    if (!out) return "error";
    if (out.reason === "jev_unavailable") return "unavailable";
    if (out.reason === "cancelled") return timedOut ? "timeout" : "skipped";
    if (out.reason === "stale_generation") return "skipped";
    return fallback ? "fallback" : "ok";
  }

  function fallbackOf(out: ReduceOutput | undefined, call: Call, timedOut: boolean, current: TaskStats): string | undefined {
    if (call.withheld === "credential") return "检测到凭据形态，未发送 Jev 请求";
    // T049: a budget spent on failed requests is a Jev outage, not normal use.
    if (call.withheld === "budget")
      return current.lastJevError ? `Jev 不可用（${current.lastJevError}），本任务 Jev 请求预算已被失败请求用完` : "本任务 Jev 请求预算已用完";
    if (!out) return "裁剪出错";
    if (out.reason === "jev_unavailable") return `Jev 不可用（${out.jevError ?? "unknown"}）`;
    if (out.reason === "cancelled") return timedOut ? "等待超时" : "已取消";
    if (out.reason === "stale_generation") return "请求已被更新的请求取代";
    if (out.stats.spillFailures > 0) return `存档失败 ${out.stats.spillFailures} 条，保留原文`;
    return undefined;
  }

  /** One reduction; returns the messages to send in on mode, else undefined. */
  async function run(messages: readonly PiMessage[], ctx: ContextHookCtx, eff: "shadow" | "on"): Promise<PiMessage[] | undefined> {
    const started = deps.now();
    const decisionId = `dec_${deps.newId()}`;
    const current = task;
    current.events++;
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("wait_budget");
    }, config.budget.waitMs);
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    const call: Call = { decisionId };
    calls.set(signal, call);
    let out: ReduceOutput | undefined;
    try {
      sessionId = ctx.sessionManager.getSessionId();
      out = await reducer.reduce({
        messages,
        sessionId,
        branchId: branchOf(ctx),
        generation: ++generation,
        revision: `task-${current.task}`,
        maxAsks: Math.max(0, config.budget.maxRequestsPerTask - current.requests),
        signal,
      });
    } catch {
      out = undefined;
    } finally {
      clearTimeout(timer);
      calls.delete(signal);
      controllers.delete(controller);
    }
    // The budget capped this reduce and nothing could be applied without the missing answers.
    if (out && !out.changed && !call.withheld && current.requests >= config.budget.maxRequestsPerTask
      && out.decisions.some((d) => d.reason === "unscored_budget")) call.withheld = "budget";

    const fallback = fallbackOf(out, call, timedOut, current);
    const sane = out !== undefined && out.messages.length === messages.length && out.messages.every((m, i) => m.role === messages[i]!.role);
    const applied = eff === "on" && out !== undefined && out.changed && fallback === undefined && sane;
    if (out) {
      current.candidates = out.stats.candidates;
      current.savable = Math.max(0, out.stats.chars.before - out.stats.chars.after);
      current.spillsOk += out.stats.spilled;
      current.spillsFailed += out.stats.spillFailures;
      current.last = { reason: out.reason, chars: { ...out.stats.chars }, estimatedTokens: { ...out.stats.estimatedTokens } };
    }
    if (eff === "on") {
      current.fallback = fallback;
      if (fallback) deps.onFallback?.(fallback);
      current.applied = applied ? out!.stats.spilled : 0;
    } else {
      current.note = fallback;
    }
    deps.record({ runId: deps.runId, decisionId, kind: "context", outcome: outcomeOf(out, call, timedOut, fallback), durationMs: deps.now() - started });
    persist({
      ts: deps.now(),
      decisionId,
      task: current.task,
      generation,
      effective: eff,
      applied,
      reason: out?.reason ?? "error",
      ...(fallback ? { fallback } : {}),
      ...(out?.jevError ? { jevError: out.jevError } : {}),
      durationMs: deps.now() - started,
      ...(out ? { stats: out.stats } : {}),
      // Identifiers and verdicts only; never message content.
      decisions: (out?.decisions ?? []).map(({ index, toolCallId, toolName, action, reason, source, keepResult, handle, spillError }) =>
        ({ index, toolCallId, toolName, action, reason, ...(source ? { source } : {}), ...(keepResult !== undefined ? { keepResult } : {}),
          ...(handle ? { handle } : {}), ...(spillError ? { spillError } : {}) })),
    });
    return applied ? [...(out!.messages as PiMessage[])] : undefined;
  }

  function track(promise: Promise<void>): void {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  }

  return {
    async handle(event, ctx, mode) {
      const eff = effective(mode);
      if (eff === "off") return undefined;
      const block = outboundBlock();
      if (block) {
        task.events++;
        if (eff === "on") {
          task.fallback = block;
          deps.onFallback?.(block);
        } else task.note = block;
        deps.record({ runId: deps.runId, decisionId: `dec_${deps.newId()}`, kind: "context", outcome: config.outbound.taskIntent ? "unavailable" : "withheld", durationMs: 0 });
        return undefined;
      }
      const messages = event.messages as unknown as PiMessage[];
      if (eff === "shadow") {
        // Observe only: the request goes out unchanged while the reduction runs in the background.
        if (shadowBusy) return undefined;
        shadowBusy = true;
        track(run(messages, ctx, "shadow").then(() => undefined, () => undefined).finally(() => {
          shadowBusy = false;
        }));
        return undefined;
      }
      try {
        const reduced = await run(messages, ctx, "on");
        return reduced ? { messages: reduced as unknown as typeof event.messages } : undefined;
      } catch {
        return undefined;
      }
    },
    startTask() {
      task = newTask();
    },
    async recallTool(params, ctx) {
      if (settings.request === "off") throw new Error(CONTEXT_DISABLED_MESSAGE);
      const handle = (params as { handle?: unknown } | null)?.handle;
      const id = ctx.sessionManager.getSessionId();
      const result = await recall({ handle, sessionId: id, dir: settings.storeDir, fs });
      if (!result.ok) throw new Error(`jev_recall 失败（${result.reason}）：${RECALL_ERRORS[result.reason]}`);
      sessionId = id;
      task.recalls++;
      persist();
      return { content: [{ type: "text", text: result.content }], details: { handle, chars: result.content.length } };
    },
    statusLines(mode) {
      const eff = effective(mode);
      const block = eff === "off" ? undefined : outboundBlock();
      let line: string;
      if (eff === "off") line = "关闭";
      else if (eff === "shadow") {
        const note = block ?? task.note;
        line = `仅观察（本任务候选 ${task.candidates}，可省约 ${task.savable} 字符${note ? `；${note}` : ""}）`;
      } else {
        const fallback = block ?? task.fallback;
        line = fallback ? `已回退（${fallback}）` : `已应用（${task.applied} 条已存档）`;
      }
      return [`上下文裁剪（请求级）：${line}`, "摘要替换：关闭（原生路径）"];
    },
    abort(reason) {
      for (const controller of controllers) controller.abort(reason);
    },
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
      await writes;
    },
  };
}
