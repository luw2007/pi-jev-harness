// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:src/context.ts (MIT)
//
// Request-level context reduction. Only the messages sent for one request change; the session
// history is never touched, and persistent summary replacement is a separate switch that does
// not live here. Rules (technical doc §8):
// - only tool results that mapping.ts marks `reducible` are candidates, so user instructions,
//   summaries, errors, images, mixed/unknown blocks, unpaired or duplicate calls and the recent
//   window pass through as the same objects; the tool call record always stays;
// - results already replaced by a spill notice and results of `jev_recall` are never candidates
//   (recalled content stays visible);
// - a result is replaced by `spillNotice` only after `store` returned ok; otherwise it stays;
// - Jev unavailable, cancellation or a stale generation return the input unchanged and commit
//   nothing to the cache; a pre-cancelled call asks nothing;
// - decisions are cached per result content, so the same input yields the same bytes and no new
//   asks (stable prompt prefix).
import {
  decideCall,
  batchCalls,
  questionsFor,
  resolveOptions,
} from "../../vendor/fast-jev/compact.ts";
import { collectToolCalls, estimateTokens, fitState } from "../../vendor/fast-jev/state.ts";
import type { Message as KernelMessage, ToolCall as KernelCall } from "../../vendor/fast-jev/types.ts";
import type { JevErrorKind, JevResult, NoulEvidence, NoulQuestion } from "../jev/types.ts";
import {
  createDecisionCache,
  decisionDigest,
  type CachedDecision,
  type DecisionCache,
  type DecisionScope,
} from "./cache.ts";
import {
  DEFAULT_RECENT_TURNS,
  goalFromMessages,
  toContextMessages,
  type ContextMessage,
  type PiMessage,
} from "./mapping.ts";
import { RECALL_TOOL_NAME } from "./recall.ts";
import { formatHandle, isSpillNotice, spillNotice, type StoreResult } from "./spill.ts";

/** One Jev request: Noul questions over a state. The adapter adds decision ids and attempts. */
export interface ContextAskRequest {
  state: Record<string, unknown>;
  questions: readonly NoulQuestion[];
  signal?: AbortSignal;
}
export type ContextAsk = (request: ContextAskRequest) => Promise<JevResult<NoulEvidence[]>>;

/** Archives one payload for a session; `storePayload(dir, content, { sessionId })` fits. */
export type ContextStore = (content: string, sessionId: string) => Promise<StoreResult>;

export interface ContextLimits {
  /** Newest assistant turns never reduced. Default 3 (mapping.ts). */
  recentTurns?: number;
  /** Minimum Jev keep probability for a result to stay verbatim. Default 0.2 (C, measured). */
  keepThreshold?: number;
  /** Below this many text characters the request is left alone. Default 0. */
  minChars?: number;
  /** Characters of history scored per window. Default 60 000 (C). */
  maxWindowChars?: number;
  /** Physical Jev requests per reduce; candidates beyond it stay untouched. Default 4. */
  maxAsks?: number;
  /** Estimated token ceiling of one state. Default 25 000 (fast-jev). */
  maxStateTokens?: number;
  /** Estimated token ceiling of state plus questions. Default 30 000 (fast-jev). */
  maxRequestTokens?: number;
  /** Leading characters kept inline above the spill notice. Default 300. */
  headChars?: number;
}

export interface ResolvedContextLimits {
  recentTurns: number;
  keepThreshold: number;
  minChars: number;
  maxWindowChars: number;
  maxAsks: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  headChars: number;
}

export const DEFAULT_CONTEXT_LIMITS: Readonly<ResolvedContextLimits> = Object.freeze({
  recentTurns: DEFAULT_RECENT_TURNS,
  keepThreshold: 0.2,
  minChars: 0,
  maxWindowChars: 60_000,
  maxAsks: 4,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  headChars: 300,
});

/** Bumped whenever the question wording or the decision rule changes. */
export const CONTEXT_POLICY_VERSION = "fast-jev-result-v1";

export type ReduceReason =
  | "reduced"
  | "below_min_chars"
  | "no_candidates"
  | "nothing_dropped"
  | "cancelled"
  | "jev_unavailable"
  | "stale_generation";

export type ResultReason =
  // from mapping.ts
  | "malformed"
  | "unpaired_call"
  | "unpaired_result"
  | "duplicate_id"
  | "error"
  | "has_image"
  | "unknown_block"
  | "not_text_only"
  | "recent"
  // candidates and exclusions decided here
  | "already_spilled"
  | "recalled"
  | "kept"
  | "spilled"
  | "no_saving"
  | "spill_failed"
  | "unscored_budget"
  | "unscored_state";

