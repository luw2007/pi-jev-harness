// Adapted from jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:examples/host/jev-choice.ts (MIT)
/**
 * Bounded Jev HTTP client. One logical call is one physical request, never retried.
 * A single deadline covers connect, headers and body; oversized bodies are cancelled as
 * soon as the limit is crossed; every dispatched request yields exactly one JevAttempt.
 * Results carry categories only, never provider error text.
 */
import type {
  ChoiceEvidence,
  ChoiceQuestion,
  JevAttempt,
  JevAttemptStatus,
  JevError,
  JevProfile,
  JevResult,
  JevState,
  NoulEvidence,
  NoulQuestion,
  WireResult,
} from "./types.ts";
import { choiceBody, noulBody, parseChoiceResponse, parseNoulResponse, validChoiceQuestions, validNoulQuestions } from "./wire.ts";

/** `usage.input_tokens` / `output_tokens` when the provider reports them as non-negative finite numbers. */
function reportedUsage(raw: unknown): { inputTokens?: number; outputTokens?: number } {
  if (raw === null || typeof raw !== "object" || !("usage" in raw)) return {};
  const usage = raw.usage;
  if (usage === null || typeof usage !== "object") return {};
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const input = "input_tokens" in usage ? usage.input_tokens : undefined;
  const output = "output_tokens" in usage ? usage.output_tokens : undefined;
  return { ...(valid(input) ? { inputTokens: input } : {}), ...(valid(output) ? { outputTokens: output } : {}) };
}

export interface JevClientOptions {
  profile: JevProfile;
  /** Bearer key; absent sends no authorization header (keyless internal providers). */
  key: string | undefined;
  fetch: typeof fetch;
  /** Epoch milliseconds; used for attempt `startedAt` and `durationMs`. */
  now: () => number;
  newId: () => string;
  /** Called once per physical request. Throwing cannot change the call result. */
  onAttempt?: (attempt: JevAttempt) => void;
  /** Physical HTTP request and response debug events; observer failures never alter the result. */
  onDebug?: (event: JevDebugEvent) => void;
  /** Optional cheap gate for session switches; a throwing gate disables debug only. */
  debugEnabled?: () => boolean;
}

export interface JevCallOptions {
  decisionId: string;
  /** Caller-owned data to judge. Serialized as-is into `state`. */
  state: JevState;
  signal?: AbortSignal;
}

export interface JevClient {
  choice(questions: readonly ChoiceQuestion[], options: JevCallOptions): Promise<JevResult<ChoiceEvidence[]>>;
  noul(questions: readonly NoulQuestion[], options: JevCallOptions): Promise<JevResult<NoulEvidence[]>>;
}

/** One event per physical HTTP boundary; headers and bearer credentials are never included. */
export type JevDebugEvent =
  | { phase: "req"; attemptId: string; decisionId: string; providerId: string; model: string; url: string; body: string }
  | { phase: "resp"; attemptId: string; decisionId: string; providerId: string; model: string; url: string; httpStatus?: number; durationMs: number; status: JevAttemptStatus; body?: unknown };

/** Strip URL credentials and query strings, and redact the configured bearer key in visible fields. */
function debugUrl(url: string, key: string | undefined): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return key ? parsed.toString().replaceAll(key, "[REDACTED]") : parsed.toString();
  } catch {
    return "[invalid URL]";
  }
}

function debugBody(value: string, key: string | undefined): string {
  return key ? value.replaceAll(key, "[REDACTED]") : value;
}

function debugResponse(raw: unknown, key: string | undefined): unknown {
  try {
    return key ? JSON.parse(debugBody(JSON.stringify(raw), key)) : structuredClone(raw);
  } catch {
    return "[unavailable response]";
  }
}

class BodyLimit extends Error {}
const DEADLINE = Symbol("jev-deadline");

/** Race host I/O against the signal, even when an injected fetch ignores abort. */
async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Streams the body, counting bytes into `read`; cancels the stream on limit, abort or error. */
async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  read: { bytes: number },
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await raceAbort(reader.read(), signal);
      if (chunk.done) break;
      read.bytes += chunk.value.byteLength;
      if (read.bytes > limit) throw new BodyLimit();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Deep copy then deep freeze: the request contract cannot change while a call is in flight. */
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(copy);
  return copy;
}

