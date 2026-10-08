import type { JevDebugEvent } from "../../jev/index.ts";

function extractInputTokens(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("usage" in body)) return undefined;
  const usage = body.usage;
  if (typeof usage !== "object" || usage === null || !("input_tokens" in usage)) return undefined;
  const tokens = usage.input_tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
}

/** One physical terminal row; payloads remain available only in the expanded TUI entry. */
export function formatJevDebugCompact(event: JevDebugEvent): string {
  const safe = (value: string) => value.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ");
  const identity = `${safe(event.providerId)} · ${safe(event.model)}`;
  const ids = `decision ${safe(event.decisionId)} · attempt ${safe(event.attemptId)}`;
  if (event.phase === "req") return `◇ Jev REQ · ${identity} · ${ids} · sending`;
  const status = event.httpStatus === undefined ? safe(event.status) : `${safe(event.status)} · HTTP ${event.httpStatus}`;
  const inputTokens = extractInputTokens(event.body);
  const tokens = inputTokens === undefined ? "" : ` · input tokens ${inputTokens}`;
  return `◆ Jev RESP · ${identity} · ${ids} · ${status} · ${event.durationMs} ms${tokens}`;
}

export interface JevDebugDetails {
  summary: string;
  expanded: string;
}

export function jevDebugDetails(event: JevDebugEvent): JevDebugDetails {
  return { summary: formatJevDebugCompact(event), expanded: formatJevDebug(event) };
}

/** Return exactly one terminal row while collapsed, irrespective of long provider/model names. */
export function renderJevDebug(details: JevDebugDetails, expanded: boolean): { render(width: number): string[]; invalidate(): void } {
  return {
    render(width) {
      if (expanded) return details.expanded.split("\n");
      // The compact formatter already removes control characters; use terminal cells, not UTF-16 units.
      const chars = Array.from(details.summary);
      let cells = 0;
      let end = 0;
      for (const ch of chars) {
        const code = ch.codePointAt(0)!;
        const wide = code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a ||
          code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
          code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
          code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300);
        if (cells + (wide ? 2 : 1) > width) break;
        cells += wide ? 2 : 1;
        end++;
      }
      return [chars.slice(0, end).join("")];
    },
    invalidate() {},
  };
}

/** Human-readable, session-local Jev wire trace; never includes request headers. */
export function formatJevDebug(event: JevDebugEvent): string {
  const identity = `${event.providerId} · ${event.model} · ${event.url}`;
  const ids = `decision ${event.decisionId} · attempt ${event.attemptId}`;

  if (event.phase === "req") {
    let body = event.body;
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Preserve the original payload if it is not JSON.
    }
    return `◇ Jev request · ${ids}\n${identity}\n${body}`;
  }

  const result = event.httpStatus === undefined ? event.status : `${event.status} · HTTP ${event.httpStatus}`;
  const header = `◆ Jev response · ${ids}\n${identity}\n${result} · ${event.durationMs} ms`;
  return event.body === undefined ? header : `${header}\n${JSON.stringify(event.body, null, 2)}`;
}
