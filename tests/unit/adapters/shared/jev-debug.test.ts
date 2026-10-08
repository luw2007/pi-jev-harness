import assert from "node:assert/strict";
import { test } from "node:test";
import { formatJevDebugCompact, jevDebugDetails, renderJevDebug } from "../../../../src/adapters/shared/jev-debug.ts";
import type { JevDebugEvent } from "../../../../src/jev/index.ts";

test("physical Jev events keep payloads out of collapsed summaries and stderr fallback", () => {
  const req: JevDebugEvent = { phase: "req", providerId: "provider\nunsafe", model: "judge", url: "https://jev.test/v1",
    decisionId: "dec-1", attemptId: "att-1", body: '{"state":{"task":"secret task"}}' };
  const resp: JevDebugEvent = { phase: "resp", providerId: "provider", model: "judge", url: "https://jev.test/v1",
    decisionId: "dec-1", attemptId: "att-1", status: "ok", httpStatus: 200, durationMs: 42, body: { answers: { route: "yes" }, usage: { input_tokens: 42 } } };
  const request = jevDebugDetails(req);
  const response = jevDebugDetails(resp);
  assert.equal(request.summary, formatJevDebugCompact(req));
  assert.match(request.summary, /REQ.*provider.*judge.*sending/);
  assert.match(response.summary, /RESP.*provider.*judge.*ok.*HTTP 200.*42 ms/);
  assert.match(response.summary, /input tokens 42/);
  for (const details of [request, response]) {
    assert.equal(details.summary.includes("\n"), false);
    assert.equal(details.summary.includes("\r"), false);
    assert.equal(details.summary.includes("secret task"), false);
    assert.equal(details.summary.includes("answers"), false);
    assert.equal(renderJevDebug(details, false).render(20).length, 1, "narrow terminals never wrap collapsed entries");
  }
  assert.match(renderJevDebug(request, true).render(200).join("\n"), /"task": "secret task"/);
  assert.match(renderJevDebug(response, true).render(200).join("\n"), /"answers": \{/);
});

test("formatJevDebugCompact omits input tokens when usage is missing or invalid", () => {
  const baseResp: JevDebugEvent = {
    phase: "resp",
    providerId: "provider",
    model: "judge",
    url: "https://jev.test/v1",
    decisionId: "dec-1",
    attemptId: "att-1",
    status: "ok",
    httpStatus: 200,
    durationMs: 42,
  };
  assert.equal(formatJevDebugCompact(baseResp).includes("input tokens"), false);
  assert.equal(formatJevDebugCompact({ ...baseResp, body: null }).includes("input tokens"), false);
  assert.equal(formatJevDebugCompact({ ...baseResp, body: { usage: { input_tokens: -1 } } }).includes("input tokens"), false);
  assert.equal(formatJevDebugCompact({ ...baseResp, body: { usage: { input_tokens: "42" } } }).includes("input tokens"), false);
  assert.equal(formatJevDebugCompact({ ...baseResp, body: { usage: { input_tokens: Number.NaN } } }).includes("input tokens"), false);
  assert.equal(formatJevDebugCompact({ ...baseResp, body: { usage: { input_tokens: Number.POSITIVE_INFINITY } } }).includes("input tokens"), false);
  assert.equal(formatJevDebugCompact({ ...baseResp, body: { usage: { input_tokens: 0 } } }).includes("input tokens 0"), true);
});