export function createJevClient(options: JevClientOptions): JevClient {
  const { key, now, newId, onAttempt, onDebug, debugEnabled } = options;
  const profile: Readonly<JevProfile> = snapshot(options.profile);
  const upstreamFetch = options.fetch;
  const visibleUrl = onDebug ? debugUrl(profile.url, key) : "";
  const observe = (event: JevDebugEvent) => {
    try {
      onDebug?.(event);
    } catch {
      // Debug output cannot change the call result.
    }
  };
  const enabled = () => {
    if (!onDebug) return false;
    try {
      return debugEnabled?.() ?? true;
    } catch {
      return false;
    }
  };

  async function send<E>(
    body: string,
    call: JevCallOptions,
    parse: (raw: unknown) => WireResult<E[]>,
  ): Promise<JevResult<E[]>> {
    if (call.signal?.aborted) return { ok: false, error: { kind: "aborted" } };
    const requestBytes = new TextEncoder().encode(body).byteLength;
    if (requestBytes > profile.maxRequestBytes) return { ok: false, error: { kind: "request_too_large" } };

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(DEADLINE), profile.timeoutMs);
    const signal = call.signal ? AbortSignal.any([deadline.signal, call.signal]) : deadline.signal;
    const attemptId = newId();
    const startedAt = now();
    const read = { bytes: 0 };
    let status: JevAttemptStatus;
    let httpStatus: number | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } = {};
    let outcome: { ok: true; evidence: E[] } | { ok: false; error: JevError };
    let responseBody: unknown;
    const tracing = enabled();
    if (tracing) observe({ phase: "req", attemptId: debugBody(attemptId, key), decisionId: debugBody(call.decisionId, key),
      providerId: debugBody(profile.id, key), model: debugBody(profile.model, key), url: visibleUrl, body: debugBody(body, key) });
    try {
      const pending = upstreamFetch(profile.url, {
        method: "POST",
        headers:
          key === undefined
            ? { "content-type": "application/json" }
            : { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal,
      }).then((response) => {
        // Lost the race to abort: release the connection.
        if (signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      });
      const response = await raceAbort(pending, signal);
      httpStatus = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        status = "http_error";
        outcome = { ok: false, error: { kind: "http_error", httpStatus } };
      } else {
        const declared = Number(response.headers.get("content-length") ?? Number.NaN);
        if (Number.isFinite(declared) && declared > profile.maxResponseBytes) {
          void response.body?.cancel().catch(() => {});
          throw new BodyLimit();
        }
        const text = await readBoundedBody(response.body, profile.maxResponseBytes, signal, read);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          raw = undefined;
        }
        const parsed = raw === undefined ? null : parse(raw);
        if (tracing && raw !== undefined) responseBody = debugResponse(raw, key);
        if (parsed?.ok) {
          status = "ok";
          outcome = { ok: true, evidence: parsed.value };
          usage = reportedUsage(raw);
        } else {
          status = "malformed";
          outcome = { ok: false, error: parsed ? { kind: "malformed", wire: parsed.error } : { kind: "malformed" } };
        }
      }
    } catch (error) {
      const failure = signal.aborted
        ? signal.reason === DEADLINE ? "timeout" : "aborted"
        : error instanceof BodyLimit ? "too_large" : "network_error";
      status = failure;
      outcome = { ok: false, error: httpStatus === undefined ? { kind: failure } : { kind: failure, httpStatus } };
    } finally {
      clearTimeout(timer);
    }

    const attempt: JevAttempt = {
      attemptId,
      decisionId: call.decisionId,
      startedAt,
      durationMs: now() - startedAt,
      status,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      requestBytes,
      ...usage,
      responseBytes: read.bytes,
    };
    if (tracing) observe({ phase: "resp", attemptId: debugBody(attemptId, key), decisionId: debugBody(call.decisionId, key),
      providerId: debugBody(profile.id, key), model: debugBody(profile.model, key), url: visibleUrl,
      durationMs: attempt.durationMs, status, ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(responseBody === undefined ? {} : { body: responseBody }) });
    try {
      onAttempt?.({ ...attempt });
    } catch {
      // Metering cannot change the call result.
    }
    return outcome.ok ? { ok: true, evidence: outcome.evidence, attempt } : { ok: false, error: outcome.error, attempt };
  }

  return {
    choice(input, options) {
      const questions = snapshot(input);
      const call = { decisionId: snapshot(options.decisionId), state: snapshot(options.state), signal: options.signal };
      if (!validChoiceQuestions(questions)) return Promise.resolve({ ok: false, error: { kind: "invalid_request" } });
      return send(choiceBody(profile.model, call.state, questions), call, (raw) =>
        parseChoiceResponse(raw, questions, profile.model, profile.identity),
      );
    },
    noul(input, options) {
      const questions = snapshot(input);
      const call = { decisionId: snapshot(options.decisionId), state: snapshot(options.state), signal: options.signal };
      if (!validNoulQuestions(questions)) return Promise.resolve({ ok: false, error: { kind: "invalid_request" } });
      return send(noulBody(profile.model, call.state, questions), call, (raw) =>
        parseNoulResponse(raw, questions, profile.model, profile.identity),
      );
    },
  };
}
