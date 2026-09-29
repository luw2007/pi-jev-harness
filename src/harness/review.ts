/**
 * Action review (technical §4.2, §7.1, §9.3): H's four-question proposal review adapted to
 * host actions. Code decides; Jev only supplies evidence, and `permit` is never authorization.
 *
 * Order: structural validation → minimal allowed payload → H payload validation → cancel check →
 * one `ask` → cancel check → strict read of answers → H `decide()`. Structural failures never reach
 * `ask`. Pure apart from the injected `ask`: no environment, filesystem, network or clock.
 */
import {
  JEV_MODEL,
  REVIEW_CONFIDENCE_THRESHOLD,
  REVIEW_QUESTION_IDS,
  UNTRUSTED_NOTE,
  decide,
  parseUnifiedDiff,
  readNoul,
  validateReviewPayload,
  MAX_PATCH_CHARS,
  type ReviewAnswers,
  type RunPayload,
  type ValidationResult,
} from "../../vendor/jev-harness/src/contract/index.ts";
import { dataArray, dataRecord } from "../../vendor/jev-harness/src/contract/input.ts";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { replacementsToUnifiedDiff } from "./actions.ts";
import { questionSetFor } from "./review-questions.ts";
import type { ActionEnvelope } from "./types.ts";
import type {
  ActionReview,
  ActionReviewMode,
  ActionReviewStatus,
  AllowedReviewContext,
  NoulAsk,
  ReviewableAction,
  ReviewableActionKind,
} from "./review-types.ts";

export const ACTION_REVIEW_POLICY_VERSION = "action-review-v1";
export const DEFAULT_PREIMAGE_LINE_LIMIT = 200;
/** Largest diff or whole-file content sent for review; same bound as H's proposal patch. */
export const MAX_REVIEW_CHANGE_CHARS = MAX_PATCH_CHARS;

const KINDS: readonly ReviewableActionKind[] = ["edit", "create", "overwrite"];

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Relative, forward-slash path with no empty, `.` or `..` segments (mirrors H `checkPath` without the fixture lookup). */
function pathErrors(path: string): string[] {
  const errors: string[] = [];
  if (/[\x00-\x1f\\]/.test(path)) errors.push("targetPath contains control characters or backslashes");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) errors.push("targetPath is absolute; only root-relative paths are allowed");
  const segments = path.split("/");
  if (segments.includes("..")) errors.push("targetPath contains `..` and could escape the root");
  if (segments.some((s) => s === "" || s === ".")) errors.push("targetPath has empty or `.` segments");
  return errors;
}

