// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:src/context.ts (MIT)
//
// Decision cache for request-level context reduction. C re-emitted replacements keyed by
// toolCallId only and cached Jev answers by state digest; here one bounded LRU holds the final
// per-result decision keyed by session, branch, task revision, policy and a digest of the
// original call and result, so the same result gets the same bytes on every request (stable
// prompt prefix) and a changed result, branch, revision or policy never reuses an old decision.
// Pure in-memory; no clock, environment or file system.
import { createHash } from "node:crypto";

/** What identifies one tool result's content. Same fields as fast-jev's `callCacheKey`. */
export interface DecisionIdentity {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  text: string;
  isError: boolean;
}

/** Everything outside the content that a decision depends on. */
export interface DecisionScope {
  sessionId: string;
  branchId: string;
  /** Caller-owned task revision; a new value makes every older decision unreachable. */
  revision: string;
  /** Provider/model/question version/threshold the decision was made under. */
  policy: string;
}

export interface CachedDecision {
  /** Jev's verdict on the full result: keep it verbatim, or move it out of context. */
  verdict: "keep" | "drop";
  /** Jev's keep probability for the full result. */
  keepResult: number;
  /**
   * Exact replacement text once the payload was archived. Re-emitted byte for byte on later
   * requests. Absent for `keep`, and for `drop` until an archive write succeeded.
   */
  replacement?: string;
  handle?: string;
}

export interface DecisionCache {
  /**
   * Records the branch a session is on. Switching branch drops every decision of that session
   * and returns true.
   */
  enter(sessionId: string, branchId: string): boolean;
  get(scope: DecisionScope, digest: string): CachedDecision | undefined;
  set(scope: DecisionScope, digest: string, decision: CachedDecision): void;
  /** Drops the decisions of a session (optionally of one branch only); returns how many. */
  invalidate(sessionId: string, branchId?: string): number;
  readonly size: number;
}

export interface DecisionCacheOptions {
  /** Maximum cached decisions across all sessions. Default 4096. */
  maxEntries?: number;
  /** Maximum sessions whose current branch is tracked. Default 256. */
  maxSessions?: number;
}

export const DEFAULT_MAX_DECISIONS = 4096;
export const DEFAULT_MAX_SESSIONS = 256;

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return String(value);
  }
}

/** Full sha256 over the original call and result. Same id with a different result differs. */
export function decisionDigest(identity: DecisionIdentity): string {
  const hash = createHash("sha256");
  for (const part of [identity.toolCallId, identity.toolName, stableJson(identity.arguments), identity.text]) {
    hash.update(part);
    hash.update("\0");
  }
  hash.update(identity.isError ? "error" : "success");
  return hash.digest("hex");
}

function scopeKey(scope: DecisionScope): string {
  return JSON.stringify([scope.sessionId, scope.branchId, scope.revision, scope.policy]);
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function createDecisionCache(options: DecisionCacheOptions = {}): DecisionCache {
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_DECISIONS);
  const maxSessions = positiveInt(options.maxSessions, DEFAULT_MAX_SESSIONS);
  // key -> entry; Map iteration order is insertion order, so re-inserting on use gives LRU.
  const entries = new Map<string, { sessionId: string; branchId: string; decision: CachedDecision }>();
  const branches = new Map<string, string>();

  const touch = <K, V>(map: Map<K, V>, key: K, value: V): void => {
    map.delete(key);
    map.set(key, value);
  };

  function invalidate(sessionId: string, branchId?: string): number {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.sessionId === sessionId && (branchId === undefined || entry.branchId === branchId)) {
        entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    enter(sessionId, branchId) {
      const previous = branches.get(sessionId);
      touch(branches, sessionId, branchId);
      while (branches.size > maxSessions) {
        const oldest = branches.keys().next().value as string;
        branches.delete(oldest);
        invalidate(oldest);
      }
      if (previous === undefined || previous === branchId) return false;
      invalidate(sessionId);
      return true;
    },
    get(scope, digest) {
      const key = `${scopeKey(scope)}:${digest}`;
      const entry = entries.get(key);
      if (!entry) return undefined;
      touch(entries, key, entry);
      return { ...entry.decision };
    },
    set(scope, digest, decision) {
      touch(entries, `${scopeKey(scope)}:${digest}`, {
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        decision: { ...decision },
      });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
    invalidate,
    get size() {
      return entries.size;
    },
  };
}
