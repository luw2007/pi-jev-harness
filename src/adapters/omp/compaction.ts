// Adapted from omp-jev-extensions extensions/jev-compaction/{hook,map,render,context}.ts
// (`jevCompaction`, `mapOmpMessages`, `renderVerbatim`, `transcriptChars`, `splitIntoWindows`,
// `mergeResults`) and extensions/jev-autorun/jev-autorun.ts (`assessCompact`). MIT.
//
// at `session_before_compact` the region OMP is about to discard is scored by Jev
// (vendored fast-jev `compact`) and, when the saving is real, returned as retained history
// verbatim: the "summary" IS the kept conversation, unchanged and in order, minus the tool
// calls/results Jev judged unneeded. No summary is generated. Any failure (Jev unavailable,
// budget, credential, timeout, invalid preparation, too little saved) returns undefined so OMP runs
// its native compaction; `cancel` is never returned.
//
// Proactive compaction (legacy jev-autorun `assessCompact`): at `agent_end` without a scheduled
// continuation, with context usage ≥ soft threshold, ask Jev whether this is a natural break
// (noul ≥ 0.7) and then call `ctx.compact()` on the next tick if the session is still idle. At or
// above the hard threshold Jev is not asked and compaction runs (switch `proactive.hardCompact`).
import { compact } from "../../../vendor/fast-jev/compact.ts";
import type { CompactResult, JevAnswer, JevAsker, JevQuestions, Message, ToolResult, ToolUse } from "../../../vendor/fast-jev/types.ts";
import type { JevAttempt, JevClient } from "../../jev/index.ts";
import { createJevAccess, type JevAccess } from "../shared/jev-access.ts";
import type { TelemetryInput } from "../../telemetry/index.ts";
import type { OmpContextSettings } from "./context-settings.ts";
import { ompSessionView } from "./port.ts";
import { containsCredential, type AdapterConfig } from "./shared.ts";
import type { OmpCompactionResult, OmpContext, OmpSessionBeforeCompactEvent, OmpSessionBeforeCompactResult } from "./types.ts";

type Mode = "off" | "shadow" | "on";
type Env = Readonly<Record<string, string | undefined>>;

// ---- legacy map.ts -----------------------------------------------------------------------------

interface OmpToolCallPart { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }
interface OmpToolResultMessage { role: "toolResult"; toolCallId: string; content: Array<{ type: string; text?: string }>; isError?: boolean }

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
}

/** OMP message stream → fast-jev messages (tool results folded onto a user message). */
export function mapOmpMessages(source: readonly unknown[]): Message[] {
  const messages: Message[] = [];
  const pending: ToolResult[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    messages.push({ role: "user", text: "", toolUses: [], toolResults: [...pending] });
    pending.length = 0;
  };
  for (const raw of source) {
    const message = raw as { role?: unknown; content?: unknown };
    if (message?.role === "toolResult") {
      const result = message as OmpToolResultMessage;
      pending.push({
        tool_use_id: result.toolCallId,
        text: (Array.isArray(result.content) ? result.content : []).map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n"),
        isError: result.isError === true,
      });
    } else if (message?.role === "assistant") {
      flush();
      const content = Array.isArray(message.content) ? message.content : [];
      const toolUses: ToolUse[] = content
        .filter((part): part is OmpToolCallPart => (part as OmpToolCallPart)?.type === "toolCall")
        .map((part) => ({ tool_use_id: part.id, tool: part.name, input: part.arguments ?? {} }));
      messages.push({ role: "assistant", text: textOf(content), toolUses });
    } else if (message?.role === "user" || message?.role === "developer") {
      flush();
      messages.push({ role: "user", text: textOf(message.content), toolUses: [] });
    }
  }
  flush();
  return messages;
}

// ---- legacy render.ts --------------------------------------------------------------------------

export const VERBATIM_HEADER = [
  "# Retained history (verbatim)",
  "",
  "This is not a written summary. The messages below are the original",
  "conversation, unchanged and in order. Only tool calls and tool results that",
  "the Jev decision model judged no longer needed were dropped or truncated;",
  "any tool can be re-run if its output is needed again.",
].join("\n");

function renderInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (json === undefined) return "{}";
  return json.length > 2000 ? `${json.slice(0, 2000)}… (input truncated)` : json;
}