/** Structural checks on the action alone. Target existence, symlinks and grants belong to the host validator. */
export function validateReviewableAction(value: unknown): ValidationResult {
  const action = dataRecord(value);
  if (!action) return { ok: false, errors: ["action must be a plain object"] };
  const errors: string[] = [];
  if (!nonempty(action.actionId)) errors.push("actionId must be a nonempty string");
  if (!nonempty(action.toolName)) errors.push("toolName must be a nonempty string");
  if (action.rationale !== undefined && typeof action.rationale !== "string") errors.push("rationale must be a string");
  if (action.grantId !== undefined && !nonempty(action.grantId)) errors.push("grantId must be a nonempty string when present");
  const kind = action.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as ReviewableActionKind))
    errors.push(`kind must be one of ${KINDS.join(", ")}`);
  const path = action.targetPath;
  if (!nonempty(path)) errors.push("targetPath must be a nonempty string");
  else errors.push(...pathErrors(path));
  if (kind === "edit" || kind === "overwrite") {
    if (!nonempty(action.preimageDigest)) errors.push(`${kind} requires a preimageDigest`);
  } else if (action.preimageDigest !== undefined) errors.push("create must not carry a preimageDigest");
  if (kind === "edit") {
    if (action.content !== undefined) errors.push("edit must carry a diff, not content");
    if (!nonempty(action.diff)) errors.push("edit requires a unified diff");
    else if (action.diff.length > MAX_REVIEW_CHANGE_CHARS) errors.push(`diff exceeds ${MAX_REVIEW_CHANGE_CHARS} characters`);
    else {
      try {
        const { files } = parseUnifiedDiff(action.diff);
        const file = files[0];
        if (files.length !== 1) errors.push(`diff touches ${files.length} files; exactly one is allowed`);
        if (file && typeof path === "string" && file.path !== path)
          errors.push(`diff header names ${JSON.stringify(file.path)} but targetPath is ${JSON.stringify(path)}`);
        if (file?.previousPath) errors.push("renames are not allowed");
        for (const hunk of file?.hunks ?? []) if (!hunk.complete) errors.push(hunk.issue ?? "diff has an incomplete hunk");
      } catch (e) {
        errors.push(`diff does not parse: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
  } else if (kind === "create" || kind === "overwrite") {
    if (action.diff !== undefined) errors.push(`${kind} must carry content, not a diff`);
    if (typeof action.content !== "string") errors.push(`${kind} requires string content`);
    else if (action.content.length > MAX_REVIEW_CHANGE_CHARS) errors.push(`content exceeds ${MAX_REVIEW_CHANGE_CHARS} characters`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * The single conversion from a host `ActionEnvelope` to the reviewer's view. Pure; throws when the
 * envelope is not a reviewable edit/create/overwrite or its parts do not agree.
 *
 * - `edit` with Pi replacements needs `preimageText`, the file text whose sha256 is
 *   `envelope.preimage.sha256`; the diff is generated from it. A `propose_patch` diff is used as is.
 * - `create`/`overwrite` take `content` from the envelope's copied args and check it against
 *   `change.sha256`.
 * - `targetPath` is `targets[0]` relative to the containing root in `scope.roots`.
 */
export function toReviewableAction(envelope: ActionEnvelope, preimageText?: string): ReviewableAction {
  const { actionId, toolName, kind, change, preimage } = envelope;
  if (envelope.withheld || envelope.issues.length) throw Error(`action ${actionId} is withheld or has issues`);
  if (kind !== "edit" && kind !== "create" && kind !== "overwrite") throw Error(`${kind} actions are not reviewed`);
  if (envelope.targets.length !== 1) throw Error(`reviewable actions need exactly one target; got ${envelope.targets.length}`);
  const target = envelope.targets[0]!;
  const rel = envelope.scope.roots
    .map((root) => relative(root, target))
    .find((path) => path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  if (rel === undefined) throw Error(`target ${JSON.stringify(target)} is outside the allowed roots`);
  const base = {
    actionId,
    toolName,
    targetPath: rel.split(sep).join("/"),
    ...(envelope.rationale === null ? {} : { rationale: envelope.rationale }),
    ...(envelope.scope.grant ? { grantId: envelope.scope.grant.id } : {}),
  };
  if (kind !== "create" && !preimage) throw Error(`${kind} requires a preimage`);
  if (kind === "edit") {
    if (change?.format === "unified_diff") return { ...base, kind, diff: change.patch, preimageDigest: preimage!.sha256 };
    if (change?.format !== "replacements") throw Error("edit requires replacements or a unified diff");
    if (preimageText === undefined) throw Error("edit replacements need the preimage text to build a diff");
    if (createHash("sha256").update(preimageText, "utf8").digest("hex") !== preimage!.sha256)
      throw Error("preimage text does not match the envelope's preimage digest");
    return { ...base, kind, diff: replacementsToUnifiedDiff(base.targetPath, preimageText, change.edits), preimageDigest: preimage!.sha256 };
  }
  const content = envelope.args?.content;
  if (change?.format !== "content" || typeof content !== "string") throw Error(`${kind} requires string content`);
  if (createHash("sha256").update(content, "utf8").digest("hex") !== change.sha256)
    throw Error("content does not match the envelope's content digest");
  return kind === "create" ? { ...base, kind, content } : { ...base, kind, content, preimageDigest: preimage!.sha256 };
}

function contextErrors(value: unknown, kind: ReviewableActionKind): string[] {
  const context = dataRecord(value);
  if (!context) return ["allowedContext must be a plain object"];
  const errors: string[] = [];
  if (!nonempty(context.task)) errors.push("allowedContext.task must be a nonempty string");
  if (context.evidence !== undefined) {
    const evidence = dataArray(context.evidence);
    if (!evidence || !evidence.every((line) => typeof line === "string"))
      errors.push("allowedContext.evidence must be an array of strings");
  }
  const limit = context.preimageLineLimit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1))
    errors.push("allowedContext.preimageLineLimit must be a positive integer");
  if (kind === "create" ? context.preimage !== undefined : typeof context.preimage !== "string")
    errors.push(kind === "create" ? "create must not carry a preimage" : `${kind} requires the preimage text`);
  return errors;
}

interface PreimageExcerpt {
  totalLines: number;
  truncated: boolean;
  segments: { startLine: number; text: string }[];
}

/**
 * Lines of the preimage that the change touches (edit: every hunk's old range; overwrite: from
 * the top), capped at `limit` lines in total.
 */
function preimageExcerpt(action: ReviewableAction, preimage: string, limit: number): PreimageExcerpt {
  const lines = preimage.replace(/\r\n/g, "\n").split("\n");
  let ranges: [number, number][];
  if (action.kind === "edit") {
    ranges = parseUnifiedDiff(action.diff).files[0]!.hunks.map((hunk) => {
      const match = /^@@ -(\d+)(?:,(\d+))? /.exec(hunk.header);
      const count = Number(match?.[2] ?? 1);
      // A pure insertion (`-n,0`) has no old lines; show line n, the line it follows.
      const start = Math.max(1, hunk.oldStart);
      return [start, Math.min(lines.length, start + Math.max(count, 1) - 1)] as [number, number];
    });
    ranges.sort((a, b) => a[0] - b[0]);
  } else ranges = [[1, lines.length]];
  const segments: PreimageExcerpt["segments"] = [];
  let budget = limit;
  let covered = 0;
  let wanted = 0;
  for (const [from, to] of ranges) {
    const start = Math.max(from, covered + 1);
    if (start > to) continue;
    wanted += to - start + 1;
    const end = Math.min(to, start + budget - 1);
    if (budget > 0 && end >= start) {
      segments.push({ startLine: start, text: lines.slice(start - 1, end).join("\n") });
      budget -= end - start + 1;
    }
    covered = Math.max(covered, to);
  }
  return { totalLines: lines.length, truncated: wanted > limit, segments };
}

/**
 * Minimal outbound payload: task, quoted evidence, target path, the change (diff or content),
 * and a bounded preimage excerpt. No other files, history or host state. Throws on invalid input;
 * `reviewAction` validates first so it never sends a payload built from invalid input.
 */
export function buildActionReviewPayload(action: ReviewableAction, allowedContext: AllowedReviewContext): RunPayload {
  const validation = validateReviewableAction(action);
  const errors = validation.ok ? contextErrors(allowedContext, action.kind) : validation.errors;
  if (errors.length) throw Error(`Invalid review input: ${errors.join("; ")}`);
  const set = questionSetFor(action.kind);
  const limit = allowedContext.preimageLineLimit ?? DEFAULT_PREIMAGE_LINE_LIMIT;
  const change =
    action.kind === "edit"
      ? { diff: action.diff }
      : { content: action.content, contentLines: action.content.replace(/\r\n/g, "\n").split("\n").length };
  const state: Record<string, unknown> = {
    note: UNTRUSTED_NOTE,
    task: allowedContext.task,
    evidence: [...(allowedContext.evidence ?? [])],
    action: {
      kind: action.kind,
      tool: action.toolName,
      path: action.targetPath,
      ...change,
      ...(action.rationale !== undefined ? { rationale: action.rationale } : {}),
    },
  };
  if (action.kind !== "create")
    state.preimageExcerpt = { path: action.targetPath, ...preimageExcerpt(action, allowedContext.preimage!, limit) };
  return validateReviewPayload({
    model: JEV_MODEL,
    state,
    questions: Object.fromEntries(REVIEW_QUESTION_IDS.map((id) => [id, { ...set.questions[id] }])),
  });
}

export interface DecideActionReviewOptions {
  validation?: ValidationResult;
  /** Why no answers arrived; carried into the unavailable reason. */
  error?: string;
  threshold?: number;
}

/**
 * H's decision table applied to action answers: failed validation → reject; no answers →
 * unavailable; four favorable at ≥ threshold → permit; anything else → proposal_only.
 */
export function decideActionReview(
  answers: ReviewAnswers | null,
  options: DecideActionReviewOptions = {},
): { status: ActionReviewStatus; reason: string } {
  const validation = options.validation ?? { ok: true, errors: [] };
  // decide() checks review metadata shape; the model here was already verified against the pin.
  const review =
    answers === null
      ? options.error === undefined
        ? null
        : { model: JEV_MODEL, answers: null, error: options.error, latencyMs: 0, source: "jev" as const }
      : { model: JEV_MODEL, answers, error: null, latencyMs: 0, source: "jev" as const };
  const { verdict, reason } = decide(validation, review, options.threshold ?? REVIEW_CONFIDENCE_THRESHOLD);
  return { status: verdict, reason };
}

/** Strictly read `ask` evidence into answers: every question exactly once, pinned model, valid probability. */
function readEvidence(evidence: unknown): { answers: ReviewAnswers; model: string } {
  const items = dataArray(evidence);
  if (!items || items.length !== REVIEW_QUESTION_IDS.length) throw Error("Jev evidence does not answer exactly the asked questions.");
  const answers = {} as ReviewAnswers;
  const seen = new Set<string>();
  for (const raw of items) {
    const item = dataRecord(raw);
    const id = item?.questionId;
    if (typeof id !== "string" || !(REVIEW_QUESTION_IDS as readonly string[]).includes(id) || seen.has(id))
      throw Error("Jev evidence has an unknown or repeated question id.");
    if (item!.model !== JEV_MODEL) throw Error(`Jev evidence must report the exact pinned model ${JEV_MODEL}.`);
    seen.add(id);
    answers[id as keyof ReviewAnswers] = readNoul({ type: "noul", noul: item!.yes }, id);
  }
  return { answers, model: JEV_MODEL };
}

export interface ReviewActionInput {
  action: ReviewableAction;
  allowedContext: AllowedReviewContext;
  ask: NoulAsk;
  mode: ActionReviewMode;
  signal?: AbortSignal;
  threshold?: number;
}

/** Never throws for action/answer problems; failures become reject or unavailable evidence. */
export async function reviewAction(input: ReviewActionInput): Promise<ActionReview> {
  const { action, allowedContext, ask, mode, signal } = input;
  if (mode !== "shadow" && mode !== "enforced") throw Error("Review mode must be shadow or enforced.");
  const record = dataRecord(action);
  const actionId = nonempty(record?.actionId) ? record.actionId : null;
  const kind = KINDS.includes(record?.kind as ReviewableActionKind) ? (record!.kind as ReviewableActionKind) : null;
  const evidenceRefs = actionId === null ? [] : [`action:${actionId}`];
  if (nonempty(record?.preimageDigest)) evidenceRefs.push(`preimage:${record.preimageDigest}`);
  if (nonempty(record?.grantId)) evidenceRefs.push(`grant:${record.grantId}`);
  const finish = (
    validation: ValidationResult,
    answers: ReviewAnswers | null,
    model: string | null,
    error?: string,
  ): ActionReview => {
    const { status, reason } = decideActionReview(answers, { validation, error, threshold: input.threshold });
    return {
      actionId,
      mode,
      validation,
      status,
      reason,
      questionSetVersion: kind === null ? null : questionSetFor(kind).version,
      model,
      policyVersion: ACTION_REVIEW_POLICY_VERSION,
      evidenceRefs,
      answers,
      blocked:
        mode === "enforced" && status !== "permit"
          ? `Enforced review ${status}: ${reason} The action is not executed.`
          : null,
    };
  };

  let validation = validateReviewableAction(action);
  if (validation.ok) {
    const errors = contextErrors(allowedContext, kind!);
    validation = { ok: errors.length === 0, errors };
  }
  if (!validation.ok) return finish(validation, null, null);

  let payload: RunPayload;
  try {
    payload = buildActionReviewPayload(action, allowedContext);
  } catch (e) {
    return finish({ ok: false, errors: [e instanceof Error ? e.message : "payload validation failed"] }, null, null);
  }
  if (signal?.aborted) return finish(validation, null, null, "Review cancelled before dispatch.");

  const questions = REVIEW_QUESTION_IDS.map((id) => ({ id, question: payload.questions[id]!.instructions }));
  let result: unknown;
  try {
    result = await ask(questions, { decisionId: action.actionId, state: payload.state as Record<string, unknown>, signal });
  } catch (e) {
    return finish(validation, null, null, signal?.aborted ? "Review cancelled before an answer arrived." : `Jev ask failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  if (signal?.aborted) return finish(validation, null, null, "Review cancelled after the answer arrived.");

  const outcome = dataRecord(result);
  const attemptId = dataRecord(outcome?.attempt)?.attemptId;
  if (nonempty(attemptId)) evidenceRefs.push(`jev-attempt:${attemptId}`);
  if (!outcome || typeof outcome.ok !== "boolean") return finish(validation, null, null, "Jev ask returned a malformed result.");
  if (!outcome.ok) {
    const kindOf = dataRecord(outcome.error)?.kind;
    return finish(validation, null, null, `Jev ask failed: ${typeof kindOf === "string" ? kindOf : "unknown error"}`);
  }
  try {
    const { answers, model } = readEvidence(outcome.evidence);
    return finish(validation, answers, model);
  } catch (e) {
    return finish(validation, null, null, e instanceof Error ? e.message : "Jev evidence malformed.");
  }
}
