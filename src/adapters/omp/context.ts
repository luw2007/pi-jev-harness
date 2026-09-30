/**
 * C7 request-level context reduction for OMP (T105 L4). Reuses the host-neutral hook of the Pi
 * adapter (`../pi/context.ts`, no Pi import) and the shared reducer/archive (`../../context`):
 * - off (session off or `context.request` off): nothing computed, zero Jev requests.
 * - shadow: reduction runs in the background and is recorded (would-reduce); request unchanged.
 * - on: each reduced tool result is archived first (session-scoped, content-addressed) and only
 *   then replaced by a spill notice with a `jev_recall` handle; `jev_recall` returns the archived
 *   bytes unchanged. Unwritable store, Jev unavailable, budget, credential or timeout → originals.
 *
 * Legacy compatibility (jev-compaction/context.ts):
 * - `OMP_JEV_SPILL=0` (no archive): the request is never replaced, only recorded (shadow).
 * - Cache guard (`judgeCache`): with a ceiling configured (`OMP_JEV_CACHE_CEILING` or
 *   `context.fastJev.cacheCeiling`), a session whose latest assistant usage is at least that share
 *   cache reads is left alone without asking Jev. Without a ceiling there is no guard: the legacy
 *   default ("sticky" rewrites) never consulted it either; here decisions are cached per content,
 *   which keeps the prefix stable the same way.
 */
import type { JevAccess } from "../shared/jev-access.ts";
import type { TelemetryInput } from "../../telemetry/index.ts";
import type { HostToolDefinition, HostToolResult } from "../core/port.ts";
import { CONTEXT_DISABLED_MESSAGE, createPiContextHook, RECALL_PARAMETERS, RECALL_TOOL, type ContextHookCtx, type PiContextHook } from "../pi/context.ts";
import type { SpillFs } from "../../context/index.ts";
import type { OmpContextSettings } from "./context-settings.ts";
import { ompSessionView } from "./port.ts";
import type { AdapterConfig } from "./shared.ts";
import type { OmpContext, OmpContextEvent, OmpContextResult } from "./types.ts";

export { RECALL_TOOL, CONTEXT_DISABLED_MESSAGE };

type Mode = "off" | "shadow" | "on";

export interface OmpContextDeps {
  /** T105 C9: provider chain / legacy mapping / single-url for the `toolContext` capability. */
  jev?: JevAccess;
  config: AdapterConfig;
  settings: OmpContextSettings;
  runId: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  onJevRequest: () => void;
  record: (event: TelemetryInput) => void;
  onFallback?: (reason: string) => void;
  fs?: SpillFs;
}

export interface OmpContextReducer {
  handle(event: OmpContextEvent, ctx: OmpContext, mode: Mode): Promise<OmpContextResult | undefined>;
  startTask(): void;
  recallTool(params: unknown, ctx: OmpContext): Promise<HostToolResult>;
  statusLines(mode: Mode): string[];
  abort(reason: string): void;
  settled(): Promise<void>;
}

/** Legacy cache-guard verdict over the latest assistant usage (`cache-guard.ts judgeCache`). */
export function cacheDominated(messages: readonly unknown[], ceiling: number): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; usage?: { input?: number; cacheRead?: number } } | null;
    if (message?.role !== "assistant" || !message.usage) continue;
    const input = message.usage.input ?? 0, cacheRead = message.usage.cacheRead ?? 0;
    if (input + cacheRead === 0) continue;
    return cacheRead / (input + cacheRead) >= ceiling;
  }
  // No billing evidence: reduce (legacy "no-usage").
  return false;
}

/** OMP context → the hook's host-neutral view; OMP has no ctx.signal (it is on the event). */
function hookCtx(ctx: OmpContext): ContextHookCtx {
  const view = ompSessionView(ctx);
  const manager = ctx.sessionManager;
  return {
    sessionManager: {
      getSessionId: () => view.sessionId ?? "",
      getLeafId: () => (manager.getLeafId ? manager.getLeafId() : null),
      getBranch: () => (manager.getBranch ? manager.getBranch() : []),
    },
  };
}

export function createOmpContextReducer(deps: OmpContextDeps): OmpContextReducer {
  const { settings } = deps;
  const hook: PiContextHook = createPiContextHook({
    ...(deps.jev ? { jev: deps.jev } : {}),
    config: deps.config,
    runId: deps.runId,
    env: deps.env,
    fetch: deps.fetch,
    now: deps.now,
    newId: deps.newId,
    onJevRequest: deps.onJevRequest,
    record: deps.record,
    ...(deps.onFallback ? { onFallback: deps.onFallback } : {}),
    ...(deps.fs ? { fs: deps.fs } : {}),
    limits: { keepThreshold: settings.keepThreshold },
    ...(settings.model ? { model: settings.model } : {}),
  });
  let guarded = 0;

  return {
    async handle(event, ctx, mode) {
      if (mode === "off" || deps.config.context.request === "off") return undefined;
      if (ompSessionView(ctx).isChildSession) return undefined;
      const messages = Array.isArray(event?.messages) ? event.messages : undefined;
      if (!messages) return undefined;
      if (settings.cacheCeiling !== undefined && cacheDominated(messages, settings.cacheCeiling)) {
        guarded++;
        deps.record({ runId: deps.runId, decisionId: `dec_${deps.newId()}`, kind: "context", outcome: "skipped", durationMs: 0, source: "context:cache_guard" });
        return undefined;
      }
      // Without an archive nothing may be replaced: record only.
      const effective: Mode = mode === "on" && !settings.spill ? "shadow" : mode;
      const result = await hook.handle({ messages }, hookCtx(ctx), effective);
      return result ? { messages: result.messages } : undefined;
    },
    startTask: () => hook.startTask(),
    recallTool: (params, ctx) => hook.recallTool(params, hookCtx(ctx)),
    statusLines(mode) {
      return [
        ...hook.statusLines(mode).slice(0, 1),
        ...(settings.spill ? [] : ["上下文裁剪：OMP_JEV_SPILL=0（不存档），仅观察"]),
        ...(settings.cacheCeiling !== undefined ? [`缓存守卫：ceiling ${settings.cacheCeiling}，已跳过 ${guarded} 次`] : []),
      ];
    },
    abort: (reason) => hook.abort(reason),
    settled: () => hook.settled(),
  };
}

/** `jev_recall` definition for `registerTool`; `execute` delegates to the session's reducer. */
export function recallToolDefinition(recall: (params: unknown, ctx: OmpContext) => Promise<HostToolResult>): HostToolDefinition<OmpContext> & { defaultInactive: boolean } {
  return {
    name: RECALL_TOOL,
    label: "Jev recall",
    description: 'Return the full original text of a tool result that was replaced by a "[jev spill: …]" notice in this session. Pass the handle from the notice.',
    parameters: RECALL_PARAMETERS,
    // Activated at session start only when request reduction is not off (no host change when off).
    defaultInactive: true,
    // Undeclared extension tools are mounted under xdev ("discoverable") and never reach the model.
    loadMode: "essential",
    execute: (_id, params, _signal, _update, ctx) => recall(params, ctx),
  };
}
