/**
 * Harness contracts in one place (technical design §5, §7.1).
 *
 * Where each type lives (declared here unless a module is named):
 * - Actions (T011), declared here: `ACTION_KINDS`/`ActionKind`, `ToolCallInput`, `FsStat`,
 *   `HarnessFs`, `AuthorizationScope`, `ActionHost`, `ActionPolicy`, `Preimage`, `Replacement`,
 *   `ActionChange`, `ScopeRef`, `ActionEnvelope`, `EnvelopeValidation`, `Freshness`.
 *   Behaviour: `./actions.ts`.
 * - Review (T012), `./review-types.ts`: `ReviewableAction` (+ `ReviewableEdit`/`Create`/`Overwrite`,
 *   `ReviewableActionKind`) is a view derived from `ActionEnvelope`, built only by
 *   `toReviewableAction` in `./review.ts`; `AllowedReviewContext`, `ActionReviewMode`,
 *   `ActionReviewStatus`, `NoulAsk`, `ActionReview`. Question sets: `./review-questions.ts`.
 * - Evidence (T013), `./evidence.ts`: `Evidence`, `EvidenceOutcome`, `EvidenceOutput`,
 *   `EvidenceOutputBlock`, `EvidenceArtifact`, `ToolResultInput`, `EvidenceOptions`,
 *   `RecordedToolResult`, `FileChange`, `ChangeKind`.
 * - Receipts (T013), `./receipt.ts`: `RuntimeReceipt`, `SealedRuntimeReceipt`, `RuntimeReceiptInput`,
 *   `DigestRef`, `ReceiptExecution`, `ReceiptVerification`, `ReceiptUsage`, `ExecutionStatus`,
 *   `VerificationStatus`, `TrustedCurrent`, `ReplayOutcome`.
 * - Run products (T013/T015), `./run-artifacts.ts`: `RunRecord`, `RunJson`, `RunUsage`, `UsageTotal`,
 *   `RunVerification`, `VerificationWaiver`, `RunCompletion`, `TaskStatus`, `RunArtifactsFs`, `WriteRunArtifactsOptions`.
 * - Completion (T020), `./completion.ts`: `CompletionResult` (§5), `CompletionStatus`, `CompletionGap`,
 *   `CompletionGapCode`, `CompletionValidation`, `CompletionTask`, `CompletionTaskKind`,
 *   `CompletionEvidence`, `AssessmentKind`, `ChoiceAsk`, `AssessAcceptanceInput`,
 *   `AssessCheckpointInput`, `ForemanDimension`, `ForemanDimensionId`, `ForemanScores`,
 *   `ForemanAction`, `ForemanDecision`.
 * - Continuation (T021), `./continuation.ts`: `ContinuationInput`, `ContinuationDecision`,
 *   `ContinuationAssessment`, `ContinuationSnapshot`, `ContinuationThresholds`, `ContinuationStopReason`.
 * - Lifecycle controller (T022/T027), `./controller.ts`: `Controller`, `ControllerOptions`,
 *   `ControllerMode`, `ControllerEvent`, `ControllerResult`, `ControllerPhase`, `ActivePhase`,
 *   `ControllerSnapshot`, `ControllerTransition`, `DiscardedDecision`, `AssessContext`, `AssessFn`,
 *   `DecideInput`, `DecideFn`. `assess` returns `CompletionResult`; `decide` returns `ContinuationDecision`.
 *
 * `AuthorizationScope` is the only authorization structure: `ReviewableAction.grantId` and
 * `RuntimeReceipt.authorizationRef` hold its `id`, never a copy of the grant.
 *
 * The harness never imports Pi/OMP types: adapters translate a native tool
 * call into `ToolCallInput`, and file-system access arrives through the
 * minimal injected `HarnessFs` interface.
 */

export type {
  ActionReview,
  ActionReviewMode,
  ActionReviewStatus,
  AllowedReviewContext,
  NoulAsk,
  ReviewableAction,
  ReviewableActionKind,
  ReviewableCreate,
  ReviewableEdit,
  ReviewableOverwrite,
} from "./review-types.ts";
export type {
  ChangeKind,
  Evidence,
  EvidenceArtifact,
  EvidenceOptions,
  EvidenceOutcome,
  EvidenceOutput,
  EvidenceOutputBlock,
  FileChange,
  RecordedToolResult,
  ToolResultInput,
} from "./evidence.ts";
export type {
  DigestRef,
  ExecutionStatus,
  ReceiptExecution,
  ReceiptUsage,
  ReceiptVerification,
  ReplayOutcome,
  RuntimeReceipt,
  RuntimeReceiptInput,
  SealedRuntimeReceipt,
  TrustedCurrent,
  VerificationStatus,
} from "./receipt.ts";
export type {
  RunArtifactsFs,
  RunCompletion,
  RunJson,
  RunRecord,
  RunUsage,
  RunVerification,
  TaskStatus,
  UsageTotal,
  VerificationWaiver,
  WriteRunArtifactsOptions,
} from "./run-artifacts.ts";

