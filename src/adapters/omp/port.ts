/**
 * OMP implementation of the host port (`../core/port.ts`). Field-by-field mapping of OMP 18.3.5
 * shapes (`./types.ts`); no Pi import.
 */
import { isPromiseLike, type HostPort, type HostSessionView } from "../core/port.ts";
import type { OmpContext, OmpExtensionAPI, OmpSessionStopEvent, OmpSessionStopResult, OmpToolInfo } from "./types.ts";

export type OmpPort = HostPort<OmpContext, OmpToolInfo, OmpSessionStopEvent, OmpSessionStopResult>;

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Queued user messages, or running async jobs, mean the session is not done. */
function pendingWork(ctx: OmpContext): boolean {
  if (attempt(() => ctx.hasPendingMessages?.()) === true) return true;
  const jobs = attempt(() => ctx.getAsyncJobSnapshot?.());
  return (jobs?.running.length ?? 0) > 0;
}

export function ompSessionView(ctx: OmpContext): HostSessionView {
  const manager = ctx.sessionManager;
  const parent = attempt(() => manager.getHeader()?.parentSession);
  const parentSession = typeof parent === "string" && parent.length > 0 ? parent : undefined;
  const leaf = attempt(() => manager.getLeafId?.());
  const hasUI = ctx.hasUI !== false;
  return {
    sessionId: attempt(() => manager.getSessionId?.()) || undefined,
    leafId: typeof leaf === "string" ? leaf : undefined,
    cwd: ctx.cwd ?? attempt(() => manager.getCwd?.()) ?? process.cwd(),
    // OMP passes the run signal on the event (session_stop/session_before_compact), not on ctx.
    signal: undefined,
    parentSession,
    isChildSession: parentSession !== undefined || ctx.agent?.kind === "sub",
    hasPendingWork: () => pendingWork(ctx),
    hasUI,
    confirm: (title, message) => (hasUI && ctx.ui.confirm ? ctx.ui.confirm(title, message) : undefined),
    notify: (message, level) => ctx.ui.notify(message, level),
  };
}

export function createOmpPort(api: OmpExtensionAPI): OmpPort {
  return {
    host: "omp",
    getAllTools: () => api.getAllTools(),
    getActiveTools: () => api.getActiveTools(),
    setActiveTools: (names) => {
      const result = api.setActiveTools(names);
      return isPromiseLike(result) ? Promise.resolve(result).then(() => undefined) : undefined;
    },
    registerTool(tool) {
      if (!api.registerTool) throw new Error("OMP host has no registerTool");
      api.registerTool(tool);
    },
    registerCommand: (name, command) => api.registerCommand(name, command),
    listCommands: () => (api.getCommands ? attempt(() => api.getCommands!().map(({ name, source, path }) => ({ name, source, ...(path ? { path } : {}) }))) : undefined),
    session: ompSessionView,
    blockResult: (reason) => ({ block: true, reason }),
    contextResult: (messages) => ({ messages }),
    continueResult: (decision) => ({ continue: true, additionalContext: decision.prompt }),
  };
}
