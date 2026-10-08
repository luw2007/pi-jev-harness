/**
 * OMP completion checkpoint and bounded continuation (T105 C4), plus the assessment tools and
 * `jev_route` state (C5). Reuses the host-neutral lifecycle (`../core/lifecycle.ts`): one
 * checkpoint assessment per boundary, then the continuation decision (`decideContinuation`).
 *
 * `session_stop` is the only boundary that may continue; the result is the port's
 * `{continue: true, additionalContext}`. Never continues (and asks nothing) when:
 * - session mode off, or capability `acceptance` off;
 * - a child session (`parentSession` / `agent.kind: "sub"`);
 * - queued user messages or running async jobs (`hasPendingWork`);
 * - another handler's continuation is running (`stop_hook_active` while the previous
 *   continuation was not ours): never stacks onto another continuation. OMP 18.3.5 emits
 *   `session_stop` only for a terminal settle (rewind / plan / todo reminders and pending async
 *   wakes return before it, agent-session.ts #handleAgentEnd), and `agent_end` fires after it, so
 *   the decision uses only state available at `session_stop`; `agent_end` is not a gate;
 * - the event signal is aborted.
 * At most `harness.continuation.max` (≤ 2) continuations per task. The continuation applies only
 * when session mode, `acceptance` and `autorun` are all `on`; otherwise it is computed and recorded
 * as would-continue (shadow). `autorun off` assesses only and never asks the continuation question.
 *
 * Budget: each boundary and each tool call gets its own window (AsyncLocalStorage, so concurrent
 * calls never share or starve one another): at most `budget.maxRequestsPerTask` Jev requests,
 * waiting at most `budget.waitMs`. Outbound: `outbound.taskIntent`, key present, no
 * credential shape in anything sent. Never calls setModel / setThinkingLevel / setActiveTools.
 *
 * Evidence comes from the transcript (`session_stop.messages`, or the session branch for tool
 * calls): `edit`/`write` paths as changes, check commands run through `bash` as checks, the last
 * assistant text as the answer. Upgrade to a workspace diff when OMP evidence capture (L2) lands.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { JevAttempt, JevCapability, JevClient } from "../../jev/index.ts";
import { attemptTokens, type JevAccess } from "../shared/jev-access.ts";
import { recordToolResult, type Evidence, type FileChange } from "../../harness/index.ts";
import type { TelemetryInput } from "../../telemetry/index.ts";
import type { AuditInput } from "../../telemetry/audit.ts";
import { CHECK_COMMAND } from "../core/checks.ts";
import {
  ACCEPTANCE_TOOL,
  FOREMAN_TOOL,
  createTaskLifecycle,
  unavailableCompletion,
  type HostEvidence,
  type TaskLifecycle,
} from "../core/lifecycle.ts";
import type { HostSessionView, HostToolResult } from "../core/port.ts";
import type { CapabilityMode, LegacyConfig } from "./legacy-config.ts";
import { createOmpRouteTool, type OmpRouteTool } from "./route.ts";
import { containsCredential, truncateIntent, type LoadedConfig } from "./shared.ts";
import type { OmpAgentEndEvent, OmpSessionStopEvent, OmpSessionStopResult, OmpToolInfo } from "./types.ts";

export type SessionMode = "off" | "shadow" | "on";
export type CapabilityName = "acceptance" | "autorun";

export interface CapabilityState {
  mode: CapabilityMode;
  /** `session` (/jev), `config` (pi-jev-harness config file), a legacy file path, or `default`. */
  source: string;
}

export interface OmpStopDeps {
  loaded: LoadedConfig;
  /** The own config file set `harness.continuation.enabled` explicitly: it wins over legacy files. */
  explicitContinuation: boolean;
  legacy: LegacyConfig;
  runId: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now(): number;
  newId(): string;
  onJevRequest(): void;
  record(event: TelemetryInput): void;
  getAllTools(): OmpToolInfo[];
  getActiveTools(): string[];
  /** T105 C9: provider chain per capability and the credential-scan secrets. */
  jev: JevAccess;
  /** C11: content-free stop decision line (the session's audit writer). */
  audit?: (input: AuditInput) => void;
}

