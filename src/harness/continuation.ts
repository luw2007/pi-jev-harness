// Adapted from omp-jev-extensions@0f93c809c2088c61fab4e613807e515ff9e65b1a:extensions/jev-autorun/jev-autorun.ts (MIT)
/**
 * Bounded continuation decision (technical design §4.3 "有界续跑", §7.3, §9.3 row
 * "续跑评估不可用或会话过期"). A pure function: it only answers whether the host may
 * trigger one more continuation and why not. It drives no loop, asks no Jev, and reads
 * no environment, network, or clock; the caller passes the Jev assessment it already
 * obtained (or `undefined` when Jev was unavailable) plus host observations taken before
 * and after that await.
 *
 * Not ported from O: the model / effort / tool-group setters (router owns them) and the
 * extra approval layer (approvals stay with the existing authorization boundary).
 */

/** Uncalibrated starting point carried over from O: continue only while `done` is below this. */
export const CONTINUATION_DONE_THRESHOLD = 0.8;
/** Uncalibrated starting point carried over from O: continue only when `autonomous` reaches this. */
export const CONTINUATION_AUTONOMOUS_THRESHOLD = 0.8;
/** Uncalibrated starting point carried over from O: at most two automatic continuations per goal. */
export const DEFAULT_MAX_CONTINUATIONS = 2;

/** Every stop reason, in the order they are reported. */
export const CONTINUATION_STOP_REASONS = Object.freeze([
  "invalid_input",
  "jev_unavailable",
  "already_done",
  "not_autonomous",
  "limit_reached",
  "over_budget",
  "cancelled",
  "pending_user_message",
  "blocked_external",
  "background_tasks_running",
  "session_changed",
  "branch_changed",
  "generation_changed",
  "mode_changed",
  "no_unfinished_actions",
] as const);
export type ContinuationStopReason = (typeof CONTINUATION_STOP_REASONS)[number];

/** Jev's two Noul answers for this checkpoint, as probabilities in [0, 1]. */
export interface ContinuationAssessment {
  /** P(every requested item is done with observable proof). */
  done: number;
  /** P(a concrete unfinished action can be taken next turn without new user input). */
  autonomous: number;
}

/** Host identity observed before and after the Jev await; any change voids the decision. */
export interface ContinuationSnapshot {
  sessionId: string;
  branchId: string;
  generation: number;
  mode: string;
}

export interface ContinuationThresholds {
  done?: number;
  autonomous?: number;
}

export interface ContinuationInput {
  /** Parsed Jev answers; `undefined` means Jev was unavailable or its answer was unusable. */
  assessment: ContinuationAssessment | undefined;
  /** Automatic continuations already used for the current goal. */
  continuationsUsed: number;
  /** Defaults to `DEFAULT_MAX_CONTINUATIONS`. */
  maxContinuations?: number;
  /** Remaining budget in the caller's unit; a continuation needs a positive remainder. */
  budgetRemaining: number;
  cancelled: boolean;
  pendingUserMessage: boolean;
  /** An approval the host is waiting on; an external blocker, never a retry trigger. */
  pendingApproval: boolean;
  /** Concrete external gaps (e.g. a missing credential); reported back verbatim. */
  externalBlockers: readonly string[];
  runningBackgroundTasks: number;
  before: ContinuationSnapshot;
  after: ContinuationSnapshot;
  /** Concrete unfinished actions from the completion check; drives the continuation prompt. */
  unfinishedActions: readonly string[];
  thresholds?: ContinuationThresholds;
}

export type ContinuationDecision =
  | { decision: "continue"; prompt: string; actions: readonly string[] }
  | { decision: "stop"; reasons: readonly ContinuationStopReason[]; blockers: readonly string[] };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Returns `continue` only when every condition holds; otherwise `stop` with every unmet
 * condition. Malformed probabilities count as Jev unavailable (no clamping, §9.1).
 * A `continuationsUsed` / `maxContinuations` that is not a non-negative integer, or a
 * NaN / non-number budget, stops as `invalid_input` instead of being compared.
 */
export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  const reasons = new Set<ContinuationStopReason>();
  const doneThreshold = input.thresholds?.done ?? CONTINUATION_DONE_THRESHOLD;
  const autonomousThreshold = input.thresholds?.autonomous ?? CONTINUATION_AUTONOMOUS_THRESHOLD;
  const max = input.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;

  const assessment = input.assessment;
  if (!assessment || !isProbability(assessment.done) || !isProbability(assessment.autonomous)) {
    reasons.add("jev_unavailable");
  } else {
    // Negated comparisons so a NaN threshold fails closed.
    if (!(assessment.done < doneThreshold)) reasons.add("already_done");
    if (!(assessment.autonomous >= autonomousThreshold)) reasons.add("not_autonomous");
  }
  if (!isCount(input.continuationsUsed) || !isCount(max)) reasons.add("invalid_input");
  else if (!(input.continuationsUsed < max)) reasons.add("limit_reached");
  const budget = input.budgetRemaining;
  if (typeof budget !== "number" || Number.isNaN(budget)) reasons.add("invalid_input");
  else if (!(budget > 0)) reasons.add("over_budget");
  if (input.cancelled) reasons.add("cancelled");
  if (input.pendingUserMessage) reasons.add("pending_user_message");
  const blockers = input.externalBlockers.map((item) => item.trim()).filter((item) => item.length > 0);
  if (input.pendingApproval) blockers.unshift("pending approval");
  if (blockers.length > 0) reasons.add("blocked_external");
  if (!(input.runningBackgroundTasks <= 0)) reasons.add("background_tasks_running");
  if (input.before.sessionId !== input.after.sessionId) reasons.add("session_changed");
  if (input.before.branchId !== input.after.branchId) reasons.add("branch_changed");
  if (input.before.generation !== input.after.generation) reasons.add("generation_changed");
  if (input.before.mode !== input.after.mode) reasons.add("mode_changed");
  const actions = input.unfinishedActions.map((item) => item.trim()).filter((item) => item.length > 0);
  if (actions.length === 0) reasons.add("no_unfinished_actions");

  if (reasons.size > 0) {
    return {
      decision: "stop",
      reasons: CONTINUATION_STOP_REASONS.filter((reason) => reasons.has(reason)),
      blockers,
    };
  }
  return {
    decision: "continue",
    prompt: buildContinuationPrompt(actions, input.continuationsUsed + 1, max),
    actions,
  };
}

/** Prompt built from the concrete actions; never a generic "keep going". */
export function buildContinuationPrompt(actions: readonly string[], attempt: number, max: number): string {
  return [
    `Automatic continuation ${attempt} of ${max}. Complete these unfinished actions from the user's request:`,
    ...actions.map((action) => `- ${action}`),
    "Verify each result before reporting completion. If one needs new user input, credentials, or approval, stop and name that gap instead.",
  ].join("\n");
}
