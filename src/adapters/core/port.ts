/**
 * Host port: the small, host-independent surface the adapters drive. Each host
 * (Pi: `../pi/port.ts`, OMP: `../omp/port.ts`) implements it by mapping its own API field by
 * field; nothing here imports a host package, so both adapters and host-neutral logic can use it.
 *
 * Covered: tool snapshot/apply (apply may be async: OMP 18.3.5 `setActiveTools(): Promise<void>`),
 * tool_call block, stop/continue result, context messages, tool/command registration, ui.confirm,
 * pending-work checks, session identity and child-session detection. Event wiring (`on(...)`) stays
 * in each host adapter: event names and ordering differ per host (Pi `agent_before_settle`, OMP
 * `session_stop`).
 */

export type MaybePromise<T> = T | Promise<T>;

/** A tool row as both hosts report it from `getAllTools()`. */
export interface HostToolInfo {
  name: string;
  description?: unknown;
  parameters?: unknown;
  sourceInfo?: { source?: string; path?: string };
}

/** Text tool result; both hosts accept `{content, details}`. */
export interface HostToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

/** Tool this extension registers (plain JSON Schema parameters). */
export interface HostToolDefinition<Ctx = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  /** OMP: `"essential"` keeps the tool top-level (extension tools default to discoverable). Pi ignores it. */
  loadMode?: "essential" | "discoverable";
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<HostToolResult>;
}

export interface HostCommandDefinition<Ctx = unknown> {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: Ctx) => unknown;
}

/** An already registered slash command, when the host can list them. */
export interface HostCommandInfo {
  name: string;
  source?: string;
  path?: string;
}

/** `tool_call` result: identical on Pi and OMP (`{block, reason}`). */
export interface ToolCallBlock {
  block: true;
  reason: string;
}

/** Host-neutral continuation decision at the end-of-task boundary. */
export interface StopContinue {
  /** Model-visible text for the one continuation turn. */
  prompt: string;
}

/** `context` result: identical on Pi and OMP (`{messages}`). */
export interface ContextMessagesResult<M = unknown> {
  messages: M[];
}

/**
 * Per-event view of the host context. Built by `HostPort.session(ctx)`; never cached across events
 * (the host context is only valid for the handler call it was passed to).
 */
export interface HostSessionView {
  sessionId: string | undefined;
  leafId: string | undefined;
  cwd: string;
  /** Host run signal while the agent streams. */
  signal: AbortSignal | undefined;
  /** Parent session id/path when this is a spawned (child/sub) session. */
  parentSession: string | undefined;
  /** Child sessions are never intervened in (安全). */
  isChildSession: boolean;
  /** Queued user messages or running/pending async jobs: no continuation now. */
  hasPendingWork(): boolean;
  hasUI: boolean;
  /** `ui.confirm`; `undefined` when the host has no UI (print/RPC): caller applies its no-UI policy. */
  confirm(title: string, message: string): Promise<boolean> | undefined;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/**
 * The port. `Ctx` is the host's handler context, `Tool` its `getAllTools()` row, `StopEvent` /
 * `StopResult` its end-of-task event and result.
 */
export interface HostPort<Ctx = unknown, Tool extends HostToolInfo = HostToolInfo, StopEvent = unknown, StopResult = unknown> {
  readonly host: "pi" | "omp";
  getAllTools(): Tool[];
  getActiveTools(): string[];
  /** Pi applies synchronously; OMP returns a promise that must be awaited before read-back. */
  setActiveTools(names: string[]): MaybePromise<void>;
  registerTool(tool: HostToolDefinition<Ctx>): void;
  registerCommand(name: string, command: HostCommandDefinition<Ctx>): void;
  /** Registered slash commands, or `undefined` when the host cannot list them. */
  listCommands(): HostCommandInfo[] | undefined;
  session(ctx: Ctx): HostSessionView;
  blockResult(reason: string): ToolCallBlock;
  contextResult<M>(messages: M[]): ContextMessagesResult<M>;
  /** Host result that makes the end-of-task boundary run one more turn with `decision.prompt`. */
  continueResult(decision: StopContinue, event: StopEvent): StopResult;
}

/** True for a thenable: callers await only then, so a synchronous host stays synchronous. */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}

export function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a), right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Tool set after giving back `owned` removals: every tool currently active stays, each owned tool
 * that is missing is added back, in the order of `baseline` (tools outside it keep their current
 * order at the end). Never removes a tool and never adds one we did not remove.
 */
export function restoreOwnedTools(current: readonly string[], owned: readonly string[], baseline: readonly string[]): string[] {
  const wanted = new Set([...current, ...owned]);
  const ordered = baseline.filter((id) => wanted.has(id));
  const seen = new Set(ordered);
  return [...new Set([...ordered, ...current.filter((id) => !seen.has(id))])];
}

export type ToolSetApply =
  | { ok: true; readBack: string[] }
  | { ok: false; readBack: string[]; restored: boolean };

/**
 * Set `target`, read it back, and on a mismatch put `previous` back and verify that. Awaits the
 * host only when it returns a promise (OMP); on a synchronous host (Pi) set and read-back run in one
 * synchronous step, exactly as before the extraction. Host errors propagate to the caller.
 */
export async function applyToolSet(port: Pick<HostPort, "getActiveTools" | "setActiveTools">, previous: readonly string[], target: readonly string[]): Promise<ToolSetApply> {
  const set = port.setActiveTools([...target]);
  if (isPromiseLike(set)) await set;
  const readBack = port.getActiveTools();
  if (sameToolSet(readBack, target)) return { ok: true, readBack };
  const undo = port.setActiveTools([...previous]);
  if (isPromiseLike(undo)) await undo;
  return { ok: false, readBack, restored: sameToolSet(port.getActiveTools(), previous) };
}