export function renderVerbatim(messages: readonly Message[]): string {
  const blocks: string[] = [VERBATIM_HEADER];
  for (const message of messages) {
    const parts: string[] = [];
    const label = message.role === "assistant" ? "Assistant" : "User";
    if (message.text.trim()) parts.push(`## ${label}\n\n${message.text}`);
    else if (message.toolUses.length === 0 && (message.toolResults?.length ?? 0) === 0) continue;
    else parts.push(`## ${label}`);
    for (const use of message.toolUses) parts.push(`### Tool call: ${use.tool} (${use.tool_use_id})\n\n\`\`\`json\n${renderInput(use.input)}\n\`\`\``);
    for (const result of message.toolResults ?? []) parts.push(`### Tool ${result.isError ? "error" : "result"} (${result.tool_use_id})\n\n${result.text}`);
    blocks.push(parts.join("\n\n"));
  }
  return blocks.join("\n\n");
}

export function transcriptChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const use of message.toolUses) total += use.tool.length + JSON.stringify(use.input ?? {}).length;
    for (const result of message.toolResults ?? []) total += result.text.length;
  }
  return total;
}

// ---- legacy context.ts / hook.ts ---------------------------------------------------------------

/** Roughly 15k tokens of state per window, inside Jev's 32k window. */
export const DEFAULT_MAX_WINDOW_CHARS = 60_000;

