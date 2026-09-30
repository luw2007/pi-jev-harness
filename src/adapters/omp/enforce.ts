/**
 * T105 C2: enforced envelope review at OMP `tool_call`.
 *
 * Same decision path as the Pi harness enforce branch (`../pi/harness.ts` toolCall/prepareReview/
 * review), built on the same host-neutral harness primitives; the Pi run products (receipts,
 * changeset, run.json) are not part of this capability.
 * - Only kinds listed in `harness.enforce` are touched; everything else returns undefined at once.
 * - mode `on`: validation failure blocks with no Jev request; otherwise the review is awaited and
 *   anything but permit blocks; a permitted action whose target changed meanwhile blocks as stale.
 *   The wait is capped at min(`budget.waitMs`, 25 s) so the handler returns before OMP's 30 s
 *   tool_call timeout (a timed-out handler would block anyway, without a reason).
 * - mode `shadow`: never blocks, never awaits Jev; the would-block is recorded in the background.
 * Nothing leaves the machine unless `outbound.taskIntent` allows it and no credential shape appears;
 * in `on` that makes the review unavailable, so the action is blocked (fail closed, like Pi).
 */
import * as nodeFs from "node:fs/promises";
import {
  ACTION_KINDS,
  buildEnvelope,
  checkFreshness,
  reviewAction,
  toReviewableAction,
  validateEnvelope,
  type ActionEnvelope,
  type AllowedReviewContext,
  type AuthorizationScope,
  type NoulAsk,
  type ReviewableAction,
} from "../../harness/index.ts";
import type { JevClient } from "../../jev/index.ts";
import type { LoadedConfig } from "./shared.ts";
import { containsCredential } from "./shared.ts";

/**
 * Cap of the whole wait inside one tool_call handler (enforce + approval + human confirm): below
 * OMP's default 30 s `extensionHandlers.toolCallTimeoutMs`, with room for local work. OMP 18.3.5
 * does not expose that setting to extensions, so a lowered host timeout is not followed; upgrade
 * when the extension API exposes settings.
 */
export const ENFORCE_MAX_WAIT_MS = 25_000;

export const DEADLINE_REASON = "deadline";

/** Part of the handler deadline kept for the human confirm when a UI is available. */
export const CONFIRM_RESERVE_MS = 15_000;

/** Deadlines (real clock) of one tool_call handler: Jev waits end at `jevAt`, everything at `overallAt`. */
export interface ToolCallDeadline {
  jevAt: number;
  overallAt: number;
}

/**
 * Overall: the 25 s cap. Jev waits (enforce + approval): min(waitMs, cap − confirm reserve); the
 * reserve applies only when the human can be asked (UI + approval on), else Jev may use the whole cap.
 */
export function toolCallDeadline(waitMs: number, reserveForConfirm: boolean): ToolCallDeadline {
  const now = Date.now();
  return { jevAt: now + Math.min(waitMs, ENFORCE_MAX_WAIT_MS - (reserveForConfirm ? CONFIRM_RESERVE_MS : 0)), overallAt: now + ENFORCE_MAX_WAIT_MS };
}

export function deadlineBlock(waitMs: number): string {
  return `tool_call wait limit reached (${Math.min(waitMs, ENFORCE_MAX_WAIT_MS)} ms); the action is not executed`;
}
/** Same per-file ceiling as the Pi harness grant. */
const MAX_FILE_BYTES = 1_048_576;

export type EnforceMode = "shadow" | "on";

export interface EnforceDeps {
  config: LoadedConfig["config"];
  /** Every Jev key of the session (`JevAccess.secrets`) when the capability has a usable provider; undefined = none. */
  secrets: readonly string[] | undefined;
  jev: () => JevClient | undefined;
  newId: () => string;
  /** Per-task Jev request budget; false when exhausted. */
  reserve: () => boolean;
  /** Recorded once per decision: blocked / would_block / permit / unavailable. */
  onDecision: (outcome: "blocked" | "would_block" | "ok" | "skipped", reason: string) => void;
}

export interface EnforceTask {
  intent: string;
  cwd: string;
  pending: Set<Promise<void>>;
  controller: AbortController;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Prepared = { action: ReviewableAction; context: AllowedReviewContext } | string;

async function prepare(deps: EnforceDeps, task: EnforceTask, envelope: ActionEnvelope): Promise<Prepared> {
  if (!deps.config.outbound.taskIntent) return "outbound.taskIntent=false; review not sent";
  if (!deps.secrets) return "Jev key missing; review not sent";
  if (!task.intent.trim()) return "no task intent recorded for this task; review not sent";
  try {
    let preimage: string | undefined;
    if (envelope.kind !== "create" && envelope.preimage)
      preimage = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await nodeFs.readFile(envelope.preimage.path));
    const action = toReviewableAction(envelope, preimage);
    const change = action.kind === "edit" ? action.diff : action.content;
    if ([task.intent, change, preimage ?? ""].some((text) => containsCredential(text, deps.secrets))) return "credential detected; review withheld";
    return { action, context: { task: task.intent, ...(preimage === undefined ? {} : { preimage }) } };
  } catch (error) {
    return `review input unavailable: ${errorText(error)}`;
  }
}