export interface ResultDecision {
  /** Session index of the toolResult message. */
  index: number;
  toolCallId: string;
  toolName: string;
  action: "keep" | "spill";
  reason: ResultReason;
  /** Where the verdict came from; undefined when nothing was asked or cached. */
  source?: "jev" | "cache";
  keepResult?: number;
  handle?: string;
  /** Present when `reason` is `spill_failed`. */
  spillError?: string;
}

export interface ReduceStats {
  messages: number;
  toolResults: number;
  candidates: number;
  spilled: number;
  spillFailures: number;
  unscored: number;
  cacheHits: number;
  /** Physical Jev requests made. */
  asks: number;
  /** Text characters of the whole request, before and after. Exact. */
  chars: { before: number; after: number };
  /**
   * fast-jev's tokenizer-free estimate of the same text. An estimate, not billed tokens: the
   * provider's count is unknown here and must come from usage telemetry.
   */
  estimatedTokens: { before: number; after: number };
  /** Largest estimated state sent in one ask; 0 when nothing was asked. */
  maxStateTokens: number;
}

export interface ReduceInput {
  messages: readonly PiMessage[];
  sessionId: string;
  branchId: string;
  /** Monotonic per session; an older generation never commits and returns unchanged. */
  generation: number;
  /** Task revision; changing it makes earlier decisions unreachable. Default "". */
  revision?: string;
  /**
   * Physical asks this reduce may still make under the caller's budget (e.g. what is left of a
   * per-task budget). Lowers `limits.maxAsks` for this call only; candidates beyond it stay
   * unscored (`unscored_budget`) while answers already obtained and cached decisions still apply.
   */
  maxAsks?: number;
  signal?: AbortSignal;
}

export interface ReduceOutput {
  /** The input array itself when unchanged; otherwise a new array reusing untouched objects. */
  messages: readonly PiMessage[];
  changed: boolean;
  reason: ReduceReason;
  /** Error category when `reason` is `jev_unavailable`. */
  jevError?: JevErrorKind;
  /**
   * Per tool result, in session order. When `changed` is false nothing was applied, whatever a
   * decision says (e.g. cancelled after archiving); candidates not reached keep reason `kept`.
   */
  decisions: ResultDecision[];
  stats: ReduceStats;
}

/** Content-free summary for telemetry; never carries message text. */
export interface ContextReduceEvent {
  reason: ReduceReason;
  changed: boolean;
  jevError?: JevErrorKind;
  durationMs: number;
  stats: ReduceStats;
}

export interface ContextReducerDeps {
  ask: ContextAsk;
  store: ContextStore;
  /** Epoch milliseconds; used for `durationMs` only. */
  clock: () => number;
  limits?: ContextLimits;
  cache?: DecisionCache;
  /** Provider profile and pinned model, e.g. "typesafe/jev-1.13.0"; part of the cache key. */
  policyId?: string;
  /** Called once per reduce; throwing cannot change the result. */
  telemetry?: (event: ContextReduceEvent) => void;
}

export interface ContextReducer {
  reduce(input: ReduceInput): Promise<ReduceOutput>;
  readonly cache: DecisionCache;
}

function finiteOr(value: number | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function intOr(value: number | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, value) : fallback;
}

export function resolveLimits(limits: ContextLimits = {}): ResolvedContextLimits {
  const d = DEFAULT_CONTEXT_LIMITS;
  return {
    recentTurns: intOr(limits.recentTurns, d.recentTurns, 0),
    keepThreshold: finiteOr(limits.keepThreshold, d.keepThreshold, 0),
    minChars: finiteOr(limits.minChars, d.minChars, 0),
    maxWindowChars: finiteOr(limits.maxWindowChars, d.maxWindowChars, 1),
    maxAsks: intOr(limits.maxAsks, d.maxAsks, 0),
    maxStateTokens: finiteOr(limits.maxStateTokens, d.maxStateTokens, 1),
    maxRequestTokens: finiteOr(limits.maxRequestTokens, d.maxRequestTokens, 1),
    headChars: intOr(limits.headChars, d.headChars, 0),
  };
}

