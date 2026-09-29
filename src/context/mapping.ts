// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:src/map.ts (MIT)
// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:src/vendor/fast-jev/state.ts (MIT)
//
// Lossless view of Pi session messages for the context module. Unlike C's `mapOmpMessages`,
// nothing is flattened into the output: every ContextMessage keeps the original host message
// object, and the derived fields (text, tool pairing, reducibility) are read-only annotations.
// Pure: no environment, clock, network or file system.

/**
 * Any Pi `AgentMessage` (system, user, assistant, toolResult, bashExecution, custom, summaries,
 * or a custom role added by declaration merging). Declared structurally so the context module
 * does not import host types; unknown fields and roles pass through untouched.
 */
export type PiMessage = { readonly role: string };

/** Why a tool result (and its call) may or may not be reduced. Only `text_only` is reducible. */
export type ReducibleReason =
  | "text_only"
  | "malformed"
  | "unpaired_call"
  | "unpaired_result"
  | "duplicate_id"
  | "error"
  | "has_image"
  | "unknown_block"
  | "not_text_only"
  | "recent";

/** One `toolCall` block of an assistant message. */
export interface ContextToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  /** Session index of the paired toolResult message; undefined when unpaired or ambiguous. */
  readonly resultIndex: number | undefined;
  /** Mirrors the paired result; a call without a unique result is never reducible. */
  readonly reducible: boolean;
  readonly reason: ReducibleReason;
}

/** Annotation of a `toolResult` message. */
export interface ContextToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  /** Text blocks joined by "\n", for scoring only. Never written back. */
  readonly text: string;
  /** Session index of the assistant message holding the paired call; undefined when unpaired. */
  readonly callIndex: number | undefined;
  readonly reducible: boolean;
  readonly reason: ReducibleReason;
}

export interface ContextMessage {
  /** Position in the whole session passed to `toContextMessages`, not in any later window. */
  readonly index: number;
  readonly role: string;
  /** Plain-text view for scoring (thinking, images and unknown blocks excluded). */
  readonly text: string;
  /** `toolCall` blocks of an assistant message, in order; empty for other roles. */
  readonly toolCalls: readonly ContextToolCall[];
  /** Present only on `toolResult` messages. */
  readonly toolResult?: ContextToolResult;
  /** Inside the recent window computed over the whole session. */
  readonly recent: boolean;
  /** The original host message, unchanged. `fromContextMessages` returns exactly this. */
  readonly message: PiMessage;
}

export interface MappingOptions {
  /** Newest assistant turns whose tool results are never reducible. Default 3. */
  recentTurns?: number;
}

export interface GoalOptions {
  /** Later user instructions appended after the first one, newest last. Default 2. */
  maxFollowUps?: number;
  /** Per-instruction character cap. Default 500. */
  maxChars?: number;
}

export const DEFAULT_RECENT_TURNS = 3;

type Block = { readonly type?: unknown; readonly [key: string]: unknown };

function field(message: PiMessage, key: string): unknown {
  return (message as unknown as Record<string, unknown>)[key];
}

function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Block => isBlock(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function messageText(message: PiMessage): string {
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
    case "system":
      return textOf(field(message, "content"));
    case "branchSummary":
    case "compactionSummary": {
      const summary = field(message, "summary");
      return typeof summary === "string" ? summary : "";
    }
    case "bashExecution": {
      const command = field(message, "command");
      const output = field(message, "output");
      return `${typeof command === "string" ? `$ ${command}` : ""}\n${typeof output === "string" ? output : ""}`.trim();
    }
    default:
      return "";
  }
}

function assertTurns(recentTurns: number): void {
  if (!Number.isInteger(recentTurns) || recentTurns < 0) {
    throw new RangeError(`recentTurns must be a non-negative integer, got ${recentTurns}`);
  }
}

/**
 * Session index where the recent window starts: the `recentTurns`-th newest assistant message
 * (one assistant message plus its tool results is one Pi turn). Computed over the messages
 * given, so pass the whole session, not a window. 0 when the session has fewer turns;
 * `messages.length` when `recentTurns` is 0.
 */
export function recentWindow(messages: readonly PiMessage[], recentTurns: number = DEFAULT_RECENT_TURNS): number {
  assertTurns(recentTurns);
  if (recentTurns === 0) return messages.length;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant" && ++seen === recentTurns) return index;
  }
  return 0;
}

interface CallBlock {
  id: string;
  name: string;
  arguments: unknown;
}

function callBlocks(message: PiMessage): CallBlock[] {
  if (message.role !== "assistant") return [];
  const content = field(message, "content");
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is Block => isBlock(block) && block.type === "toolCall" && typeof block.id === "string")
    .map((block) => ({
      id: block.id as string,
      name: typeof block.name === "string" ? block.name : "",
      arguments: block.arguments,
    }));
}

