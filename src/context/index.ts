/**
 * Public context surface (technical §8): Pi ⇄ context message mapping (T024), the
 * session-scoped spill store (T025), and the request-level reducer, decision cache and recall
 * (T028). Names are unique across all modules.
 */
export {
  DEFAULT_RECENT_TURNS,
  fromContextMessages,
  goalFromMessages,
  recentWindow,
  toContextMessages,
  type ContextMessage,
  type ContextToolCall,
  type ContextToolResult,
  type GoalOptions,
  type MappingOptions,
  type PiMessage,
  type ReducibleReason,
} from "./mapping.ts";
export {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_SESSION_BYTES,
  formatHandle,
  isSpillNotice,
  recallPayload,
  spillNotice,
  storePayload,
  type RecallFailureReason,
  type RecallResult,
  type SpillFs,
  type SpillNoticeMeta,
  type SpillOptions,
  type StoreFailureReason,
  type StoreResult,
} from "./spill.ts";
export {
  CONTEXT_POLICY_VERSION,
  createContextReducer,
  DEFAULT_CONTEXT_LIMITS,
  resolveLimits,
  type ContextAsk,
  type ContextAskRequest,
  type ContextLimits,
  type ContextReduceEvent,
  type ContextReducer,
  type ContextReducerDeps,
  type ContextStore,
  type ReduceInput,
  type ReduceOutput,
  type ReduceReason,
  type ReduceStats,
  type ResolvedContextLimits,
  type ResultDecision,
  type ResultReason,
} from "./reducer.ts";
export {
  createDecisionCache,
  decisionDigest,
  DEFAULT_MAX_DECISIONS,
  DEFAULT_MAX_SESSIONS,
  type CachedDecision,
  type DecisionCache,
  type DecisionCacheOptions,
  type DecisionIdentity,
  type DecisionScope,
} from "./cache.ts";
export { recall, RECALL_TOOL_NAME, type RecallErrorReason, type RecallOutcome, type RecallRequest } from "./recall.ts";