export interface OmpStop {
  startTask(prompt: string): void;
  agentEnd(event: OmpAgentEndEvent): void;
  sessionStop(event: OmpSessionStopEvent, view: HostSessionView, mode: SessionMode): Promise<OmpSessionStopResult | undefined>;
  assessTool(tool: string, params: unknown, messages: readonly unknown[], mode: SessionMode): Promise<HostToolResult>;
  routeTool(params: unknown, mode: SessionMode): Promise<HostToolResult>;
  setMode(mode: SessionMode): void;
  capability(name: CapabilityName): CapabilityState;
  setCapability(name: CapabilityName, mode: CapabilityMode): void;
  /**
   * True only for our own continuation turn: a continuation is pending and `prompt` is exactly the
   * additionalContext we returned (OMP runs it as the turn's prompt). Any other prompt is a new task.
   */
  continuing(prompt: string): boolean;
  /** Continuations applied / max for the current task. */
  continuations(): { used: number; max: number };
  statusLines(mode: SessionMode): string[];
  abort(reason: string): void;
}

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
const EXEC_TOOLS: ReadonlySet<string> = new Set(["bash"]);

type Msg = { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };

function textOf(message: Msg): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/** Host evidence for `goal` from a transcript: only messages after the task's user message count. */
export function transcriptEvidence(goal: string, messages: readonly unknown[], now: number): HostEvidence {
  const list = messages.filter((m): m is Msg => m !== null && typeof m === "object");
  const probe = goal.slice(0, 200).trim();
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.role === "user" && probe && textOf(list[i]!).includes(probe)) {
      start = i;
      break;
    }
  }
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const changes = new Map<string, FileChange>();
  const checks: Evidence[] = [];
  let answer: string | undefined;
  let mutated = false;
  for (const message of list.slice(start)) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
        if (part?.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
        const args = part.arguments && typeof part.arguments === "object" ? (part.arguments as Record<string, unknown>) : {};
        calls.set(part.id, { name: part.name, args });
      }
      const text = textOf(message).trim();
      if (text) answer = text;
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const call = calls.get(message.toolCallId);
      const name = typeof message.toolName === "string" && message.toolName ? message.toolName : call?.name;
      if (!name) continue;
      const failed = message.isError === true;
      if (MUTATING_TOOLS.has(name) && !failed) {
        mutated = true;
        const path = call?.args.path ?? call?.args.file_path;
        if (typeof path === "string" && path) changes.set(path, { path, change: "modified", before: null, after: null });
      }
      const command = call?.args.command;
      if (EXEC_TOOLS.has(name) && typeof command === "string" && CHECK_COMMAND.test(command)) {
        try {
          checks.push(recordToolResult({ actionId: message.toolCallId, toolCallId: message.toolCallId, toolName: name, isError: failed,
            content: message.content, details: message.details, startedAt: now, endedAt: now }).evidence);
        } catch {
          // Malformed host result: not evidence.
        }
      }
    }
  }
  return { goal, mutated, changes: [...changes.values()], checks, ...(answer === undefined ? {} : { answer }) };
}

function answerOf(params: unknown): string | undefined {
  const answer = (params as { answer?: unknown } | null)?.answer;
  return typeof answer === "string" && answer.trim() ? answer : undefined;
}

const toolText = (body: unknown): HostToolResult => ({ content: [{ type: "text", text: JSON.stringify(body) }], details: body });

/** Assessment tool result while the adapter is off or has no session. */
export function assessOffResult(tool: string): HostToolResult {
  return toolText(unavailableCompletion(tool === FOREMAN_TOOL ? "foreman" : "acceptance", "完成评估不可用：Jev 处于 off，未发送请求"));
}

interface Task {
  goal: string;
  lifecycle: TaskLifecycle;
  controller: AbortController;
  /** Messages the next evidence read uses. */
  messages: readonly unknown[];
}

