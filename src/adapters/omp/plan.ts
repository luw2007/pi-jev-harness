/**
 * `jev_plan` (T105 C6): advice-only topology planner for the OMP Route Agent.
 *
 * Input and output are equivalent to the legacy `jev_route` tool
 * (`omp-jev-extensions/extensions/jev-harness/capabilities/planning.ts`): parameters
 * `{ task, pinnedAgent? }`; result text is the pretty-printed `RoutePlan` and `details.plan` the
 * same object; failures return `isError: true` with `Route planning failed: <reason>` and no plan.
 * Only the tool name differs, so `route.md` works after renaming `jev_route` to `jev_plan`.
 *
 * The plan is never dispatched. Graph checks reuse `validatePlan` from `src/router/plan.ts`; mode
 * and role invariants are the legacy ones. Outbound gate, credential scan and the per-task request
 * budget apply; the audit line carries categories and counts only, never the task text.
 */
import { validatePlan, PLAN_KINDS, type PlanKind } from "../../router/plan.ts";
import type { ChoiceEvidence, ChoiceQuestion, JevClient } from "../../jev/index.ts";
import type { AuditWriter } from "../../telemetry/audit.ts";
import { containsCredential } from "./shared.ts";

export const JEV_PLAN_TOOL = "jev_plan";
export const PLANNING_AGENT_CATALOG = ["fast", "smart", "scout", "reviewer"] as const;
export const TASK_CLASSES = ["mechanical", "research", "routine", "smart", "review"] as const;
export const MODEL_ROLES = ["fast", "smart", "slow", "task"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
export type ModelRole = (typeof MODEL_ROLES)[number];
export type RouteMode = PlanKind;
const MAX_SLICES = 32;

export interface RouteSlice {
  id: string;
  agent: string;
  taskClass: TaskClass;
  dependsOn: string[];
  target: string;
  change: string;
  acceptance: string;
  tools?: string[];
  model?: ModelRole;
}

export interface RoutePlan {
  version: 1;
  mode: RouteMode;
  rationale: string;
  slices: RouteSlice[];
  recommendedGate?: "light" | "heavy";
}

export interface CandidateSliceInput {
  id: string;
  target: string;
  change: string;
  acceptance: string;
  isReadonly?: boolean;
}

/** Legacy `jev_route` parameters, unchanged. */
export const JEV_PLAN_PARAMETERS = {
  type: "object",
  properties: {
    task: { type: "string", description: "User prompt or high-level task instructions" },
    pinnedAgent: { type: "string", description: "Optional explicit user-pinned agent class override" },
  },
  required: ["task"],
} as const;

const READONLY = /\b(read|inspect|check|audit|search|investigate)\b/i;

export function deriveCandidateSlices(task: string): CandidateSliceInput[] {
  const parts = task.split(/\n\s*[-*]\s+|\n\s*\d+\.\s+/).map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length > 1) {
    return parts.map((part, index) => ({
      id: `slice_${index + 1}`,
      target: `Scope for sub-task ${index + 1}`,
      change: part,
      acceptance: `Observable success criteria for: ${part}`,
      isReadonly: READONLY.test(part),
    }));
  }
  return [{ id: "slice_1", target: "Project files relevant to task", change: task, acceptance: "All task requirements satisfied and verified", isReadonly: READONLY.test(task) }];
}

export function buildRouteState(task: string, candidates: CandidateSliceInput[], pinnedAgent: string | undefined, catalog: readonly string[]): Record<string, unknown> {
  return {
    task,
    candidates,
    catalog: [...catalog],
    pinnedAgent: pinnedAgent ?? null,
    constraints: [
      "No circular dependencies",
      "Readonly research must go to scout",
      "Max 32 concurrent subagents",
      "Implementation agents must not be read-only",
      "Exact target/change/acceptance must be specified",
    ],
  };
}

const AGENT_DESCRIPTIONS: Record<string, string> = {
  scout: "Read-only research and exploratory codebase analysis",
  fast: "Routine implementation or mechanical refactoring",
  smart: "Complex reasoning, cross-module architecture, or root-cause diagnosis",
  reviewer: "Adversarial architecture arbitration or strict review",
};

