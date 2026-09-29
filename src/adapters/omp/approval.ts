/**
 * human approval of risky tool calls and the silent-tools steer reminder, with the
 * semantics of the legacy `jev-autorun` plugin (read-only reference), behind `approval.*` config.
 *
 * Approval (`approval.enabled`, default off), at `tool_call`:
 * - `allowTools`: pass. `denyTools`: always ask the human (no Jev request).
 * - any other tool: ask Jev "could this call be hard to reverse?" (name + arguments only); a risk
 *   ≥ `riskThreshold`, or no answer (Jev unavailable, outbound gate, credential, budget), asks the human.
 * - asking the human: `ui.confirm`; a denial blocks. No UI (print/RPC): `approval.noUi` (default deny).
 * - shadow: never asks, never blocks, never awaits Jev; records would-confirm only.
 *
 * Steer (`approval.silentSteer`, default off): after 5 tool results with no assistant text in
 * between, one reminder is steered into the run (at most 3 per user input); counters reset on
 * assistant text and on non-extension user input. shadow records would-steer only.
 */
import type { JevClient } from "../../jev/index.ts";
import type { HostSessionView } from "../core/port.ts";
import { containsCredential, type LoadedConfig } from "./shared.ts";
import { deadlineBlock, type ToolCallDeadline } from "./enforce.ts";

export const APPROVAL_TITLE = "Approve tool call";
export const APPROVAL_BLOCK_REASON = "Human approval required";
export const IRREVERSIBLE_QUESTION = "Could this proposed tool call be hard to reverse? Assess only its name and arguments.";
export const STEER_REMINDER = "Check the open checklist and show the user progress. Finish only when each item has evidence.";
export const STEER_THRESHOLD = 5;
export const MAX_STEERS = 3;
const MAX_CONFIRM_INPUT_CHARS = 2_000;

export type GateMode = "shadow" | "on";

export interface ApprovalDeps {
  config: LoadedConfig["config"];
  /** Every Jev key of the session (`JevAccess.secrets`) when the capability has a usable provider; undefined = none. */
  secrets: readonly string[] | undefined;
  jev: () => JevClient | undefined;
  newId: () => string;
  reserve: () => boolean;
  onDecision: (outcome: "approved" | "denied" | "would_confirm" | "no_ui_allow" | "no_ui_deny" | "timeout_allow" | "timeout_deny" | "deadline" | "low_risk", tool: string) => void;
}

function inputText(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    text = String(input);
  }
  return text.length > MAX_CONFIRM_INPUT_CHARS ? `${text.slice(0, MAX_CONFIRM_INPUT_CHARS)}…` : text;
}

/** Jev probability that the call is hard to reverse; undefined when no answer may or could be had. */
async function irreversibleRisk(deps: ApprovalDeps, toolName: string, input: unknown, signal: AbortSignal): Promise<number | undefined> {
  if (!deps.config.outbound.taskIntent || !deps.secrets) return undefined;
  const text = inputText(input);
  if (containsCredential(`${toolName}\n${text}`, deps.secrets)) return undefined;
  const client = deps.jev();
  if (!client || !deps.reserve()) return undefined;
  try {
    const result = await client.noul([{ id: "irreversible", question: IRREVERSIBLE_QUESTION }], {
      decisionId: `dec_${deps.newId()}`, state: { tool: toolName, input: text }, signal,
    });
    return result.ok ? result.evidence[0]?.yes : undefined;
  } catch {
    return undefined;
  }
}

/** `tool_call` handler body. Returns a block reason (mode on only) or undefined. */
export async function approveToolCall(
  deps: ApprovalDeps,
  mode: GateMode,
  event: { toolName: string; input: unknown },
  view: Pick<HostSessionView, "confirm">,
  pending: Set<Promise<void>>,
  deadline: ToolCallDeadline,
): Promise<string | undefined> {
  const approval = deps.config.approval;
  if (!approval.enabled) return undefined;
  // Legacy order: denyTools first, then allowTools.
  const denied = approval.denyTools.includes(event.toolName);
  if (!denied && approval.allowTools.includes(event.toolName)) return undefined;
  const needsHuman = (risk: number | undefined) => denied || risk === undefined || risk >= approval.riskThreshold;

  if (mode === "shadow") {
    if (denied) deps.onDecision("would_confirm", event.toolName);
    else {
      const job = irreversibleRisk(deps, event.toolName, event.input, new AbortController().signal)
        .then((risk) => deps.onDecision(needsHuman(risk) ? "would_confirm" : "low_risk", event.toolName));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }
    return undefined;
  }

  let risk: number | undefined;
  let jevTimedOut = false;
  if (!denied) {
    const wait = new AbortController();
    const timer = setTimeout(() => wait.abort("deadline"), Math.max(0, deadline.jevAt - Date.now()));
    try {
      risk = await irreversibleRisk(deps, event.toolName, event.input, wait.signal);
      jevTimedOut = wait.signal.aborted;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!needsHuman(risk)) {
    deps.onDecision("low_risk", event.toolName);
    return undefined;
  }
  const remaining = deadline.overallAt - Date.now();
  const deadlineBlocked = () => {
    deps.onDecision("deadline", event.toolName);
    return `${APPROVAL_BLOCK_REASON} (${deadlineBlock(deps.config.budget.waitMs)})`;
  };
  if (remaining <= 0) return deadlineBlocked();
  const answer = view.confirm(APPROVAL_TITLE, `${event.toolName}\n${inputText(event.input)}`);
  if (answer === undefined) {
    // No UI and Jev used up the wait: our own wait-limit reason.
    if (jevTimedOut) return deadlineBlocked();
    deps.onDecision(approval.noUi === "allow" ? "no_ui_allow" : "no_ui_deny", event.toolName);
    return approval.noUi === "allow" ? undefined : `${APPROVAL_BLOCK_REASON} (no UI)`;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.min(approval.confirmTimeoutMs, remaining)); });
  let ok: boolean | "timeout" = false;
  try {
    ok = await Promise.race([answer, timedOut]);
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  if (ok === "timeout") {
    // No answer in time: same as no UI.
    deps.onDecision(approval.noUi === "allow" ? "timeout_allow" : "timeout_deny", event.toolName);
    return approval.noUi === "allow" ? undefined : `${APPROVAL_BLOCK_REASON} (timeout)`;
  }
  deps.onDecision(ok ? "approved" : "denied", event.toolName);
  return ok ? undefined : APPROVAL_BLOCK_REASON;
}

/** Silent-tools counter with the legacy plugin's semantics. */
export class SilentSteer {
  private silent = 0;
  private steers = 0;

  /** A tool finished. True when a reminder is due now (the caller sends it in `on`, records it in shadow). */
  toolResult(): boolean {
    this.silent++;
    if (this.silent < STEER_THRESHOLD || this.steers >= MAX_STEERS) return false;
    this.silent = 0;
    this.steers++;
    return true;
  }

  /** Assistant message end: visible text resets the silent count. */
  messageEnd(message: unknown): void {
    const m = message as { role?: unknown; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
    if (m.content.some((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" && part.text.trim())) this.silent = 0;
  }

  /** User input (not extension-sourced): a new request resets everything. */
  input(source: unknown): void {
    if (source === "extension") return;
    this.silent = 0;
    this.steers = 0;
  }
}
