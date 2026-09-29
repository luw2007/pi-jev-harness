/**
 * Structural view of the OMP extension API this adapter touches. OMP ships as a compiled binary
 * with no installable declaration package, so these shapes are transcribed from oh-my-pi tag
 * `v18.3.5` (packages/coding-agent/src/extensibility/extensions/types.ts, extensibility/shared-events.ts,
 * extensibility/extensions/{runner,loader}.ts, session/agent-session{,-types}.ts). They are OMP's
 * own shapes, never Pi's types: nothing here is cast to `@earendil-works/pi-coding-agent`.
 *
 * Members added for are optional: older fakes/hosts may lack them, and callers must
 * feature-check (the OMP port in `./port.ts` does).
 */

/** `SourceInfo` of a `getAllTools()` row; extension tools carry their entry path in `path`. */
export interface OmpSourceInfo {
  /** Synthetic (`<builtin:read>`, `<extension:name>`) or absolute on-disk path. */
  path?: string;
  /** `"builtin"`, `"sdk"`, `"mcp"` or `"extension"`. */
  source?: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
}

/** `getAllTools()` row (`ToolInfo`). */
export interface OmpToolInfo {
  name: string;
  description?: unknown;
  parameters?: unknown;
  sourceInfo?: OmpSourceInfo;
}

/** `getCommands()` row (`SlashCommandInfo`). */
export interface OmpSlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
  path?: string;
}

/** Model object from `modelRegistry.getAvailable()` / `ctx.model`. */
export interface OmpModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface OmpModelRegistry {
  getAvailable(): OmpModel[];
  hasConfiguredAuth(model: OmpModel): boolean;
}

/** `AsyncJobSnapshotItem`. */
export interface OmpAsyncJob {
  id: string;
  type?: string;
  status?: string;
  label?: string;
  startTime?: number;
  endTime?: number;
  agentId?: string;
}

/** `getAsyncJobSnapshot()` (`AsyncJobSnapshot`): running, recent and pending-delivery jobs. */
export interface OmpAsyncJobSnapshot {
  running: OmpAsyncJob[];
  recent: OmpAsyncJob[];
  delivery?: unknown;
}

/** `ctx.agent` (`ExtensionAgentIdentity`): `kind: "sub"` for any spawned session. */
export interface OmpAgentIdentity {
  kind: "main" | "sub";
  id?: string;
  name?: string;
  depth?: number;
  parentId?: string;
}

/** `ReadonlySessionManager` subset. */
export interface OmpSessionManager {
  /** Session header; `parentSession` is set for a spawned/child session. */
  getHeader(): { parentSession?: string } | null | undefined;
  getBranch?(): ReadonlyArray<{ type?: string; id?: string }>;
  getSessionId?(): string;
  getLeafId?(): string | null;
  getCwd?(): string;
}

/** `ctx.getContextUsage()` (`ContextUsage`). */
export interface OmpContextUsage {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
}

/** `ExtensionUIContext` subset. `confirm` resolves false when dismissed. */
export interface OmpUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  confirm?(title: string, message: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<boolean>;
}

/** `ExtensionContext` subset (also the command context). */
export interface OmpContext {
  model: OmpModel | undefined;
  modelRegistry: OmpModelRegistry;
  sessionManager: OmpSessionManager;
  getContextUsage(): OmpContextUsage | undefined;
  ui: OmpUI;
  /** False in print/RPC mode. */
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  cwd?: string;
  /** Queued user messages waiting. */
  hasPendingMessages?(): boolean;
  /** Async jobs owned by this session; null when none are tracked. */
  getAsyncJobSnapshot?(): OmpAsyncJobSnapshot | null;
  isIdle?(): boolean;
  agent?: OmpAgentIdentity;
  /** Starts a compaction (proactive compaction); callbacks report the outcome. */
  compact?(options?: { onComplete?: () => void; onError?: (error: Error) => void }): Promise<void> | void;
}

// ---- Events (shared-events.ts / types.ts) -----------------------------------------------------

