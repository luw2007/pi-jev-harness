/**
 * Effort suggestion (T105 C12), legacy `jev-autorun` `before_agent_start` behaviour.
 *
 * Config `effort`: off (no Jev request at all) | shadow (default: ask Jev and audit the suggested
 * thinking level only) | on (also call `setThinkingLevel` once per decision). `setModel` is never
 * called. The switch is capped by the session mode (`effectiveEffort`). It shares the task's
 * outbound gate, credential scan, request budget and wait budget. Shadow runs in the background
 * after tool routing; on is awaited in `before_agent_start` (bounded by budget.waitMs) so the level
 * is set before the turn starts, as legacy did. Child sessions are skipped by the host.
 */
import type { ChoiceQuestion, JevClient } from "../../jev/index.ts";
import type { AuditWriter } from "../../telemetry/audit.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type EffortMode = "off" | "shadow" | "on";

/**
 * Effort switch combined with the session mode: session off → off; session shadow → at most
 * shadow; only a session in mode on lets `effort: "on"` call setThinkingLevel.
 */
export function effectiveEffort(effort: EffortMode, sessionMode: string): EffortMode {
  if (sessionMode === "on") return effort;
  if (sessionMode === "shadow") return effort === "off" ? "off" : "shadow";
  return "off";
}

export const EFFORT_QUESTION: ChoiceQuestion = {
  id: "effort",
  question: "Choose the least effort that still suffices for this task.",
  options: [
    { id: "low", description: "Short mechanical work" },
    { id: "medium", description: "Routine coding" },
    { id: "high", description: "Multi-file reasoning" },
    { id: "xhigh", description: "Hard architectural or high-risk reasoning" },
  ],
};

export interface EffortInput {
  mode: EffortMode;
  /** Already truncated and credential-checked task intent. */
  intent: string;
  client: JevClient | undefined;
  /** Shared per-task request gate; false means the budget is spent. */
  gate: () => boolean;
  signal: AbortSignal;
  decisionId: string;
  runId: string;
  getThinkingLevel: () => unknown;
  setThinkingLevel: (level: EffortLevel) => unknown;
  audit: AuditWriter | undefined;
  now: () => number;
}

/** Returns the suggested level, or undefined when none was obtained. */
export async function suggestEffort(input: EffortInput): Promise<EffortLevel | undefined> {
  if (input.mode === "off") return undefined;
  const started = input.now();
  const audit = (outcome: string, applied = false) =>
    void input.audit?.record({ kind: "autorun", event: "effort", outcome, mode: input.mode, durationMs: input.now() - started, runId: input.runId, decisionId: input.decisionId, metrics: { applied } });
  if (!input.client || !input.intent.trim()) return audit("skipped"), undefined;
  if (input.signal.aborted || !input.gate()) return audit("budget"), undefined;
  let current: unknown;
  try {
    current = input.getThinkingLevel();
  } catch {
    current = undefined;
  }
  const result = await input.client.choice([EFFORT_QUESTION], {
    decisionId: input.decisionId,
    state: { task: input.intent, currentEffort: typeof current === "string" ? current : null },
    signal: input.signal,
  });
  if (!result.ok) return audit("unavailable"), undefined;
  const level = result.evidence[0]?.choice as EffortLevel | undefined;
  if (!level || !(EFFORT_LEVELS as readonly string[]).includes(level)) return audit("invalid"), undefined;
  let applied = false;
  if (input.mode === "on" && !input.signal.aborted) {
    try {
      input.setThinkingLevel(level);
      applied = true;
    } catch {
      applied = false;
    }
  }
  audit(level, applied);
  return level;
}