/** Content-level verdict for a tool result, before pairing and recency. */
function contentReason(message: PiMessage): ReducibleReason {
  const content = field(message, "content");
  if (!Array.isArray(content)) return "malformed";
  if (field(message, "isError") === true) return "error";
  let reason: ReducibleReason = "text_only";
  for (const block of content) {
    if (!isBlock(block) || typeof block.type !== "string") return "unknown_block";
    if (block.type === "image") {
      reason = "has_image";
      continue;
    }
    if (block.type !== "text") return "unknown_block";
    // A text block carrying anything beyond `text` (e.g. textSignature) cannot be rewritten safely.
    const plain = typeof block.text === "string" && Object.keys(block).every((key) => key === "type" || key === "text");
    if (!plain && reason === "text_only") reason = "not_text_only";
  }
  return reason;
}

/**
 * Maps Pi messages to context messages. Each output holds the original message object; the
 * input is never mutated. Pass the whole session so indexes, pairing and the recent window
 * are global.
 */
export function toContextMessages(piMessages: readonly PiMessage[], options: MappingOptions = {}): ContextMessage[] {
  const recentTurns = options.recentTurns ?? DEFAULT_RECENT_TURNS;
  const windowStart = recentWindow(piMessages, recentTurns);

  const callsById = new Map<string, number[]>();
  const resultsById = new Map<string, number[]>();
  const calls = piMessages.map(callBlocks);
  calls.forEach((blocks, index) => {
    for (const block of blocks) callsById.set(block.id, [...(callsById.get(block.id) ?? []), index]);
  });
  piMessages.forEach((message, index) => {
    const id = message.role === "toolResult" ? field(message, "toolCallId") : undefined;
    if (typeof id === "string") resultsById.set(id, [...(resultsById.get(id) ?? []), index]);
  });

  const results = new Map<number, ContextToolResult>();
  piMessages.forEach((message, index) => {
    if (message.role !== "toolResult") return;
    const rawId = field(message, "toolCallId");
    const rawName = field(message, "toolName");
    const toolCallId = typeof rawId === "string" ? rawId : "";
    const callIdx = callsById.get(toolCallId) ?? [];
    const resultIdx = resultsById.get(toolCallId) ?? [];
    const paired = callIdx.length === 1 && resultIdx.length === 1 && (callIdx[0] as number) < index;
    const callIndex = paired ? callIdx[0] : undefined;

    let reason: ReducibleReason;
    if (typeof rawId !== "string") reason = "malformed";
    else if (callIdx.length > 1 || resultIdx.length > 1) reason = "duplicate_id";
    else if (!paired) reason = "unpaired_result";
    else reason = contentReason(message);
    if (reason === "text_only" && (index >= windowStart || (callIndex as number) >= windowStart)) reason = "recent";

    results.set(index, {
      toolCallId,
      toolName: typeof rawName === "string" ? rawName : "",
      isError: field(message, "isError") === true,
      text: textOf(field(message, "content")),
      callIndex,
      reducible: reason === "text_only",
      reason,
    });
  });

  return piMessages.map((message, index) => {
    const toolCalls = (calls[index] ?? []).map((block): ContextToolCall => {
      const resultIdx = resultsById.get(block.id) ?? [];
      const result = resultIdx.length === 1 ? results.get(resultIdx[0] as number) : undefined;
      if (result?.callIndex === index) {
        return { ...block, resultIndex: resultIdx[0], reducible: result.reducible, reason: result.reason };
      }
      const duplicate = (callsById.get(block.id)?.length ?? 0) > 1 || resultIdx.length > 1;
      return { ...block, resultIndex: undefined, reducible: false, reason: duplicate ? "duplicate_id" : "unpaired_call" };
    });
    const toolResult = results.get(index);
    return {
      index,
      role: message.role,
      text: messageText(message),
      toolCalls,
      ...(toolResult ? { toolResult } : {}),
      recent: index >= windowStart,
      message,
    };
  });
}

/** Inverse of `toContextMessages`: the original host messages, in order. */
export function fromContextMessages(ctxMessages: readonly ContextMessage[]): PiMessage[] {
  return ctxMessages.map((ctx) => ctx.message);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Global task goal: the first user instruction of the session, then the newest `maxFollowUps`
 * later ones. Pass the whole session (not a window) so the opening instruction is never lost.
 * Only `user` messages with non-blank text count; C used the last 3 user prompts only.
 */
export function goalFromMessages(messages: readonly ContextMessage[], options: GoalOptions = {}): string {
  const maxFollowUps = options.maxFollowUps ?? 2;
  const maxChars = options.maxChars ?? 500;
  const instructions = messages.filter((ctx) => ctx.role === "user" && ctx.text.trim().length > 0);
  if (instructions.length === 0) return "";
  const [first, ...rest] = instructions;
  const followUps = maxFollowUps > 0 ? rest.slice(-maxFollowUps) : [];
  return [first as ContextMessage, ...followUps].map((ctx) => truncate(ctx.text, maxChars)).join("\n");
}
