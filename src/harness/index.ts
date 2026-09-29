/**
 * Public harness surface. Types come from `./types.ts` (which lists their source modules);
 * functions and constants come from the module that implements them. Every exported name is
 * unique across the harness modules; an explicit export would silently win over `export *`,
 * so a new name that collides must be renamed at its source, not listed here.
 */
export const VERSION = "0.0.0";

export * from "./types.ts";
export { buildEnvelope, checkFreshness, isFastPathRead, replacementsToUnifiedDiff, validateEnvelope } from "./actions.ts";
export {
  ACTION_REVIEW_POLICY_VERSION,
  DEFAULT_PREIMAGE_LINE_LIMIT,
  MAX_REVIEW_CHANGE_CHARS,
  buildActionReviewPayload,
  decideActionReview,
  reviewAction,
  toReviewableAction,
  validateReviewableAction,
  type DecideActionReviewOptions,
  type ReviewActionInput,
} from "./review.ts";
export {
  H_PROPOSAL_V4,
  HOST_ACTION_QUESTIONS_V1,
  HOST_ACTION_V1,
  questionSetFor,
  type QuestionSetVersion,
  type ReviewQuestionSet,
} from "./review-questions.ts";
export {
  DEFAULT_SUMMARY_LINES,
  EVIDENCE_OUTCOMES,
  EvidenceLedger,
  recordToolResult,
  sha256Hex,
  summarizeChangeset,
} from "./evidence.ts";
export {
  EXECUTION_STATUSES,
  RUNTIME_RECEIPT_SCHEMA_VERSION,
  VERIFICATION_STATUSES,
  createRuntimeReceipt,
  replayReceipt,
} from "./receipt.ts";
export {
  RUN_FILES,
  RUN_JSON_SCHEMA_VERSION,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  buildRunJson,
  defaultRunDir,
  renderSummary,
  summarizeUsage,
  writeRunArtifacts,
} from "./run-artifacts.ts";
export {
  ACCEPTANCE_QUESTION,
  ACCEPTANCE_QUESTION_ID,
  COMPLETION_POLICY_VERSION,
  COMPLETION_STATUSES,
  COMPLETION_TASK_KINDS,
  FOREMAN_DIMENSION_IDS,
  FOREMAN_DIMENSIONS,
  FOREMAN_THRESHOLDS,
  assessAcceptance,
  assessCheckpoint,
  chooseAssessment,
  decideForeman,
  validateForemanScores,
} from "./completion.ts";
export {
  CONTINUATION_AUTONOMOUS_THRESHOLD,
  CONTINUATION_DONE_THRESHOLD,
  CONTINUATION_STOP_REASONS,
  DEFAULT_MAX_CONTINUATIONS,
  buildContinuationPrompt,
  decideContinuation,
} from "./continuation.ts";
export { createController } from "./controller.ts";