/** Consecutive windows that never separate a tool call from its result. */
export function splitIntoWindows<T extends { role: string; toolResults?: unknown[] }>(messages: readonly T[], maxChars: number): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const message of messages) {
    const chars = JSON.stringify(message).length;
    const wouldSplitPair = message.role === "user" && (message.toolResults?.length ?? 0) > 0;
    if (current.length > 0 && size + chars > maxChars && !wouldSplitPair) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += chars;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

function mergeResults(results: readonly CompactResult[]): CompactResult {
  const merged: CompactResult = {
    messages: results.flatMap((result) => result.messages),
    decisions: results.flatMap((result, window) => result.decisions.map((decision) => (results.length > 1 ? { ...decision, id: `w${window + 1}.${decision.id}` } : decision))),
    stats: { ...results[0]!.stats },
  };
  for (const { stats: next } of results.slice(1)) {
    const s = merged.stats;
    s.messagesBefore += next.messagesBefore;
    s.messagesAfter += next.messagesAfter;
    s.charsBefore += next.charsBefore;
    s.charsAfter += next.charsAfter;
    s.calls += next.calls;
    s.kept += next.kept;
    s.resultsDropped += next.resultsDropped;
    s.callsDropped += next.callsDropped;
    s.pinned += next.pinned;
    s.requests += next.requests;
    s.unscored += next.unscored;
    s.ms += next.ms;
    s.stateTokens = Math.max(s.stateTokens, next.stateTokens);
    if (next.stateStage && next.stateStage !== s.stateStage) s.stateStage = `${s.stateStage}+${next.stateStage}`;
  }
  return merged;
}

/** `CompactionPreparation` fields this path reads; anything else → native compaction. */
interface Preparation {
  firstKeptEntryId: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  tokensBefore: number;
}

function preparationOf(value: unknown): Preparation | undefined {
  const p = value as Partial<Preparation> | null;
  if (!p || typeof p !== "object") return undefined;
  if (typeof p.firstKeptEntryId !== "string" || p.firstKeptEntryId.length === 0) return undefined;
  if (!Array.isArray(p.messagesToSummarize) || (p.turnPrefixMessages !== undefined && !Array.isArray(p.turnPrefixMessages))) return undefined;
  if (typeof p.tokensBefore !== "number" || !Number.isFinite(p.tokensBefore)) return undefined;
  return { firstKeptEntryId: p.firstKeptEntryId, messagesToSummarize: p.messagesToSummarize, turnPrefixMessages: p.turnPrefixMessages ?? [], tokensBefore: p.tokensBefore };
}

export interface JevCompactionOutcome {
  compaction?: OmpCompactionResult;
  skipped?: "no-tool-calls" | "insufficient-reduction";
  result?: CompactResult;
  reduction: number;
}

/** Legacy `jevCompaction`: scores the discarded region; kept history verbatim when the saving is real. */
export async function jevCompaction(
  preparation: Preparation,
  asker: JevAsker,
  settings: Pick<OmpContextSettings, "keepThreshold" | "preserveRecent" | "minReduction" | "allowDroppingCalls">,
): Promise<JevCompactionOutcome> {
  const messages = mapOmpMessages([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
  const before = transcriptChars(messages);
  if (messages.length === 0) return { skipped: "no-tool-calls", reduction: 0 };
  const perWindow: CompactResult[] = [];
  for (const window of splitIntoWindows(messages, DEFAULT_MAX_WINDOW_CHARS)) {
    // Sentinel at index 0 so the region's real first message is scoreable (legacy note).
    const sentinel: Message = { role: "user", text: "(start of the region being compacted)", toolUses: [] };
    const scored = await compact([sentinel, ...window], asker, {
      keepThreshold: settings.keepThreshold,
      preserveRecentMessages: settings.preserveRecent,
      allowDroppingCalls: settings.allowDroppingCalls,
    });
    perWindow.push({ ...scored, messages: scored.messages.filter((message) => message !== sentinel) });
  }
  const result = mergeResults(perWindow);
  const after = transcriptChars(result.messages);
  const reduction = before === 0 ? 0 : (before - after) / before;
  if (result.stats.calls === 0) return { skipped: "no-tool-calls", result, reduction };
  if (reduction < settings.minReduction) return { skipped: "insufficient-reduction", result, reduction };
  const kept = result.stats.kept;
  const dropped = result.stats.resultsDropped + result.stats.callsDropped;
  return {
    result,
    reduction,
    compaction: {
      summary: renderVerbatim(result.messages),
      shortSummary: `Jev verbatim compaction: kept ${kept} tool calls, dropped ${dropped}, ${Math.round(reduction * 100)}% smaller`,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { jev: result.decisions },
      preserveData: { jevCompaction: { version: 1, decisions: result.decisions.length, kept, dropped, reduction } },
    },
  };
}

function validCompaction(value: OmpCompactionResult | undefined): value is OmpCompactionResult {
  return value !== undefined && typeof value.summary === "string" && value.summary.length > VERBATIM_HEADER.length
    && typeof value.firstKeptEntryId === "string" && value.firstKeptEntryId.length > 0 && Number.isFinite(value.tokensBefore);
}

// ---- adapter -----------------------------------------------------------------------------------

export interface OmpCompactionDeps {
  /** provider chain / legacy mapping / single-url for the `compact` capability. */
  /** Default: from `config` alone (single-url unless `jev.providers`). */
  jev?: JevAccess;
  config: AdapterConfig;
  settings: OmpContextSettings;
  runId: string;
  env: Env;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  onJevRequest: () => void;
  record: (event: TelemetryInput) => void;
  onFallback?: (reason: string) => void;
  /** Deferral of the proactive compact (legacy: next tick). */
  defer?: (run: () => void) => void;
}

export interface OmpCompaction {
  beforeCompact(event: OmpSessionBeforeCompactEvent, ctx: OmpContext, mode: Mode): Promise<OmpSessionBeforeCompactResult | undefined>;
  agentEnd(event: { willContinue?: boolean }, ctx: OmpContext, mode: Mode): Promise<void>;
  statusLines(mode: Mode): string[];
  /** Cancel in-flight compaction batches (mode off / shutdown). */
  abort(reason: string): void;
  settled(): Promise<void>;
}

class Refused extends Error {}

/**
 * Legacy jev-compaction puts no cap on requests: fast-jev `compact` sends one request per question
 * batch, per 60k-char window, all batches of a window in parallel. Default here: uncapped too;
 * `budget.compactRequests` caps it. Each request is bounded by `jev.timeoutMs` (legacy
 * `OMP_JEV_TIMEOUT_MS`), the whole compaction by `budget.compactWaitMs` (default below).
 */
export const DEFAULT_COMPACT_WAIT_MS = 120_000;

/**
 * OMP awaits each extension handler at most `EXTENSION_HANDLER_TIMEOUT_MS` (runner.ts, 30 s; a user
 * setting can change it, which the adapter cannot read). The compaction wait stays below it by
 * `HANDLER_MARGIN_MS` so a late Jev never races the host's own timeout.
 */
export const OMP_HANDLER_TIMEOUT_MS = 30_000;
export const HANDLER_MARGIN_MS = 5_000;

export function compactionWaitMs(config: AdapterConfig, handlerTimeoutMs = OMP_HANDLER_TIMEOUT_MS): number {
  return Math.max(1, Math.min(config.budget.compactWaitMs ?? DEFAULT_COMPACT_WAIT_MS, handlerTimeoutMs - HANDLER_MARGIN_MS));
}

const rank = { off: 0, shadow: 1, on: 2 } as const;
const effective = (mode: Mode, feature: Mode): Mode => (rank[mode] < rank[feature] ? mode : feature);

export function createOmpCompaction(deps: OmpCompactionDeps): OmpCompaction {
  const { config, settings } = deps;
  const pending = new Set<Promise<void>>();
  let compacting = false;
  const controllers = new Set<AbortController>();
  let lastCompaction = "none";
  let lastProactive = "none";

  // the `compact` chain; one ask = one compaction unit.
  const jev = deps.jev ?? createJevAccess({ config, env: deps.env });
  const client: JevClient | undefined = jev.client("compact", {
    fetch: (input, init) => {
      deps.onJevRequest();
      return deps.fetch(input, init);
    },
    now: deps.now,
    newId: () => `att_${deps.newId()}`,
    waitMs: compactionWaitMs(config),
    ...(settings.model ? { model: settings.model } : {}),
    onAttempt: (attempt: JevAttempt) =>
      deps.record({ runId: deps.runId, decisionId: attempt.decisionId, attemptId: attempt.attemptId, kind: "jev_attempt",
        outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}` }),
  });

  const outboundBlock = (): string | undefined =>
    !config.outbound.taskIntent ? "outbound.taskIntent=false" : !client ? "Jev key missing" : undefined;

  /** fast-jev asker over the Jev client; credential, budget and signal refuse by throwing. */
  /** Any failed batch aborts `controller`, so the other in-flight batches stop too. */
  function asker(decisionId: string, signal: AbortSignal, budget: { left: number }, controller: AbortController): JevAsker {
    const fail = (reason: string): never => {
      controller.abort(reason);
      throw new Refused(reason);
    };
    return {
      async ask(state, questions: JevQuestions) {
        if (signal.aborted) throw new Refused("cancelled");
        const text = typeof state === "string" ? state : JSON.stringify(state);
        if (containsCredential(text, jev.secrets)) fail("credential");
        if (budget.left <= 0) fail("budget");
        budget.left--;
        const names = Object.keys(questions);
        const result = await client!.noul(
          names.map((name) => ({ id: name, question: (questions[name] as { instructions?: string }).instructions ?? name })),
          { decisionId, state: state as string | Record<string, unknown>, signal },
        );
        if (!result.ok) return fail(`jev_${result.error.kind}`);
        const answers: Record<string, JevAnswer> = {};
        for (const evidence of result.evidence) answers[evidence.questionId] = { noul: evidence.yes };
        return { answers };
      },
    };
  }

  function track(promise: Promise<void>) {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  }

  return {
    async beforeCompact(event, ctx, mode) {
      const eff = effective(mode, settings.compaction);
      if (eff === "off") return undefined;
      if (ompSessionView(ctx).isChildSession) return undefined;
      const started = deps.now();
      const decisionId = `dec_${deps.newId()}`;
      const native = (reason: string, outcome: TelemetryInput["outcome"] = "fallback") => {
        lastCompaction = `native (${reason})`;
        if (eff === "on") deps.onFallback?.(`compaction: ${reason}`);
        deps.record({ runId: deps.runId, decisionId, kind: "context", outcome, durationMs: deps.now() - started, source: "compaction:native" });
        return undefined;
      };
      const block = outboundBlock();
      if (block) return native(block, config.outbound.taskIntent ? "unavailable" : "withheld");
      const preparation = preparationOf(event?.preparation);
      if (!preparation) return native("unrecognized preparation", "skipped");
      const controller = new AbortController();
      controllers.add(controller);
      // Own budget and wait: compaction never draws on (or from) the per-task request budget.
      const timer = setTimeout(() => controller.abort("wait_budget"), compactionWaitMs(config));
      const signal = event.signal ? AbortSignal.any([controller.signal, event.signal]) : controller.signal;
      try {
        const outcome = await jevCompaction(preparation, asker(decisionId, signal, { left: config.budget.compactRequests ?? Number.POSITIVE_INFINITY }, controller), settings);
        if (signal.aborted) return native("cancelled or wait budget spent", "timeout");
        if (!validCompaction(outcome.compaction)) return native(outcome.skipped ?? "invalid result", "skipped");
        if (eff === "shadow") {
          lastCompaction = `would apply (${Math.round(outcome.reduction * 100)}% smaller)`;
          deps.record({ runId: deps.runId, decisionId, kind: "context", outcome: "ok", durationMs: deps.now() - started, source: "compaction:would_apply" });
          return undefined;
        }
        lastCompaction = `applied (${Math.round(outcome.reduction * 100)}% smaller)`;
        deps.record({ runId: deps.runId, decisionId, kind: "context", outcome: "ok", durationMs: deps.now() - started, source: "compaction:applied" });
        return { compaction: outcome.compaction };
      } catch (error) {
        controller.abort("batch_failed");
        return native(error instanceof Refused ? error.message : "error", error instanceof Refused && error.message === "credential" ? "withheld" : "fallback");
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    },

    async agentEnd(event, ctx, mode) {
      const eff = effective(mode, settings.proactive.mode);
      if (eff === "off" || event?.willContinue || compacting) return;
      const view = ompSessionView(ctx);
      if (view.isChildSession || view.hasPendingWork()) return;
      let percent: number | null | undefined;
      try {
        percent = ctx.getContextUsage()?.percent;
      } catch {
        percent = undefined;
      }
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent < settings.proactive.softPercent) return;
      const started = deps.now();
      const decisionId = `dec_${deps.newId()}`;
      const hard = percent >= settings.proactive.hardPercent && settings.proactive.hardCompact;
      // In-flight flag set before any await: an overlapping agent_end returns at the check above.
      compacting = true;
      let handedOff = false;
      try {
      let natural: number | undefined;
      if (!hard && !outboundBlock()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort("wait_budget"), config.budget.waitMs);
        try {
          const result = await client!.noul([{ id: "naturalBreak", question: "Is this a natural break: a subtask done and no work running?" }],
            { decisionId, state: { contextPercent: percent, pending: false }, signal: controller.signal });
          const yes = result.ok ? result.evidence.find((e) => e.questionId === "naturalBreak")?.yes : undefined;
          natural = typeof yes === "number" && yes >= 0 && yes <= 1 ? yes : undefined;
        } finally {
          clearTimeout(timer);
        }
      }
      const go = hard || (natural !== undefined && natural >= 0.7);
      if (!go) {
        lastProactive = `not compacted at ${Math.round(percent)}% (${natural === undefined ? "no Jev answer" : "not a natural break"})`;
        return;
      }
      if (eff === "shadow") {
        lastProactive = `would compact at ${Math.round(percent)}%${hard ? " (hard)" : ""}`;
        deps.record({ runId: deps.runId, decisionId, kind: "context", outcome: "ok", durationMs: deps.now() - started, source: "proactive:would_compact" });
        return;
      }
      if (typeof ctx.compact !== "function") {
        lastProactive = "host has no compact()";
        return;
      }
      handedOff = true;
      const run = async () => {
        try {
          const idle = ctx.isIdle ? ctx.isIdle() : true;
          if (!idle || view.hasPendingWork()) {
            lastProactive = "skipped: session busy at compaction time";
            return;
          }
          lastProactive = `compacted at ${Math.round(percent)}%${hard ? " (hard)" : ""}`;
          deps.record({ runId: deps.runId, decisionId, kind: "context", outcome: "ok", durationMs: deps.now() - started, source: "proactive:compact" });
          await ctx.compact!({
            onComplete: () => { compacting = false; },
            onError: (error: Error) => {
              compacting = false;
              ctx.ui.notify(`Jev proactive compaction failed: ${error.message}`, "warning");
            },
          });
        } catch (error) {
          ctx.ui.notify(`Jev proactive compaction failed: ${String(error)}`, "warning");
        } finally {
          compacting = false;
        }
      };
      track(new Promise<void>((done) => (deps.defer ?? ((fn) => setTimeout(fn, 0)))(() => void run().finally(done))));
      } finally {
        if (!handedOff) compacting = false;
      }
    },

    abort(reason) {
      for (const controller of controllers) controller.abort(reason);
    },

    statusLines(mode) {
      const c = effective(mode, settings.compaction), p = effective(mode, settings.proactive.mode);
      return [
        `压缩（session_before_compact，fast-jev 原文保留）：${c}${c === "off" ? "" : `；最近：${lastCompaction}`}`,
        `主动压缩（agent_end，soft ${settings.proactive.softPercent}% / hard ${settings.proactive.hardPercent}%${settings.proactive.hardCompact ? "，hard 不问 Jev" : ""}）：${p}${p === "off" ? "" : `；最近：${lastProactive}`}`,
      ];
    },

    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
