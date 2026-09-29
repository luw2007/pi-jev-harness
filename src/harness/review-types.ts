/**
 * The reviewer's view of a host `ActionEnvelope` (technical §5, `./types.ts`). Field types are
 * derived from the envelope; `toReviewableAction` in `./review.ts` builds this view from an
 * envelope, adding only what the envelope does not carry as text (root-relative path, diff or
 * content). Nothing here is a grant: the host keeps authorization and re-checks it at the
 * execution point; `grantId` only names the `AuthorizationScope` the envelope was built under.
 */
import type {
  ReviewAnswers,
  ReviewVerdict,
  ValidationResult,
} from "../../vendor/jev-harness/src/contract/index.ts";
import type { JevResult, JevCallOptions, NoulEvidence, NoulQuestion } from "../jev/index.ts";
import type { ActionEnvelope, ActionKind, AuthorizationScope, Preimage } from "./types.ts";

/** Envelope kinds that go through Jev review; read/search/command never do. */
export type ReviewableActionKind = Extract<ActionKind, "edit" | "create" | "overwrite">;

interface ReviewableActionBase extends Pick<ActionEnvelope, "actionId" | "toolName"> {
  /** `ActionEnvelope.targets[0]` relative to its allowed root, forward slashes. */
  targetPath: string;
  /** `ActionEnvelope.rationale` when present. Model-supplied and untrusted; kept apart from host observations. */
  rationale?: NonNullable<ActionEnvelope["rationale"]>;
  /** Id of the `AuthorizationScope` in `ActionEnvelope.scope.grant`; a reference, never a grant. */
  grantId?: AuthorizationScope["id"];
}

/** Edit of an existing file: one single-file unified diff plus the preimage digest it was computed on. */
export interface ReviewableEdit extends ReviewableActionBase {
  kind: Extract<ReviewableActionKind, "edit">;
  diff: string;
  preimageDigest: Preimage["sha256"];
}

/** New file; the path must not exist yet (checked by the host validator, not here). */
export interface ReviewableCreate extends ReviewableActionBase {
  kind: Extract<ReviewableActionKind, "create">;
  content: string;
}

/** Whole-file replacement of an existing file. */
export interface ReviewableOverwrite extends ReviewableActionBase {
  kind: Extract<ReviewableActionKind, "overwrite">;
  content: string;
  preimageDigest: Preimage["sha256"];
}

export type ReviewableAction = ReviewableEdit | ReviewableCreate | ReviewableOverwrite;

/**
 * The only context allowed to leave the host for this review. Other files, session history and
 * host state have no field here and are never copied into the payload.
 */
export interface AllowedReviewContext {
  task: string;
  /** Quoted lines the host observed. Untrusted data. */
  evidence?: string[];
  /** Current content of the target file (edit/overwrite). Only an excerpt is sent. */
  preimage?: string;
  /** Maximum preimage lines sent. Defaults to `DEFAULT_PREIMAGE_LINE_LIMIT`. */
  preimageLineLimit?: number;
}

/**
 * `shadow`: optional review, never changes native execution. `enforced`: anything but `permit`
 * (reject, unavailable, proposal_only) blocks the action.
 */
export type ActionReviewMode = "shadow" | "enforced";

export type ActionReviewStatus = ReviewVerdict;

/** `ask` is shape-compatible with `JevClient.noul` from `src/jev`. */
export type NoulAsk = (
  questions: readonly NoulQuestion[],
  options: JevCallOptions,
) => Promise<JevResult<NoulEvidence[]>>;

/**
 * Review evidence for one action. Carries no grant, authorization or approval field: `permit`
 * is evidence about the action, and the host still decides whether to execute it.
 */
export interface ActionReview {
  actionId: string | null;
  mode: ActionReviewMode;
  validation: ValidationResult;
  status: ActionReviewStatus;
  reason: string;
  /** Null only when the action is too malformed to pick a question set. */
  questionSetVersion: string | null;
  /** Model reported by a valid response; null when none was reported. Never filled from the request pin. */
  model: string | null;
  policyVersion: string;
  evidenceRefs: string[];
  answers: ReviewAnswers | null;
  /**
   * Non-null when the host must not execute the action because of this review: enforced mode with
   * reject, unavailable or proposal_only (a proposal may be shown but not applied). Always null in shadow.
   */
  blocked: string | null;
}
