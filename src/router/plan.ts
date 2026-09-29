// Behavior reference: typesafe-router (no code copied; license not confirmed)
//
// Plan validation and execution-shape choice (technical doc §6.3). Pure: every input is a
// parameter; no environment, file, network or clock access (time comes from optional `now`).
// Only `direct` and `single` are executable in this phase; `parallel`/`dag` can be validated
// and, when explicitly allowed, chosen for display, but `executable` stays false for them.

import type { ChoiceEvidence, ChoiceQuestion, JevState } from "../jev/types.ts";
import { PROBABILITY_SUM_TOLERANCE } from "../jev/wire.ts";

export const PLAN_KINDS = ["direct", "single", "parallel", "dag"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** Kinds with an executor today. */
export const EXECUTABLE_PLAN_KINDS: readonly PlanKind[] = ["direct", "single"];
export const DEFAULT_ALLOWED_PLAN_KINDS: readonly PlanKind[] = ["direct", "single"];
export const DEFAULT_MAX_DAG_STEPS = 8;

export const PLAN_QUESTION_ID = "plan";
export const PLAN_QUESTION_VERSION = "plan-choice/1";

export interface PlanStep {
  id: string;
  /** Tool roots the step needs; prerequisites are assembled by code, not listed here. */
  roots?: readonly string[];
  /** Step ids that must finish first. */
  dependsOn?: readonly string[];
  /** Repo-relative paths the step may write; `[]` means read-only. Required for `parallel`. */
  writeScope?: readonly string[];
}

export interface Plan {
  kind: PlanKind;
  steps: readonly PlanStep[];
}

export type PlanIssueCode =
  | "not_object"
  | "unknown_kind"
  | "empty_plan"
  | "step_count"
  | "too_many_steps"
  | "invalid_step"
  | "duplicate_step_id"
  | "invalid_root"
  | "unknown_root"
  | "unknown_step_ref"
  | "cycle"
  | "parallel_dependency"
  | "write_scope_missing"
  | "invalid_write_scope"
  | "write_scope_overlap";

export interface PlanIssue {
  code: PlanIssueCode;
  stepId?: string;
  /** Second step for pairwise issues (overlap) or the missing target for `unknown_step_ref`. */
  otherId?: string;
}

export interface ValidatePlanOptions {
  /** Default `DEFAULT_MAX_DAG_STEPS`. */
  maxDagSteps?: number;
  /** When set, every step root must be one of these. */
  knownRoots?: ReadonlySet<string>;
}

export type PlanValidation = { ok: true; plan: Plan } | { ok: false; issues: PlanIssue[] };

type Data = Record<string, unknown>;
const record = (value: unknown): Data | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isKind = (value: unknown): value is PlanKind => (PLAN_KINDS as readonly unknown[]).includes(value);
const optionalStrings = (value: unknown): value is readonly string[] | undefined =>
  value === undefined || (Array.isArray(value) && value.every(nonEmpty));

/** Path segments, or null when overlap cannot be decided (absolute, `..`, empty). `.` is the whole repo. */
function scopeSegments(path: string): string[] | null {
  if (path.length === 0 || path.startsWith("/")) return null;
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return segments.includes("..") ? null : segments;
}

const segmentPrefix = (a: readonly string[], b: readonly string[]) => a.every((segment, index) => b[index] === segment);
const scopesOverlap = (a: readonly string[], b: readonly string[]) => segmentPrefix(a, b) || segmentPrefix(b, a);

function findCycle(steps: readonly PlanStep[]): string | undefined {
  const deps = new Map(steps.map((step) => [step.id, step.dependsOn ?? []]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): string | undefined => {
    const seen = state.get(id);
    if (seen === "done") return undefined;
    if (seen === "visiting") return id;
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) {
      const hit = visit(dep);
      if (hit !== undefined) return hit;
    }
    state.set(id, "done");
    return undefined;
  };
  for (const step of steps) {
    const hit = visit(step.id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Structural checks only; says nothing about whether the plan is a good idea.
 * Returns every issue found, except that dependency-graph checks run only once step ids and
 * references are sound.
 */
export function validatePlan(plan: unknown, options: ValidatePlanOptions = {}): PlanValidation {
  const data = record(plan);
  if (!data) return { ok: false, issues: [{ code: "not_object" }] };
  if (!isKind(data.kind)) return { ok: false, issues: [{ code: "unknown_kind" }] };
  const kind = data.kind;
  if (!Array.isArray(data.steps) || data.steps.length === 0) return { ok: false, issues: [{ code: "empty_plan" }] };

  const issues: PlanIssue[] = [];
  const rawSteps: unknown[] = data.steps;
  if ((kind === "direct" || kind === "single") && rawSteps.length !== 1) issues.push({ code: "step_count" });
  const maxDagSteps = options.maxDagSteps ?? DEFAULT_MAX_DAG_STEPS;
  if (kind === "dag" && rawSteps.length > maxDagSteps) issues.push({ code: "too_many_steps" });

  const steps: PlanStep[] = [];
  const ids = new Set<string>();
  for (const raw of rawSteps) {
    const step = record(raw);
    if (!step || !nonEmpty(step.id) || !optionalStrings(step.dependsOn) || !optionalStrings(step.writeScope)) {
      issues.push(nonEmpty(step?.id) ? { code: "invalid_step", stepId: step.id } : { code: "invalid_step" });
      continue;
    }
    const id = step.id;
    if (ids.has(id)) issues.push({ code: "duplicate_step_id", stepId: id });
    ids.add(id);
    const roots = optionalStrings(step.roots) ? step.roots : null;
    if (roots === null) issues.push({ code: "invalid_root", stepId: id });
    for (const root of roots ?? []) {
      if (options.knownRoots && !options.knownRoots.has(root)) issues.push({ code: "unknown_root", stepId: id, otherId: root });
    }
    steps.push({
      id,
      ...(roots ? { roots: [...roots] } : {}),
      ...(step.dependsOn === undefined ? {} : { dependsOn: [...step.dependsOn] }),
      ...(step.writeScope === undefined ? {} : { writeScope: [...step.writeScope] }),
    });
  }

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push({ code: "unknown_step_ref", stepId: step.id, otherId: dep });
    }
  }
  const graphSound = issues.every((issue) => !["invalid_step", "duplicate_step_id", "unknown_step_ref"].includes(issue.code));
  if (graphSound) {
    const cycleAt = findCycle(steps);
    if (cycleAt !== undefined) issues.push({ code: "cycle", stepId: cycleAt });
  }

  if (kind === "parallel") {
    const scoped: { id: string; segments: string[][] }[] = [];
    for (const step of steps) {
      if ((step.dependsOn ?? []).length > 0) issues.push({ code: "parallel_dependency", stepId: step.id });
      if (step.writeScope === undefined) {
        issues.push({ code: "write_scope_missing", stepId: step.id });
        continue;
      }
      const segments = step.writeScope.map(scopeSegments);
      if (segments.some((entry) => entry === null)) {
        issues.push({ code: "invalid_write_scope", stepId: step.id });
        continue;
      }
      scoped.push({ id: step.id, segments: segments as string[][] });
    }
    for (let i = 0; i < scoped.length; i += 1) {
      for (let j = i + 1; j < scoped.length; j += 1) {
        const a = scoped[i]!;
        const b = scoped[j]!;
        if (a.segments.some((x) => b.segments.some((y) => scopesOverlap(x, y)))) {
          issues.push({ code: "write_scope_overlap", stepId: a.id, otherId: b.id });
        }
      }
    }
  }

  return issues.length === 0 ? { ok: true, plan: { kind, steps } } : { ok: false, issues };
}

/** A plan proposed by the main model, offered to Jev under a stable id. */
export interface PlanCandidate {
  id: string;
  plan: Plan;
  /** Short summary shown to Jev as option criteria; data to classify, never instructions. */
  description?: string;
}

export type PlanExclusionReason = "duplicate_candidate_id" | "kind_not_allowed" | "invalid_plan";

export interface PlanExclusion {
  id: string;
  reason: PlanExclusionReason;
  issues?: PlanIssue[];
}

export interface PlanAnswer {
  evidence: ChoiceEvidence;
  /** Known usage for this ask; omitted means unknown. */
  usage?: Readonly<Record<string, number>>;
}

/** Closed-set chooser backed by Jev. Throwing means Jev is unavailable. */
export type PlanAskFn = (question: ChoiceQuestion, state: JevState, signal: AbortSignal | undefined) => Promise<PlanAnswer>;

export interface ChoosePlanInput {
  /** Task description; sent as Jev `state` data. */
  taskIntent: string;
  candidates: readonly PlanCandidate[];
  ask: PlanAskFn;
  signal?: AbortSignal;
  /** Kinds that may be selected. Default `DEFAULT_ALLOWED_PLAN_KINDS`. */
  allowed?: readonly PlanKind[];
  /** User-pinned candidate id; used without asking when eligible. */
  pinnedId?: string;
  validate?: ValidatePlanOptions;
  /** Epoch ms clock for `elapsedMs`; omitted means elapsed is unknown. */
  now?: () => number;
}

export type PlanSource = "jev" | "fallback" | "single_candidate" | "pinned";

/**
 * Plan decision, consistent with `RouteDecision` (technical doc §5). `selectedId` and
 * `probabilities` are the raw pick/evidence and are never rewritten by fallback.
 */
export interface PlanDecision {
  selectedId: string | undefined;
  /** Candidate to run; undefined on a `direct` fallback with no direct candidate (run natively in the current session). */
  effectiveId: string | undefined;
  /** Kind of the effective choice; fallback is always `direct`. */
  kind: PlanKind;
  /** False for `parallel`/`dag`: validated and chosen for display only, no executor yet. */
  executable: boolean;
  reason: string;
  source: PlanSource;
  /** Set only when a question was sent. */
  questionVersion: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  excluded: PlanExclusion[];
  elapsedMs: number | null;
  usage: Readonly<Record<string, number>> | null;
}

/** Same rules the wire parser enforces: exact option keys, finite values in [0,1], sum within tolerance. */
function probabilitiesValid(probabilities: unknown, optionIds: readonly string[]): boolean {
  const data = record(probabilities);
  if (!data) return false;
  const keys = Object.keys(data);
  if (keys.length !== optionIds.length || !optionIds.every((id) => Object.hasOwn(data, id))) return false;
  let sum = 0;
  for (const id of optionIds) {
    const value = data[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return false;
    sum += value;
  }
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function eligibleCandidates(input: ChoosePlanInput): { eligible: PlanCandidate[]; excluded: PlanExclusion[] } {
  const allowed = input.allowed ?? DEFAULT_ALLOWED_PLAN_KINDS;
  const eligible: PlanCandidate[] = [];
  const excluded: PlanExclusion[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (seen.has(candidate.id)) {
      excluded.push({ id: candidate.id, reason: "duplicate_candidate_id" });
      continue;
    }
    seen.add(candidate.id);
    const validation = validatePlan(candidate.plan, input.validate);
    if (!validation.ok) excluded.push({ id: candidate.id, reason: "invalid_plan", issues: validation.issues });
    else if (!allowed.includes(validation.plan.kind)) excluded.push({ id: candidate.id, reason: "kind_not_allowed" });
    else eligible.push(candidate);
  }
  return { eligible, excluded };
}

function buildQuestion(candidates: readonly PlanCandidate[]): ChoiceQuestion {
  return {
    id: PLAN_QUESTION_ID,
    question: "Which execution plan best fits the task described in state?",
    options: candidates.map((candidate) => ({
      id: candidate.id,
      description: `${candidate.plan.kind}, ${candidate.plan.steps.length} step(s)${candidate.description ? `: ${candidate.description}` : ""}`,
    })),
  };
}

export async function choosePlan(input: ChoosePlanInput): Promise<PlanDecision> {
  const startedAt = input.now?.();
  const { eligible, excluded } = eligibleCandidates(input);
  let questionVersion: string | null = null;
  let usage: PlanDecision["usage"] = null;

  const finish = (
    source: PlanSource,
    reason: string,
    selectedId: string | undefined,
    effective: PlanCandidate | undefined,
    evidence?: ChoiceEvidence,
  ): PlanDecision => {
    const kind = effective?.plan.kind ?? "direct";
    return {
      selectedId,
      effectiveId: effective?.id,
      kind,
      executable: EXECUTABLE_PLAN_KINDS.includes(kind),
      reason,
      source,
      questionVersion,
      probabilities: evidence && record(evidence.probabilities) ? { ...evidence.probabilities } : null,
      confidence: evidence && typeof evidence.confidence === "number" ? evidence.confidence : null,
      excluded,
      elapsedMs: startedAt === undefined || !input.now ? null : input.now() - startedAt,
      usage,
    };
  };
  const fallback = (reason: string, selectedId?: string, evidence?: ChoiceEvidence): PlanDecision => {
    const direct = eligible.find((candidate) => candidate.plan.kind === "direct");
    return finish("fallback", `${reason}; fell back to direct`, selectedId, direct, evidence);
  };

  if (input.pinnedId !== undefined) {
    const pinned = eligible.find((candidate) => candidate.id === input.pinnedId);
    return pinned ? finish("pinned", "user pin", pinned.id, pinned) : fallback("pinned candidate not eligible", input.pinnedId);
  }
  if (eligible.length === 0) return fallback("no eligible candidates");
  if (eligible.length === 1) return finish("single_candidate", "single eligible candidate", eligible[0]!.id, eligible[0]);
  if (input.signal?.aborted) return fallback("cancelled before ask");

  const question = buildQuestion(eligible);
  questionVersion = PLAN_QUESTION_VERSION;
  let answer: PlanAnswer;
  try {
    answer = await input.ask(question, input.taskIntent, input.signal);
  } catch (error) {
    if (input.signal?.aborted) return fallback("cancelled during ask");
    return fallback(`jev unavailable (${error instanceof Error ? error.name : typeof error})`);
  }
  usage = answer?.usage ?? null;
  // An answer that arrives after cancellation is stale; never adopt it.
  if (input.signal?.aborted) return fallback("cancelled during ask");
  const evidence = answer?.evidence;
  if (!record(evidence)) return fallback("jev answer missing evidence");
  const raw = typeof evidence.choice === "string" ? evidence.choice : undefined;
  if (evidence.questionId !== question.id) return fallback("jev answered a different question", raw, evidence);
  const selected = eligible.find((candidate) => candidate.id === raw);
  if (!selected) return fallback("choice outside allowed candidate set", raw, evidence);
  if (!probabilitiesValid(evidence.probabilities, question.options.map((option) => option.id))) {
    return fallback("invalid probabilities", raw, evidence);
  }
  return finish("jev", "chosen by jev", selected.id, selected, evidence);
}