/** Same questions as the legacy planner, in the typed `ChoiceQuestion` form (wire body identical). */
export function buildRouteQuestions(candidates: CandidateSliceInput[], pinnedAgent: string | undefined, catalog: readonly string[]): ChoiceQuestion[] {
  const questions: ChoiceQuestion[] = [{
    id: "mode",
    question: "Choose the execution topology: direct (no subagent needed), single (1 task), parallel (independent tasks), or dag (tasks with dependencies).",
    options: [
      { id: "direct", description: "User request is purely conversational or can be resolved immediately without subagent" },
      { id: "single", description: "A single focused subagent task is sufficient" },
      { id: "parallel", description: "Independent subagent tasks that can execute concurrently with no mutual dependencies" },
      { id: "dag", description: "Multiple subagent tasks with explicit dependencies or sequential contract requirements" },
    ],
  }];
  for (const candidate of candidates) {
    questions.push({
      id: `agent_${candidate.id}`,
      question: `Choose the target agent class for slice ${candidate.id}. Pinned agent constraint: ${pinnedAgent ?? "none"}.`,
      options: catalog.map((agent) => ({ id: agent, description: AGENT_DESCRIPTIONS[agent] ?? `Installed OMP agent: ${agent}` })),
    });
    questions.push({
      id: `model_${candidate.id}`,
      question: `Choose the model tier for slice ${candidate.id}. Cheaper tiers when the task is mechanical; heavier tiers when reasoning spans modules or risk is high.`,
      options: [
        { id: "fast", description: "Mechanical edits, grep/replace, test writing, single-file changes" },
        { id: "smart", description: "Cross-module reasoning, subtle bugs, non-trivial refactoring" },
        { id: "slow", description: "Long-context review, architecture critique, deep multi-file analysis" },
        { id: "task", description: "Highest-budget implementation when the slice is the critical path" },
      ],
    });
  }
  return questions;
}

/** Legacy `validateRoutePlanInvariants`; dependency refs and cycles via the router's `validatePlan`. */
export function validateRoutePlanInvariants(plan: RoutePlan): void {
  if (plan.version !== 1) throw new Error(`Unsupported plan version: ${plan.version}`);
  if (!(PLAN_KINDS as readonly string[]).includes(plan.mode)) throw new Error(`Invalid route mode: ${plan.mode}`);
  if (plan.slices.length > 0) {
    const graph = validatePlan({ kind: "dag", steps: plan.slices.map((s) => ({ id: s.id, dependsOn: s.dependsOn })) }, { maxDagSteps: MAX_SLICES });
    if (!graph.ok) {
      const issue = graph.issues[0]!;
      throw new Error(`Invalid slice graph: ${issue.code}${issue.stepId ? ` at ${issue.stepId}` : ""}`);
    }
  }
  const n = plan.slices.length;
  if (plan.mode === "direct" && n > 0) throw new Error("Direct mode must not contain any subagent slices");
  if (plan.mode === "single" && n !== 1) throw new Error(`Single mode requires exactly 1 slice, got ${n}`);
  if (plan.mode === "parallel") {
    if (n < 2) throw new Error(`Parallel mode requires at least 2 slices, got ${n}`);
    for (const s of plan.slices) if (s.dependsOn.length > 0) throw new Error(`Parallel mode slices must not have dependencies: slice ${s.id}`);
  }
  if (plan.mode === "dag") {
    if (n < 2) throw new Error(`DAG mode requires at least 2 slices, got ${n}`);
    if (!plan.slices.some((s) => s.dependsOn.length > 0)) throw new Error("DAG mode specified but no dependencies exist across slices; should be parallel mode");
  }
  for (const s of plan.slices) {
    if (s.taskClass === "research" && s.agent !== "scout") throw new Error(`Research taskClass must be assigned to scout, got: ${s.agent}`);
    if (s.agent === "scout" && s.taskClass !== "research") throw new Error(`Scout agent can only be assigned to research taskClass, got: ${s.taskClass}`);
    if (s.model && !(MODEL_ROLES as readonly string[]).includes(s.model)) throw new Error(`Invalid model role for slice ${s.id}: ${String(s.model)}`);
  }
}

