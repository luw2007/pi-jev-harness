/**
 * Per-task lifecycle wiring for Pi: the host-neutral lifecycle (`../core/lifecycle.ts`, T105)
 * behind Pi's `agent_before_settle` boundary. Behavior is unchanged from before the extraction:
 * an aborted outcome cancels, an error outcome neither assesses nor continues, and a continuation
 * is returned as one visible `custom_message` entry plus `continue: true`.
 */
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createTaskLifecycle as createCoreLifecycle,
  type LifecycleDeps,
  type TaskLifecycle as CoreTaskLifecycle,
} from "../core/lifecycle.ts";

export {
  ACCEPTANCE_TOOL,
  ASSESSMENT_TOOLS,
  CONTINUATION_MESSAGE_TYPE,
  CONTINUATION_POLICY_VERSION,
  CONTINUATION_QUESTIONS,
  FOREMAN_TOOL,
  unavailableCompletion,
  type ContinuationRecord,
  type HostEvidence,
  type LifecycleDeps,
  type SettleBoundary,
} from "../core/lifecycle.ts";
import { CONTINUATION_MESSAGE_TYPE } from "../core/lifecycle.ts";

export interface TaskLifecycle extends Omit<CoreTaskLifecycle, "settle"> {
  beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined>;
}

/** Pi's continuation shape: append one visible custom message and ask for one more request. */
export function continuationResult(event: AgentBeforeSettleEvent, prompt: string): AgentBeforeSettleEventResult {
  return {
    entries: [...event.entries, { type: "custom_message", customType: CONTINUATION_MESSAGE_TYPE, content: prompt, display: true }],
    continue: true,
  };
}

export function createTaskLifecycle(deps: LifecycleDeps): TaskLifecycle {
  const { settle, ...core } = createCoreLifecycle(deps);
  return {
    ...core,
    async beforeSettle(event, ctx) {
      if (event.outcome === "aborted") {
        core.cancel();
        return undefined;
      }
      // The model request failed: the run is failed (harness), nothing to assess or continue.
      if (event.outcome === "error") return undefined;
      const result = await settle({
        cancelled: () => event.outcome === "aborted" || ctx.signal?.aborted === true,
        pendingUserMessage: () => event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(),
        // Pi exposes no background-task registry to extensions.
        runningBackgroundTasks: () => 0,
        sessionId: () => ctx.sessionManager.getSessionId(),
        branchId: () => ctx.sessionManager.getLeafId() ?? undefined,
        contextPercent: () => ctx.getContextUsage()?.percent,
      });
      return result ? continuationResult(event, result.prompt) : undefined;
    },
  };
}
