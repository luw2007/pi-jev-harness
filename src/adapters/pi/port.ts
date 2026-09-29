/**
 * Pi implementation of the host port (`../core/port.ts`). Pi 0.87.1 applies `setActiveTools`
 * synchronously; the port returns undefined so `applyToolSet` never awaits on Pi.
 */
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { HostPort, HostSessionView } from "../core/port.ts";
import { continuationResult } from "./lifecycle.ts";

export type PiPort = HostPort<ExtensionContext, ToolInfo, AgentBeforeSettleEvent, AgentBeforeSettleEventResult>;

export function piSessionView(ctx: ExtensionContext): HostSessionView {
  const manager = ctx.sessionManager;
  const parent = manager.getHeader()?.parentSession;
  const parentSession = typeof parent === "string" && parent.length > 0 ? parent : undefined;
  return {
    sessionId: manager.getSessionId() || undefined,
    leafId: manager.getLeafId() ?? undefined,
    cwd: ctx.cwd,
    signal: ctx.signal,
    parentSession,
    isChildSession: parentSession !== undefined,
    // Pi exposes no background-task registry to extensions.
    hasPendingWork: () => ctx.hasPendingMessages(),
    hasUI: ctx.hasUI,
    confirm: (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : undefined),
    notify: (message, level) => ctx.ui.notify(message, level),
  };
}

export function createPiPort(pi: ExtensionAPI): PiPort {
  return {
    host: "pi",
    getAllTools: () => pi.getAllTools(),
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => {
      pi.setActiveTools(names);
    },
    registerTool: (tool) => pi.registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]),
    registerCommand: (name, command) => pi.registerCommand(name, command as Parameters<ExtensionAPI["registerCommand"]>[1]),
    listCommands: () => pi.getCommands().map(({ name, source }) => ({ name, source })),
    session: piSessionView,
    blockResult: (reason) => ({ block: true, reason }),
    contextResult: (messages) => ({ messages }),
    continueResult: (decision, event) => continuationResult(event, decision.prompt),
  };
}
