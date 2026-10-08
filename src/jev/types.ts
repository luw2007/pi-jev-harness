/** Jev transport types: wire shapes, typed evidence, attempt ledger rows, profiles. No business thresholds. */

/** Closed-set question. `question` becomes the wire `instructions`; option descriptions become `criteria`. */
export interface ChoiceQuestion {
  id: string;
  question: string;
  options: { id: string; description: string }[];
}

/** Yes/no probability question. `question` becomes the wire `instructions`. */
export interface NoulQuestion {
  id: string;
  question: string;
}

/** Strictly parsed Choice answer; `model` is the model the response reported. */
export interface ChoiceEvidence {
  questionId: string;
  model: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Strictly parsed Noul answer; `yes` is the reported yes probability in [0, 1]. */
export interface NoulEvidence {
  questionId: string;
  model: string;
  yes: number;
}

export type JevAttemptStatus = "ok" | "http_error" | "timeout" | "aborted" | "too_large" | "malformed" | "network_error";

/** One physical HTTP request. Emitted exactly once per dispatched request. */
export interface JevAttempt {
  attemptId: string;
  decisionId: string;
  startedAt: number;
  durationMs: number;
  status: JevAttemptStatus;
  httpStatus?: number;
  requestBytes: number;
  /** Response body bytes actually read before the attempt ended. */
  responseBytes: number;
  /** Provider-reported `usage.input_tokens` / `usage.output_tokens` of an ok response; absent when not reported. */
  inputTokens?: number;
  outputTokens?: number;
}

/** How a response's reported model is checked against the pinned model. */
export type IdentityPolicy = "exact" | "prefix" | "none";

export interface JevProfile {
  id: string;
  url: string;
  /** Pinned request model; responses must report the same model (see `identity`). */
  model: string;
  /** Model identity check; absent means `exact`. `none` accepts any reported model. */
  identity?: IdentityPolicy;
  /** Total deadline covering connect, headers and body read. */
  timeoutMs: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
}

/** First profile: TypeSafe System One, pinned to the H baseline model. */
export const TYPESAFE_PROFILE: Readonly<JevProfile> = Object.freeze({
  id: "typesafe",
  url: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 45_000,
  maxResponseBytes: 64_000,
  maxRequestBytes: 256_000,
});

/** Request `state`: caller-owned data to classify; never instructions. */
export type JevState = string | Record<string, unknown>;

export type WireErrorKind =
  | "not_object"
  | "model_missing"
  | "model_mismatch"
  | "answers_missing"
  | "question_id_mismatch"
  | "answer_type"
  | "choice_not_in_set"
  | "confidence_invalid"
  | "distribution_missing"
  | "distribution_missing_option"
  | "distribution_extra_option"
  | "probability_invalid"
  | "probability_sum"
  | "choice_not_argmax"
  | "noul_invalid";

/** Structural category only; never contains raw response text or values. */
export interface WireError {
  kind: WireErrorKind;
  questionId?: string;
}

export type WireResult<T> = { ok: true; value: T } | { ok: false; error: WireError };

export type JevErrorKind =
  | "invalid_request"
  | "request_too_large"
  | "http_error"
  | "timeout"
  | "aborted"
  | "too_large"
  | "malformed"
  | "network_error"
  | "no_provider_available";

/** Category only. Provider error text is never included: it may carry credentials or user data. */
export interface JevError {
  kind: JevErrorKind;
  httpStatus?: number;
  wire?: WireError;
}

/** `attempt` is absent when no physical request was sent. */
export type JevResult<T> =
  | { ok: true; evidence: T; attempt: JevAttempt }
  | { ok: false; error: JevError; attempt?: JevAttempt };