/** Legacy `planFromAnswers`: missing/unknown answers fall back; pinned agent overrides the choice. */
export function planFromAnswers(candidates: CandidateSliceInput[], answers: Record<string, string | undefined>, pinnedAgent: string | undefined, catalog: readonly string[]): RoutePlan {
  const rawMode = answers.mode;
  if (!rawMode) throw new Error("Jev response missing required mode decision");
  if (!(PLAN_KINDS as readonly string[]).includes(rawMode)) throw new Error(`Invalid route mode: ${rawMode}`);
  const chosen = rawMode as RouteMode;
  // Jev may pick dag/parallel for a one-slice task: degrade to single (recorded in the rationale).
  const mode: RouteMode = (chosen === "dag" || chosen === "parallel") && candidates.length === 1 ? "single" : chosen;
  const slices: RouteSlice[] = [];
  if (mode !== "direct") {
    for (const candidate of candidates) {
      const rawAgent = answers[`agent_${candidate.id}`];
      const preferred = candidate.isReadonly ? "scout" : "fast";
      const chosenAgent = rawAgent && catalog.includes(rawAgent) ? rawAgent : catalog.includes(preferred) ? preferred : catalog[0]!;
      const rawModel = answers[`model_${candidate.id}`];
      const model: ModelRole = (MODEL_ROLES as readonly string[]).includes(rawModel ?? "") ? (rawModel as ModelRole) : chosenAgent === "smart" ? "smart" : "fast";
      slices.push({
        id: candidate.id,
        agent: pinnedAgent ?? chosenAgent,
        taskClass: chosenAgent === "scout" ? "research" : chosenAgent === "smart" ? "smart" : "routine",
        dependsOn: [],
        target: candidate.target,
        change: candidate.change,
        acceptance: candidate.acceptance,
        model,
      });
    }
    if (mode === "dag") for (let i = 1; i < slices.length; i += 1) slices[i]!.dependsOn = [slices[i - 1]!.id];
  }
  const plan: RoutePlan = { version: 1, mode, rationale: mode === chosen ? `Jev selected topology: ${mode}` : `Jev selected topology: ${chosen}; degraded to single (one slice)`, slices, recommendedGate: mode === "parallel" || mode === "dag" ? "heavy" : "light" };
  validateRoutePlanInvariants(plan);
  return plan;
}

export interface JevPlanContext {
  /** Session mode; off sends no request. */
  mode: "off" | "shadow" | "on";
  taskIntent: boolean;
  /** Every Jev key of the session (`JevAccess.secrets`), for the credential scan. */
  secrets: readonly string[];
  /** Client bound to the session's fetch; undefined without a usable provider. */
  client: JevClient | undefined;
  maxRequests: number;
  waitMs: number;
  runId: string;
  decisionId: string;
  audit: AuditWriter | undefined;
  now: () => number;
}

export interface JevPlanResult {
  content: Array<{ type: "text"; text: string }>;
  details: { plan?: RoutePlan };
  isError?: boolean;
}

/** One `jev_plan` call: gate, one Jev request, legacy-shaped result, one audit line. */
export async function runJevPlan(params: unknown, signal: AbortSignal | undefined, ctx: JevPlanContext, catalog: readonly string[] = PLANNING_AGENT_CATALOG): Promise<JevPlanResult> {
  const started = ctx.now();
  const input = (params ?? {}) as { task?: unknown; pinnedAgent?: unknown };
  const task = typeof input.task === "string" ? input.task : "";
  const pinnedAgent = typeof input.pinnedAgent === "string" && catalog.includes(input.pinnedAgent) ? input.pinnedAgent : undefined;
  const candidates = deriveCandidateSlices(task);
  const audit = (outcome: string, mode: string | undefined, metrics: Record<string, unknown>) =>
    void ctx.audit?.record({ kind: "route", event: "jev_plan", outcome, ...(mode ? { mode } : {}), durationMs: ctx.now() - started, runId: ctx.runId, decisionId: ctx.decisionId,
      metrics: { candidates: candidates.length, pinned: pinnedAgent !== undefined, ...metrics } });
  const fail = (reason: string, outcome: string, requests: number): JevPlanResult => {
    audit(outcome, undefined, { requests });
    return { content: [{ type: "text", text: `Route planning failed: ${reason}` }], details: {}, isError: true };
  };

  if (!task.trim()) return fail("task is required", "invalid", 0);
  if (ctx.mode === "off") return fail("pi-jev-harness is off for this session; no Jev request was sent", "off", 0);
  if (!ctx.taskIntent) return fail("outbound.taskIntent is false; no Jev request is sent", "withheld", 0);
  const state = buildRouteState(task, candidates, pinnedAgent, catalog);
  if (containsCredential(JSON.stringify(state), ctx.secrets)) return fail("credential detected; Jev request withheld", "withheld", 0);
  if (!ctx.client) return fail("no Jev key", "unavailable", 0);
  if (ctx.maxRequests < 1) return fail("request budget is 0", "budget", 0);

  const timeout = AbortSignal.timeout(ctx.waitMs);
  const result = await ctx.client.choice(buildRouteQuestions(candidates, pinnedAgent, catalog), {
    decisionId: ctx.decisionId,
    state,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!result.ok) return fail(`Jev unavailable (${result.error.kind})`, "unavailable", result.attempt ? 1 : 0);
  const answers = Object.fromEntries(result.evidence.map((e: ChoiceEvidence) => [e.questionId, e.choice]));
  let plan: RoutePlan;
  try {
    plan = planFromAnswers(candidates, answers, pinnedAgent, catalog);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), "invalid", 1);
  }
  audit("ok", plan.mode, { requests: 1, slices: plan.slices.length, degraded: plan.mode !== answers.mode });
  return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }], details: { plan } };
}
