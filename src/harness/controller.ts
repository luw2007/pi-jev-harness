/**
 * Lifecycle controller (technical design §7.2, §7.3, §10).
 *
 * A pure state machine: `running → checking → verifying → completed / blocked /
 * incomplete / verification_unavailable`, with `continuing` as one bounded hop
 * back to `running`. Pi keeps the real agent loop; the controller only decides
 * state and returns a suggestion the caller executes.
 *
 * - `before_settle` is the only boundary that may propose a continuation.
 * - `settled` only closes the record; it never starts another turn.
 * - After every await the generation, checkpoint and mode are re-checked; stale
 *   decisions are discarded with a recorded reason. A tool result or a milestone
 *   arriving while a `before_settle` is in flight is new activity: it opens a new
 *   checkpoint, so the in-flight decision is discarded as `stale:checkpoint`.
 * - One assessment per checkpoint; a checkpoint advances only on new progress
 *   (a tool result, a continuation, a user message or an invalidation). A
 *   milestone assesses the current checkpoint without opening a new one, so a
 *   milestone followed by `before_settle` without new progress shares one
 *   assessment (the compatibility tools and the automatic path never pay twice).
 *   Exception: a milestone `foreman` result was judged with an active worker and
 *   can never allow finishing, so `before_settle` assesses that checkpoint once
 *   more at its own boundary (at most one extra assessment per checkpoint).
 * - Continuations are counted per controller; the adapter creates one controller
 *   per user task, so a mid-task user message does not reset the count.
 *
 * `assess` returns the real `CompletionResult` (`./completion.ts`); `decide`
 * returns the real `ContinuationDecision` (`./continuation.ts`) and is the thin
 * seam where the caller turns `DecideInput` plus host observations into a
 * `ContinuationInput` for `decideContinuation`.
 */
import { COMPLETION_POLICY_VERSION, type AssessmentKind, type CompletionResult, type CompletionStatus } from "./completion.ts";
import type { ContinuationDecision } from "./continuation.ts";
import type { TaskStatus } from "./run-artifacts.ts";

export type ControllerMode = "off" | "shadow" | "on";

export interface AssessContext {
  sessionId: string | null;
  generation: number;
  checkpoint: number;
  boundary: "milestone" | "before_settle";
  /** Label of the milestone that opened this checkpoint, if any. */
  milestone: string | null;
  /** Evidence collected from `tool_result` events, oldest first. */
  evidence: readonly unknown[];
  continuations: number;
}

/** Controller facts handed to `decide`; the caller adds host observations for `decideContinuation`. */
export interface DecideInput {
  sessionId: string | null;
  generation: number;
  checkpoint: number;
  mode: ControllerMode;
  completion: CompletionResult;
  continuations: number;
  maxContinuations: number;
}

export type AssessFn = (ctx: AssessContext) => CompletionResult | Promise<CompletionResult>;
export type DecideFn = (input: DecideInput) => ContinuationDecision | Promise<ContinuationDecision>;

export interface ControllerOptions {
  assess: AssessFn;
  decide: DecideFn;
  /** Clock for transition timestamps (ms). Injected; the controller never reads a clock. */
  now: () => number;
  mode?: ControllerMode;
  /** Controller-side backstop; `decide` owns the policy limit. Default 2 (§7.3). */
  maxContinuations?: number;
  sessionId?: string | null;
  /** Assessment kind stamped on the `unavailable` result synthesized when `assess` throws. Default acceptance. */
  assessmentKind?: AssessmentKind;
}

export type ActivePhase = "running" | "checking" | "verifying" | "continuing";
export type ControllerPhase = ActivePhase | TaskStatus;

export type ControllerEvent =
  | { type: "tool_result"; evidence: unknown }
  | { type: "milestone"; label?: string }
  | { type: "before_settle" }
  | { type: "settled" }
  | { type: "user_message" }
  | { type: "cancel" }
  | { type: "mode_change"; mode: ControllerMode }
  | { type: "session_switch"; sessionId: string | null };

export type ControllerResult =
  | { continue: true; prompt: string }
  | { continue: false; phase: ControllerPhase; reason?: string };

export interface ControllerTransition {
  at: number;
  from: ControllerPhase;
  to: ControllerPhase;
  event: ControllerEvent["type"];
  generation: number;
  reason?: string;
}

export interface DiscardedDecision {
  at: number;
  boundary: "milestone" | "before_settle";
  generation: number;
  checkpoint: number;
  reason: string;
}

export interface ControllerSnapshot {
  phase: ControllerPhase;
  mode: ControllerMode;
  sessionId: string | null;
  generation: number;
  checkpoint: number;
  continuations: number;
  maxContinuations: number;
  assessments: number;
  lastCompletion: CompletionResult | null;
  /** Last `decide` answer applied or refused by the guard; null when decide did not run or threw. */
  lastDecision: ContinuationDecision | null;
  /** Why the last `before_settle` stopped (guard, decide reasons, `completion_unavailable`, `decide_error: …`). */
  lastStopReason: string | null;
  settled: boolean;
  transitions: ControllerTransition[];
  discarded: DiscardedDecision[];
}