/** Blocking reason, or null for permit. Never throws. */
async function review(deps: EnforceDeps, prepared: Prepared, signal: AbortSignal): Promise<string | null> {
  const unavailable = (reason: string) => `Enforced review unavailable: ${reason}. The action is not executed.`;
  if (typeof prepared === "string") return unavailable(prepared);
  const client = deps.jev();
  if (!client) return unavailable("Jev key missing; review not sent");
  if (!deps.reserve()) return unavailable("budget.maxRequestsPerTask reached");
  const ask: NoulAsk = (questions, options) => client.noul(questions, options);
  try {
    const result = await reviewAction({ action: prepared.action, allowedContext: prepared.context, ask, mode: "enforced", signal });
    return result.blocked;
  } catch (error) {
    return unavailable(`review failed: ${errorText(error)}`);
  }
}

export function newEnforceTask(intent: string, cwd: string): EnforceTask {
  return { intent, cwd, pending: new Set(), controller: new AbortController() };
}

/**
 * `tool_call` handler body. Returns a block reason (mode on only) or undefined.
 */
export async function enforceToolCall(
  deps: EnforceDeps,
  task: EnforceTask,
  mode: EnforceMode,
  event: { toolName: string; toolCallId: string; input: unknown },
  deadline: ToolCallDeadline,
): Promise<string | undefined> {
  const enforce: readonly string[] = deps.config.harness.enforce;
  if (enforce.length === 0) return undefined;
  const grant: AuthorizationScope = { id: `grant_${deps.newId()}`, kinds: ACTION_KINDS.filter((kind) => kind !== "unsupported"), maxFileBytes: MAX_FILE_BYTES };
  const policy = { fs: nodeFs, allowedRoots: [task.cwd], grants: [grant] };
  let envelope: ActionEnvelope;
  try {
    envelope = await buildEnvelope({ toolName: event.toolName, args: event.input, toolCallId: event.toolCallId }, { ...policy, cwd: task.cwd, newId: deps.newId });
  } catch (error) {
    // Fail closed only where blocking is enabled: a write whose kind could not be established.
    if (mode === "on" && event.toolName === "write") {
      const reason = `could not check the action (${errorText(error)})`;
      deps.onDecision("blocked", reason);
      return reason;
    }
    return undefined;
  }
  if (!enforce.includes(envelope.kind)) return undefined;
  const validation = await validateEnvelope(envelope, policy);

  if (mode === "shadow") {
    if (!validation.ok) {
      deps.onDecision("would_block", `validation failed: ${validation.reason}`);
      return undefined;
    }
    const pending = prepare(deps, task, envelope)
      .then((prepared) => review(deps, prepared, task.controller.signal))
      .then((blocked) => deps.onDecision(blocked === null ? "ok" : "would_block", blocked ?? "permit"))
      .catch(() => {});
    task.pending.add(pending);
    void pending.finally(() => task.pending.delete(pending));
    return undefined;
  }

  const block = (reason: string) => {
    deps.onDecision("blocked", reason);
    return reason;
  };
  if (!validation.ok) return block(`validation failed: ${validation.reason}`);
  const wait = new AbortController();
  const onTaskAbort = () => wait.abort(task.controller.signal.reason);
  task.controller.signal.addEventListener("abort", onTaskAbort, { once: true });
  const timer = setTimeout(() => wait.abort(DEADLINE_REASON), Math.max(0, deadline.jevAt - Date.now()));
  try {
    const blocked = await review(deps, await prepare(deps, task, envelope), wait.signal);
    if (wait.signal.aborted && wait.signal.reason === DEADLINE_REASON) return block(deadlineBlock(deps.config.budget.waitMs));
    if (blocked !== null) return block(blocked);
    const freshness = await checkFreshness(envelope, nodeFs);
    if (freshness.status === "stale") return block(`stale: ${freshness.reason}`);
    deps.onDecision("ok", "permit");
    return undefined;
  } catch (error) {
    return block(`enforced check failed: ${errorText(error)}`);
  } finally {
    clearTimeout(timer);
    task.controller.signal.removeEventListener("abort", onTaskAbort);
  }
}