export function createOmpStop(deps: OmpStopDeps): OmpStop {
  const { config } = deps.loaded;
  const fromFile = deps.loaded.source === "file";
  const caps: Record<CapabilityName, CapabilityState> = {
    acceptance: deps.legacy.acceptance ?? { mode: "on", source: "default" },
    autorun: fromFile && deps.explicitContinuation ? { mode: config.harness.continuation.enabled ? "on" : "shadow", source: "config" }
      : deps.legacy.autorun ?? { mode: config.harness.continuation.enabled ? "on" : "shadow", source: fromFile ? "config" : "default" },
  };
  let sessionMode: SessionMode = "off";
  let task: Task | undefined;
  /** The previous stop returned our continuation; the next `stop_hook_active` is ours. */
  let ourContinuation = false;
  /** additionalContext of the pending continuation; identifies our continuation turn. */
  let pendingContext: string | undefined;
  let wouldContinue = 0;
  let lastSkip = "none";
  /**
   * Per-call request allowance, wait signal and capability chain, bound to the async context of
   * that call. A chain call is one unit, however many providers it tries (./budget.ts).
   */
  const windows = new AsyncLocalStorage<{ left: number; signal: AbortSignal; capability: JevCapability }>();
  const clients = new Map<JevCapability, JevClient | undefined>();

  function jev(): JevClient | undefined {
    const capability = windows.getStore()?.capability ?? "acceptance";
    if (!clients.has(capability)) {
      clients.set(capability, deps.jev.client(capability, {
        fetch: (input, init) => {
          const w = windows.getStore();
          deps.onJevRequest();
          return deps.fetch(input, w ? { ...init, signal: init?.signal ? AbortSignal.any([init.signal, w.signal]) : w.signal } : init);
        },
        take: () => {
          const w = windows.getStore();
          if (!w || w.left <= 0) return false;
          w.left--;
          return true;
        },
        now: deps.now,
        newId: () => `att_${deps.newId()}`,
        waitMs: config.budget.waitMs,
        onAttempt: (attempt: JevAttempt) => deps.record({ runId: deps.runId, decisionId: `dec_${deps.newId()}`, attemptId: attempt.attemptId, kind: "jev_attempt",
          outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}`, ...attemptTokens(attempt) }),
      }));
    }
    return clients.get(capability);
  }

  /** Run `work` inside one budget window (requests + wait) on `capability`'s chain, optionally tied to a host signal. */
  async function bounded<T>(capability: JevCapability, work: () => Promise<T>, host?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(config.budget.waitMs);
    return windows.run({ left: config.budget.maxRequestsPerTask, signal: host ? AbortSignal.any([timeout, host]) : timeout, capability }, work);
  }

  const route: OmpRouteTool = createOmpRouteTool({
    config, runId: deps.runId, secrets: deps.jev.available("route") ? deps.jev.secrets : undefined, now: deps.now, newId: deps.newId, record: deps.record,
    getAllTools: deps.getAllTools, getActiveTools: deps.getActiveTools,
    jev: () => (windows.getStore() ? jev() : undefined),
  });

  function outboundBlock(texts: readonly string[]): string | null {
    if (!config.outbound.taskIntent) return "outbound.taskIntent=false";
    const capability = windows.getStore()?.capability ?? "acceptance";
    if (!deps.jev.available(capability)) return "Jev key missing";
    if (texts.some((text) => containsCredential(text, deps.jev.secrets))) return "credential detected";
    return null;
  }

  /** Lifecycle mode: `on` only when session, acceptance and autorun all say on. */
  const lifecycleMode = (): SessionMode =>
    sessionMode === "off" ? "off" : sessionMode === "on" && caps.acceptance.mode === "on" && caps.autorun.mode === "on" ? "on" : "shadow";

  function newTask(goal: string): Task {
    const controller = new AbortController();
    const t: Task = {
      goal,
      controller,
      messages: [],
      lifecycle: createTaskLifecycle({
        continuation: { enabled: true, max: config.harness.continuation.max },
        mode: lifecycleMode(),
        sessionId: deps.runId,
        signal: controller.signal,
        evidence: async () => transcriptEvidence(goal, t.messages, deps.now()),
        outboundBlock,
        jev,
        now: deps.now,
        newId: deps.newId,
        onDecision: (kind, decisionId, outcome, durationMs) => deps.record({ runId: deps.runId, decisionId, kind, outcome, durationMs }),
        skipAskAtLimit: true,
      }),
    };
    return t;
  }

  const continuations = () => ({ used: task?.lifecycle.snapshot().continuations ?? 0, max: config.harness.continuation.max });
  const syncMode = () => task?.lifecycle.setMode(lifecycleMode());

  function skip(reason: string): undefined {
    lastSkip = reason;
    return undefined;
  }

  /** The stop decision; `assessed` tells the audit line whether Jev judged this stop. */
  async function stopDecision(event: OmpSessionStopEvent, view: HostSessionView, mode: SessionMode): Promise<{ out: OmpSessionStopResult | undefined; assessed: boolean }> {
    const ours = ourContinuation;
    ourContinuation = false;
    if (mode === "off") return { out: skip("mode off"), assessed: false };
    if (view.isChildSession) return { out: skip("child session"), assessed: false };
    if (!task) return { out: skip("no task"), assessed: false };
    if (caps.acceptance.mode === "off") return { out: skip("acceptance off"), assessed: false };
    if (view.hasPendingWork()) return { out: skip("pending messages or async jobs"), assessed: false };
    if (event.stop_hook_active && !ours) return { out: skip("another stop hook's continuation is active"), assessed: false };
    if (event.signal?.aborted) return { out: skip("aborted"), assessed: false };
    const current = task;
    current.messages = Array.isArray(event.messages) ? event.messages : [];
    if (caps.autorun.mode === "off") {
      await bounded("acceptance", () => current.lifecycle.assessTool(ACCEPTANCE_TOOL, undefined), event.signal);
      return { out: skip("autorun off (assessed only)"), assessed: true };
    }
    const result = await bounded("acceptance", () => current.lifecycle.settle({
      cancelled: () => event.signal?.aborted === true,
      pendingUserMessage: () => view.hasPendingWork(),
      runningBackgroundTasks: () => 0,
      sessionId: () => view.sessionId,
      branchId: () => view.leafId,
      contextPercent: () => undefined,
    }), event.signal);
    const last = current.lifecycle.records().at(-1);
    if (!result) {
      if (last?.decision?.decision === "continue" && !last.applied) wouldContinue++;
      return { out: skip(last?.reason ?? "stop"), assessed: true };
    }
    ourContinuation = true;
    pendingContext = result.prompt;
    lastSkip = "none";
    return { out: { continue: true, additionalContext: result.prompt }, assessed: true };
  }

  return {
    startTask(prompt) {
      // Our continuation turn is part of the same task: keep its count.
      if (task && ourContinuation && prompt === pendingContext) return;
      // Any other prompt is a new task: a pending continuation that never started is dropped.
      ourContinuation = false;
      pendingContext = undefined;
      task?.controller.abort("new_task");
      task = newTask(truncateIntent(prompt));
      route.startTask();
    },
    agentEnd(event) {
      // Never gates a stop (it fires after session_stop for the same settle). Our continuation's
      // own settle ends with willContinue: true; a later agent_end without it and without a
      // session_stop in between means the continuation turn ended without a terminal stop (host
      // abort clears the queued continuation and skips session_stop): the task is over.
      if (ourContinuation && event.willContinue !== true) {
        ourContinuation = false;
        task?.controller.abort("aborted");
        task = undefined;
      }
    },
    async sessionStop(event, view, mode) {
      const started = deps.now();
      const { out, assessed } = await stopDecision(event, view, mode);
      if (mode !== "off") {
        const { used, max } = continuations();
        deps.audit?.({ kind: "stop", event: "settle", outcome: out ? "continued" : assessed ? "allowed" : "skipped", mode, durationMs: deps.now() - started,
          runId: deps.runId, decisionId: `dec_${deps.newId()}`, metrics: { continues: used, maxContinues: max } });
      }
      return out;
    },
    async assessTool(tool, params, messages, mode) {
      const kind = tool === FOREMAN_TOOL ? "foreman" : "acceptance";
      if (mode === "off") return assessOffResult(tool);
      const current = task;
      if (!current) return toolText(unavailableCompletion(kind, "完成评估不可用：当前没有进行中的任务"));
      current.messages = messages;
      return toolText(await bounded(kind === "foreman" ? "assess" : "acceptance", () => current.lifecycle.assessTool(tool, answerOf(params))));
    },
    routeTool: (params, mode) => bounded("route", () => route.execute(params, mode !== "off")),
    setMode(mode) {
      sessionMode = mode;
      if (mode === "off") {
        task?.controller.abort("mode_off");
        task = undefined;
        ourContinuation = false;
      }
      syncMode();
    },
    capability: (name) => ({ ...caps[name] }),
    setCapability(name, mode) {
      caps[name] = { mode, source: "session" };
      syncMode();
    },
    continuations,
    continuing: (prompt) => ourContinuation && task !== undefined && prompt === pendingContext,
    statusLines(mode) {
      const { used, max } = continuations();
      const applies = mode === "on" && lifecycleMode() === "on";
      return [
        `acceptance: ${caps.acceptance.mode} (source: ${caps.acceptance.source})`,
        `autorun: ${caps.autorun.mode} (source: ${caps.autorun.source}); ${applies ? "continuation applies" : "would-continue recorded only"}`,
        `continuations this task: ${used}/${max}; would-continue: ${wouldContinue}; last stop skip: ${lastSkip}`,
        ...(deps.legacy.notes ?? []),
        ...(deps.legacy.toolGroups ? [`legacy toolGroups: ${deps.legacy.toolGroups.names.join(", ")} (source: ${deps.legacy.toolGroups.source}; shown only, never applied)`] : []),
      ];
    },
    abort(reason) {
      task?.controller.abort(reason);
    },
  };
}