export interface Controller {
  handle(event: ControllerEvent): Promise<ControllerResult>;
  snapshot(): ControllerSnapshot;
}

const ACTIVE: ReadonlySet<ControllerPhase> = new Set<ControllerPhase>(["running", "checking", "verifying", "continuing"]);

const STOP_PHASE: Record<CompletionStatus, TaskStatus> = {
  passed: "completed",
  incomplete: "incomplete",
  blocked: "blocked",
  unavailable: "verification_unavailable",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createController(options: ControllerOptions): Controller {
  const { assess, decide, now } = options;
  const maxContinuations = options.maxContinuations ?? 2;

  let phase: ControllerPhase = "running";
  let mode: ControllerMode = options.mode ?? "on";
  let sessionId: string | null = options.sessionId ?? null;
  let generation = 0;
  let checkpoint = 0;
  let milestone: string | null = null;
  let evidence: unknown[] = [];
  let continuations = 0;
  let assessments = 0;
  let lastCompletion: CompletionResult | null = null;
  let lastDecision: ContinuationDecision | null = null;
  let lastStopReason: string | null = null;
  let settled = false;
  let invalidatedBy = "none";
  const transitions: ControllerTransition[] = [];
  const discarded: DiscardedDecision[] = [];

  // One assessment per (generation, checkpoint): cached result or shared in-flight promise.
  let assessed: { generation: number; checkpoint: number; boundary: AssessContext["boundary"]; result: Promise<CompletionResult> } | null = null;
  let settling: { generation: number; checkpoint: number; result: Promise<ControllerResult> } | null = null;
  /** `before_settle` runs not yet resolved (also counts runs a later invalidation detached). */
  let settleInFlight = 0;

  function moveTo(to: ControllerPhase, event: ControllerEvent["type"], reason?: string) {
    if (to === phase) return;
    transitions.push({ at: now(), from: phase, to, event, generation, ...(reason === undefined ? {} : { reason }) });
    phase = to;
  }

  function invalidate(by: string) {
    generation += 1;
    checkpoint += 1;
    invalidatedBy = by;
    assessed = null;
    settling = null;
  }

  function stale(gen: number, cp: number): string | null {
    if (gen !== generation) return `stale:${invalidatedBy}`;
    if (cp !== checkpoint) return "stale:checkpoint";
    if (mode === "off") return "mode_off";
    if (!ACTIVE.has(phase)) return `phase:${phase}`;
    return null;
  }

  function discard(boundary: DiscardedDecision["boundary"], gen: number, cp: number, reason: string): ControllerResult {
    discarded.push({ at: now(), boundary, generation: gen, checkpoint: cp, reason });
    return { continue: false, phase, reason };
  }

  function assessOnce(boundary: AssessContext["boundary"]): Promise<CompletionResult> {
    const cached = assessed;
    if (cached && cached.generation === generation && cached.checkpoint === checkpoint) {
      if (boundary !== "before_settle" || cached.boundary !== "milestone") return cached.result;
      // A foreman result from a milestone cannot be FINISH (active worker): settle needs its own
      // boundary's answer (M1). Other kinds do not depend on the boundary and are shared.
      return cached.result.then((result) =>
        result.assessment === "foreman" && assessed === cached && generation === cached.generation && checkpoint === cached.checkpoint
          ? startAssess(boundary)
          : result);
    }
    return startAssess(boundary);
  }

  function startAssess(boundary: AssessContext["boundary"]): Promise<CompletionResult> {
    assessments += 1;
    const ctx: AssessContext = {
      sessionId,
      generation,
      checkpoint,
      boundary,
      milestone,
      evidence: [...evidence],
      continuations,
    };
    // §9.3: an unavailable completion assessment stays "unavailable", never "passed".
    const result = Promise.resolve()
      .then(() => assess(ctx))
      .catch(
        (error): CompletionResult => ({
          assessment: options.assessmentKind ?? "acceptance",
          policyVersion: COMPLETION_POLICY_VERSION,
          validation: { ok: true, errors: [] },
          completionStatus: "unavailable",
          stopAllowed: true,
          gaps: [],
          evidenceRefs: [],
          reason: `assess_error: ${errorText(error)}`,
          model: null,
        }),
      );
    assessed = { generation, checkpoint, boundary, result };
    return result;
  }

  async function onMilestone(label: string | null): Promise<ControllerResult> {
    // Assesses the current checkpoint; only new progress opens the next one.
    milestone = label;
    if (mode === "off" || !ACTIVE.has(phase)) return { continue: false, phase, reason: mode === "off" ? "mode_off" : `phase:${phase}` };
    // During an in-flight before_settle the agent is still acting: that check is stale.
    if (settleInFlight > 0) checkpoint += 1;
    const gen = generation;
    const cp = checkpoint;
    moveTo("checking", "milestone");
    const completion = await assessOnce("milestone");
    const why = stale(gen, cp);
    if (why) return discard("milestone", gen, cp, why);
    lastCompletion = completion;
    moveTo("running", "milestone");
    return { continue: false, phase };
  }

  async function runBeforeSettle(): Promise<ControllerResult> {
    const gen = generation;
    const cp = checkpoint;
    moveTo("checking", "before_settle");
    const completion = await assessOnce("before_settle");
    let why = stale(gen, cp);
    if (why) return discard("before_settle", gen, cp, why);
    lastCompletion = completion;

    if (completion.completionStatus === "unavailable") {
      lastDecision = null;
      lastStopReason = "completion_unavailable";
      moveTo("verification_unavailable", "before_settle", "completion_unavailable");
      return { continue: false, phase, reason: "completion_unavailable" };
    }

    moveTo("verifying", "before_settle");
    let decision: ContinuationDecision | null;
    let decideError: string | null = null;
    try {
      decision = await decide({
        sessionId,
        generation: gen,
        checkpoint: cp,
        mode,
        completion,
        continuations,
        maxContinuations,
      });
    } catch (error) {
      decision = null;
      decideError = `decide_error: ${errorText(error)}`;
    }
    why = stale(gen, cp);
    if (why) return discard("before_settle", gen, cp, why);
    lastDecision = decision;

    const guard =
      decision?.decision !== "continue"
        ? null
        : mode !== "on"
          ? "guard:shadow_mode"
          : completion.completionStatus !== "incomplete"
            ? `guard:completion_${completion.completionStatus}`
            : continuations >= maxContinuations
              ? "guard:continuation_cap"
              : !decision.prompt.trim()
                ? "guard:missing_prompt"
                : null;

    if (decision?.decision === "continue" && guard === null) {
      continuations += 1;
      lastStopReason = null;
      moveTo("continuing", "before_settle", decision.actions.join("; ") || undefined);
      checkpoint += 1;
      milestone = null;
      moveTo("running", "before_settle");
      return { continue: true, prompt: decision.prompt };
    }

    const reason =
      guard ?? decideError ?? (decision?.decision === "stop" ? decision.reasons.join("; ") || "stop" : "stop");
    lastStopReason = reason;
    moveTo(STOP_PHASE[completion.completionStatus], "before_settle", reason);
    return { continue: false, phase, reason };
  }

  function onBeforeSettle(): Promise<ControllerResult> {
    if (mode === "off") return Promise.resolve({ continue: false, phase, reason: "mode_off" });
    if (settling && settling.generation === generation && settling.checkpoint === checkpoint) return settling.result;
    if (!ACTIVE.has(phase)) return Promise.resolve({ continue: false, phase, reason: `phase:${phase}` });
    settleInFlight += 1;
    const result = runBeforeSettle().finally(() => {
      settleInFlight -= 1;
    });
    settling = { generation, checkpoint, result };
    return result;
  }

  function onSettled(): ControllerResult {
    // Closing notification only: in-flight work is invalidated, never resumed here.
    settled = true;
    invalidate("settled");
    if (ACTIVE.has(phase)) moveTo(mode === "off" ? "incomplete" : "verification_unavailable", "settled", "settled_without_checkpoint");
    return { continue: false, phase };
  }

  async function handle(event: ControllerEvent): Promise<ControllerResult> {
    switch (event.type) {
      case "tool_result":
        evidence.push(event.evidence);
        checkpoint += 1;
        // An in-flight check is now stale (discarded when it returns); the agent is running again.
        if (phase === "checking" || phase === "verifying") moveTo("running", "tool_result", "new_progress");
        // Progress after a stop means the host kept going (a queued message, another extension's
        // continuation): the task is active again. Cancel and settle stay final.
        if (!ACTIVE.has(phase) && phase !== "cancelled" && !settled) moveTo("running", "tool_result", "resumed");
        return { continue: false, phase };
      case "milestone":
        return onMilestone(event.label ?? null);
      case "before_settle":
        return onBeforeSettle();
      case "settled":
        return onSettled();
      case "user_message":
        // The count stays: continuations are bounded per user task (one controller per task).
        invalidate("user_message");
        settled = false;
        milestone = null;
        moveTo("running", "user_message");
        return { continue: false, phase };
      case "cancel":
        invalidate("cancel");
        moveTo("cancelled", "cancel");
        return { continue: false, phase };
      case "mode_change":
        if (event.mode === mode) return { continue: false, phase };
        mode = event.mode;
        invalidate(`mode_change:${event.mode}`);
        if (ACTIVE.has(phase)) moveTo("running", "mode_change", `mode:${event.mode}`);
        return { continue: false, phase };
      case "session_switch":
        invalidate("session_switch");
        sessionId = event.sessionId;
        evidence = [];
        continuations = 0;
        milestone = null;
        lastCompletion = null;
        lastDecision = null;
        lastStopReason = null;
        settled = false;
        moveTo("running", "session_switch");
        return { continue: false, phase };
    }
  }

  function snapshot(): ControllerSnapshot {
    return structuredClone({
      phase,
      mode,
      sessionId,
      generation,
      checkpoint,
      continuations,
      maxContinuations,
      assessments,
      lastCompletion,
      lastDecision,
      lastStopReason,
      settled,
      transitions,
      discarded,
    });
  }

  return { handle, snapshot };
}