export type {
  AssessAcceptanceInput,
  AssessCheckpointInput,
  AssessmentKind,
  ChoiceAsk,
  CompletionEvidence,
  CompletionGap,
  CompletionGapCode,
  CompletionResult,
  CompletionStatus,
  CompletionTask,
  CompletionTaskKind,
  CompletionValidation,
  ForemanAction,
  ForemanDecision,
  ForemanDimension,
  ForemanDimensionId,
  ForemanScores,
} from "./completion.ts";
export type {
  ContinuationAssessment,
  ContinuationDecision,
  ContinuationInput,
  ContinuationSnapshot,
  ContinuationStopReason,
  ContinuationThresholds,
} from "./continuation.ts";
export type {
  ActivePhase,
  AssessContext,
  AssessFn,
  Controller,
  ControllerEvent,
  ControllerMode,
  ControllerOptions,
  ControllerPhase,
  ControllerResult,
  ControllerSnapshot,
  ControllerTransition,
  DecideFn,
  DecideInput,
  DiscardedDecision,
} from "./controller.ts";

export const ACTION_KINDS = Object.freeze([
  "read",
  "search",
  "edit",
  "create",
  "overwrite",
  "command",
  "unsupported",
] as const);
export type ActionKind = (typeof ACTION_KINDS)[number];

/** A native tool call as the adapter observed it. */
export interface ToolCallInput {
  toolName: string;
  /** Raw tool arguments; parsed into plain data by `buildEnvelope`. */
  args: unknown;
  /** Host-assigned tool call id; the host `newId` fills it in when absent. */
  toolCallId?: string;
  /** Model-authored explanation, kept apart from host observations. */
  rationale?: string;
  /**
   * Host-set marker that a whole-file write may replace an existing file.
   * Never read from model arguments: Pi's write schema has no such field.
   */
  overwrite?: boolean;
}

export interface FsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

/**
 * Minimal file-system surface. `node:fs/promises` satisfies it. Missing paths
 * must reject with an error whose `code` is `ENOENT` or `ENOTDIR`.
 */
export interface HarnessFs {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<FsStat>;
  realpath(path: string): Promise<string>;
}

/** A grant the user gave for the current goal. Jev scores never widen it. */
export interface AuthorizationScope {
  id: string;
  kinds: readonly ActionKind[];
  /** Upper bound for any single file read, replaced, or written. */
  maxFileBytes: number;
}

export interface ActionHost {
  cwd: string;
  fs: HarnessFs;
  allowedRoots: readonly string[];
  grants: readonly AuthorizationScope[];
  newId(): string;
}

export interface ActionPolicy {
  fs: HarnessFs;
  allowedRoots: readonly string[];
  grants: readonly AuthorizationScope[];
}

export interface Preimage {
  /** Realpath of the file the digest was taken from. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface Replacement {
  oldText: string;
  newText: string;
}

export type ActionChange =
  | { format: "replacements"; edits: Replacement[] }
  | { format: "unified_diff"; patch: string }
  | { format: "content"; sha256: string; bytes: number }
  | { format: "command"; script: string; cwd: string }
  | { format: "command"; argv: string[]; cwd: string };

export interface ScopeRef {
  /** Grant covering this action's kind when it was built; null means none. */
  grant: AuthorizationScope | null;
  /** Realpaths of the allowed roots at build time. */
  roots: string[];
}

export interface ActionEnvelope {
  actionId: string;
  toolCallId: string;
  kind: ActionKind;
  toolName: string;
  /** Plain-data copy of the tool arguments; null when they were not a plain object. */
  args: Record<string, unknown> | null;
  /** Lexically resolved absolute paths, before symlinks are followed. */
  requestedPaths: string[];
  /** Realpaths of the targets (nearest existing ancestor + remainder for new files). */
  targets: string[];
  preimage: Preimage | null;
  change: ActionChange | null;
  scope: ScopeRef;
  /** Model-authored explanation. Host observations live in the fields above. */
  rationale: string | null;
  /** Unsupported actions are withheld; they never fall through to a shell. */
  withheld: boolean;
  /** Structural problems found while building; validation rejects when non-empty. */
  issues: string[];
}

export type EnvelopeValidation = { ok: true } | { ok: false; reason: string };

export type Freshness = { status: "fresh" } | { status: "stale"; reason: string };