const SENTINEL_TEXT = "(start of this stretch of history)";

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 20;
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/** The fast-jev view of one message. Result text goes in only for pairing and its length. */
function toKernel(ctx: ContextMessage): KernelMessage {
  if (ctx.toolResult) {
    const { toolCallId, text, isError } = ctx.toolResult;
    return { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: toolCallId, text, isError }] };
  }
  if (ctx.role === "assistant") {
    return {
      role: "assistant",
      text: ctx.text,
      toolUses: ctx.toolCalls.map((call) => ({ tool_use_id: call.id, tool: call.name, input: inputRecord(call.arguments) })),
    };
  }
  return { role: "user", text: ctx.text, toolUses: [] };
}

/**
 * Consecutive windows of at most `maxChars`, never starting at a toolResult so a call and its
 * result stay together. A single oversized message becomes its own window.
 */
function splitWindows(messages: readonly ContextMessage[], maxChars: number): ContextMessage[][] {
  const windows: ContextMessage[][] = [];
  let current: ContextMessage[] = [];
  let size = 0;
  for (const ctx of messages) {
    const chars = ctx.text.length + ctx.toolCalls.reduce((sum, call) => sum + jsonLength(call.arguments), 0);
    if (current.length > 0 && size + chars > maxChars && ctx.role !== "toolResult") {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(ctx);
    size += chars;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/** Head excerpt that never ends on a lone high surrogate. */
function headOf(text: string, chars: number): string {
  if (chars <= 0) return "";
  let head = text.slice(0, chars);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head;
}

function withText(message: PiMessage, text: string): PiMessage {
  return { ...(message as unknown as Record<string, unknown>), content: [{ type: "text", text }] } as unknown as PiMessage;
}

interface Candidate {
  ctx: ContextMessage;
  digest: string;
  cached?: CachedDecision;
}

type AskFailure = { kind: "cancelled" } | { kind: "jev"; error: JevErrorKind };

export function createContextReducer(deps: ContextReducerDeps): ContextReducer {
  const limits = resolveLimits(deps.limits);
  const cache = deps.cache ?? createDecisionCache();
  const policy = `${deps.policyId ?? "default"}|${CONTEXT_POLICY_VERSION}|t=${limits.keepThreshold}`;
  const kernelOptions = resolveOptions({
    keepThreshold: limits.keepThreshold,
    preserveRecentMessages: 0,
    maxStateTokens: limits.maxStateTokens,
    maxRequestTokens: limits.maxRequestTokens,
    allowDroppingCalls: false,
  });
  const generations = new Map<string, number>();

  function emit(event: ContextReduceEvent): void {
    try {
      deps.telemetry?.(event);
    } catch {
      // Telemetry must not change the request.
    }
  }

  async function reduce(input: ReduceInput): Promise<ReduceOutput> {
    const started = deps.clock();
    const all = toContextMessages(input.messages, { recentTurns: limits.recentTurns });
    const charsBefore = all.reduce((sum, ctx) => sum + ctx.text.length, 0);
    const tokensBefore = all.reduce((sum, ctx) => sum + estimateTokens(ctx.text), 0);
    const stats: ReduceStats = {
      messages: all.length,
      toolResults: all.filter((ctx) => ctx.toolResult).length,
      candidates: 0,
      spilled: 0,
      spillFailures: 0,
      unscored: 0,
      cacheHits: 0,
      asks: 0,
      chars: { before: charsBefore, after: charsBefore },
      estimatedTokens: { before: tokensBefore, after: tokensBefore },
      maxStateTokens: 0,
    };
    const decisions: ResultDecision[] = [];

    const finish = (
      reason: ReduceReason,
      messages: readonly PiMessage[] = input.messages,
      jevError?: JevErrorKind,
    ): ReduceOutput => {
      const changed = messages !== input.messages;
      const output: ReduceOutput = {
        messages,
        changed,
        reason,
        ...(jevError ? { jevError } : {}),
        decisions,
        stats,
      };
      emit({ reason, changed, ...(jevError ? { jevError } : {}), durationMs: deps.clock() - started, stats });
      return output;
    };

    const latest = generations.get(input.sessionId);
    if (latest !== undefined && input.generation < latest) return finish("stale_generation");
    generations.delete(input.sessionId);
    generations.set(input.sessionId, input.generation);
    while (generations.size > 1024) generations.delete(generations.keys().next().value as string);
    const stale = (): boolean => (generations.get(input.sessionId) ?? input.generation) > input.generation;

    if (input.signal?.aborted) return finish("cancelled");
    cache.enter(input.sessionId, input.branchId);
    if (charsBefore < limits.minChars) return finish("below_min_chars");

    const scope: DecisionScope = {
      sessionId: input.sessionId,
      branchId: input.branchId,
      revision: input.revision ?? "",
      policy,
    };

    // 1. Classify every tool result.
    const candidates = new Map<string, Candidate>();
    const byIndex = new Map<number, ResultDecision>();
    for (const ctx of all) {
      const result = ctx.toolResult;
      if (!result) continue;
      let reason: ResultReason | undefined;
      if (!result.reducible) reason = result.reason as ResultReason;
      else if (result.toolName === RECALL_TOOL_NAME) reason = "recalled";
      else if (isSpillNotice(result.text)) reason = "already_spilled";
      const decision: ResultDecision = {
        index: ctx.index,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        action: "keep",
        reason: reason ?? "kept",
      };
      decisions.push(decision);
      byIndex.set(ctx.index, decision);
      if (reason) continue;
      const callCtx = all[result.callIndex as number];
      const call = callCtx?.toolCalls.find((c) => c.id === result.toolCallId);
      const digest = decisionDigest({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        arguments: call?.arguments,
        text: result.text,
        isError: result.isError,
      });
      const cached = cache.get(scope, digest);
      if (cached) stats.cacheHits += 1;
      candidates.set(result.toolCallId, { ctx, digest, ...(cached ? { cached } : {}) });
    }
    stats.candidates = candidates.size;
    if (candidates.size === 0) return finish("no_candidates");

    // 2. Ask Jev about uncached candidates, window by window, oldest first, within budget.
    const goal = goalFromMessages(all);
    const fresh = new Map<string, number>();
    const unscored = new Map<string, ResultReason>();
    const maxAsks = typeof input.maxAsks === "number" && Number.isInteger(input.maxAsks) ? Math.max(0, Math.min(limits.maxAsks, input.maxAsks)) : limits.maxAsks;
    let maxStateTokens = 0;
    const askAll = async (): Promise<AskFailure | undefined> => {
      for (const window of splitWindows(all, limits.maxWindowChars)) {
        const pending = new Set(
          window
            .filter((ctx) => ctx.toolResult && candidates.get(ctx.toolResult.toolCallId)?.ctx === ctx)
            .map((ctx) => ctx.toolResult!.toolCallId)
            .filter((id) => !candidates.get(id)?.cached),
        );
        if (pending.size === 0) continue;
        if (stats.asks >= maxAsks) {
          for (const id of pending) unscored.set(id, "unscored_budget");
          continue;
        }
        const kernel: KernelMessage[] = [{ role: "user", text: SENTINEL_TEXT, toolUses: [] }, ...window.map(toKernel)];
        const calls: KernelCall[] = collectToolCalls(kernel, 0).map((call) => ({
          ...call,
          pinned: !pending.has(call.tool_use_id),
        }));
        const toAsk = calls.filter((call) => !call.pinned);
        for (const id of pending) if (!toAsk.some((call) => call.tool_use_id === id)) unscored.set(id, "unscored_state");
        if (toAsk.length === 0) continue;
        let batches: KernelCall[][];
        let state: Record<string, unknown>;
        let stateTokens: number;
        try {
          const fitted = fitState(kernel, calls, { ...kernelOptions, goal });
          const scorable = toAsk.filter((call) => fitted.representedCalls.has(call.id));
          for (const call of toAsk) if (!scorable.includes(call)) unscored.set(call.tool_use_id, "unscored_state");
          batches = scorable.length > 0 ? batchCalls(scorable, fitted.tokens, kernelOptions) : [];
          state = { context: fitted.state.context, goal: fitted.state.goal, history: fitted.state.history };
          stateTokens = fitted.tokens;
        } catch {
          for (const call of toAsk) unscored.set(call.tool_use_id, "unscored_state");
          continue;
        }
        for (const batch of batches) {
          if (stats.asks >= maxAsks) {
            for (const call of batch) unscored.set(call.tool_use_id, "unscored_budget");
            continue;
          }
          if (input.signal?.aborted) return { kind: "cancelled" };
          const questions: NoulQuestion[] = batch.map((call) => {
            const name = `result_${call.id}`;
            const question = questionsFor(call)[name];
            return { id: name, question: question?.instructions ?? name };
          });
          stats.asks += 1;
          maxStateTokens = Math.max(maxStateTokens, stateTokens);
          const answer = await deps.ask({ state, questions, ...(input.signal ? { signal: input.signal } : {}) });
          if (input.signal?.aborted) return { kind: "cancelled" };
          if (!answer.ok) return answer.error.kind === "aborted" ? { kind: "cancelled" } : { kind: "jev", error: answer.error.kind };
          const yes = new Map(answer.evidence.map((evidence) => [evidence.questionId, evidence.yes]));
          for (const call of batch) {
            const value = yes.get(`result_${call.id}`);
            if (typeof value !== "number" || !Number.isFinite(value)) return { kind: "jev", error: "malformed" };
            fresh.set(call.tool_use_id, value);
          }
        }
      }
      return undefined;
    };
    const failure = await askAll();
    stats.maxStateTokens = maxStateTokens;
    if (failure?.kind === "cancelled") return finish("cancelled");
    if (failure) return finish("jev_unavailable", input.messages, failure.error);

    // 3. Decide, archive, and collect replacements. Cache writes are held until commit.
    const writes: Array<{ digest: string; decision: CachedDecision }> = [];
    const replacements = new Map<number, string>();
    for (const [id, candidate] of candidates) {
      const decision = byIndex.get(candidate.ctx.index) as ResultDecision;
      const text = candidate.ctx.toolResult!.text;
      let verdict: CachedDecision;
      if (candidate.cached) {
        verdict = candidate.cached;
        decision.source = "cache";
      } else if (fresh.has(id)) {
        const keepResult = fresh.get(id) as number;
        const call = decideCall(
          { id, tool: decision.toolName, pinned: false },
          { keepCall: 1, keepResult },
          { keepThreshold: limits.keepThreshold, allowDroppingCalls: false },
        );
        verdict = { verdict: call.action === "keep" ? "keep" : "drop", keepResult };
        decision.source = "jev";
      } else {
        decision.reason = unscored.get(id) ?? "unscored_budget";
        stats.unscored += 1;
        continue;
      }
      decision.keepResult = verdict.keepResult;
      if (verdict.verdict === "keep") {
        decision.reason = "kept";
        if (!candidate.cached) writes.push({ digest: candidate.digest, decision: verdict });
        continue;
      }
      if (verdict.replacement !== undefined && verdict.handle !== undefined) {
        replacements.set(candidate.ctx.index, verdict.replacement);
        Object.assign(decision, { action: "spill", reason: "spilled", handle: verdict.handle });
        continue;
      }
      // Drop verdict without an archived copy yet: archive only when it actually saves chars.
      const head = text.length > limits.headChars ? headOf(text, limits.headChars) : "";
      const meta = { chars: text.length, ...(head ? { head } : {}) };
      const projected = spillNotice(formatHandle(input.sessionId, "0".repeat(64)), meta);
      if (projected.length >= text.length) {
        decision.reason = "no_saving";
        if (!candidate.cached) writes.push({ digest: candidate.digest, decision: verdict });
        continue;
      }
      if (input.signal?.aborted) return finish("cancelled");
      const stored = await deps.store(text, input.sessionId);
      if (!stored.ok) {
        decision.reason = "spill_failed";
        decision.spillError = stored.reason;
        stats.spillFailures += 1;
        // The verdict is kept so the next request retries the archive without asking Jev.
        if (!candidate.cached) writes.push({ digest: candidate.digest, decision: verdict });
        continue;
      }
      const replacement = spillNotice(stored.handle, meta);
      replacements.set(candidate.ctx.index, replacement);
      Object.assign(decision, { action: "spill", reason: "spilled", handle: stored.handle });
      writes.push({ digest: candidate.digest, decision: { ...verdict, replacement, handle: stored.handle } });
    }

    // 4. Commit only for the latest, uncancelled generation.
    if (input.signal?.aborted) return finish("cancelled");
    if (stale()) return finish("stale_generation");
    for (const write of writes) cache.set(scope, write.digest, write.decision);
    if (replacements.size === 0) return finish("nothing_dropped");

    const out = input.messages.map((message, index) => {
      const replacement = replacements.get(index);
      return replacement === undefined ? message : withText(message, replacement);
    });
    for (const [index, replacement] of replacements) {
      const original = all[index]!.text;
      stats.chars.after += replacement.length - original.length;
      stats.estimatedTokens.after += estimateTokens(replacement) - estimateTokens(original);
    }
    stats.spilled = replacements.size;
    return finish("reduced", out);
  }

  return { reduce, cache };
}