export interface OmpBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: readonly unknown[];
}

/** Fires when a main-agent turn is about to settle; not fired for subagent sessions. */
export interface OmpSessionStopEvent {
  type: "session_stop";
  messages: unknown[];
  turn_id: number;
  last_assistant_message?: unknown;
  session_id: string;
  session_file?: string;
  /** True while a previous stop handler's continuation is running. */
  stop_hook_active: boolean;
  signal: AbortSignal;
}

/** `session_stop` result: first handler with `continue` wins; host caps continuations at 8. */
export interface OmpSessionStopResult {
  continue?: boolean;
  /** Model-visible context for the continuation turn. */
  additionalContext?: string;
  /** Claude/Codex-compatible form; maps to a continuation. */
  decision?: "block";
  reason?: string;
}

export interface OmpAgentEndEvent {
  type: "agent_end";
  messages: unknown[];
  /** The session already scheduled an automatic continuation: not a terminal settle. */
  willContinue?: boolean;
}

export interface OmpToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** `tool_call` result. A throwing or timed-out handler (default 30 s) also blocks. */
export interface OmpToolCallResult {
  block?: boolean;
  reason?: string;
  /** Replacement execution input; ignored when `block`. */
  input?: Record<string, unknown>;
}

export interface OmpContextEvent {
  type: "context";
  /** Deep copy of the messages about to be sent; safe to modify. */
  messages: unknown[];
}

export interface OmpContextResult {
  messages?: unknown[];
}

/** `CompactionResult` (packages/agent/src/compaction/compaction.ts). */
export interface OmpCompactionResult {
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  preserveData?: Record<string, unknown>;
}

export interface OmpSessionBeforeCompactEvent {
  type: "session_before_compact";
  /** `CompactionPreparation`: messages to summarize, previous summary, file ops, ... */
  preparation: unknown;
  branchEntries: unknown[];
  customInstructions?: string;
  signal: AbortSignal;
}

/** `session_before_compact` result; undefined falls through to native compaction. */
export interface OmpSessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: OmpCompactionResult;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OMP events differ per event name.
export type OmpHandler = (event: any, ctx: OmpContext) => unknown;

/** `ToolDefinition` subset for `registerTool`. */
export interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  /** Registered but not in the initial active set; the extension activates it via setActiveTools. */
  defaultInactive?: boolean;
  /** "essential": sent as a top-level tool. Undeclared extension tools default to "discoverable" (mounted under xdev, not on the wire). */
  loadMode?: "essential" | "discoverable";
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: OmpContext): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }>;
}

export interface OmpCommandOptions {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: OmpContext) => unknown;
}

/**
 * The `pi` object handed to an OMP extension factory. Runtime actions (`getAllTools`,
 * `getActiveTools`, `setActiveTools`, `getCommands`) throw during extension load and work from
 * `session_start` on. `registerTool` / `registerCommand` with a name already taken: the later
 * loader silently wins.
 */
export interface OmpExtensionAPI {
  /** OMP's own module namespace; `VERSION` is the host version string (e.g. "18.3.5"). */
  pi?: { VERSION?: unknown };
  on(event: string, handler: OmpHandler): void;
  registerCommand(name: string, options: OmpCommandOptions): void;
  registerTool?(tool: OmpToolDefinition): void;
  getAllTools(): OmpToolInfo[];
  getActiveTools(): string[];
  getCommands?(): OmpSlashCommandInfo[];
  getThinkingLevel(): unknown;
  /** OMP 18.3.5 returns `Promise<void>`; await it before reading the tool set back (the port does). */
  setActiveTools(names: string[]): unknown;
  /** Inject a custom message; `deliverAs: "steer"` interrupts the running turn (steer). */
  sendMessage?(message: { customType: string; content: string; display?: boolean }, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): unknown;
  // Setters exist on the host; the adapter never calls them (unit tests assert this).
  setModel(model: unknown): unknown;
  setThinkingLevel(level: unknown): unknown;
}
