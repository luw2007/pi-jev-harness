/** T105 L7 verification (verifier-owned): new audit lines survive the real sanitizer (AUDIT_SCHEMA). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeAudit } from "../../../src/telemetry/audit.ts";

const ID = "dec_00000000-0000-4000-8000-000000000000";

test("jev_plan `degraded` metric is kept by the sanitizer", () => {
  const r = sanitizeAudit({ kind: "route", event: "jev_plan", outcome: "ok", mode: "single", decisionId: ID, metrics: { requests: 1, slices: 1, degraded: true } }, 0);
  assert.equal((r?.metrics as { degraded?: boolean } | undefined)?.degraded, true);
});

test("every stop outcome the adapter writes (continued/allowed/skipped) in on/shadow is a valid line with continuation counts", () => {
  for (const mode of ["on", "shadow"]) for (const outcome of ["continued", "allowed", "skipped"]) {
    const r = sanitizeAudit({ kind: "stop", event: "settle", outcome, mode, durationMs: 3, decisionId: ID, metrics: { continues: 1, maxContinues: 2 } }, 0);
    assert.ok(r, `${mode}/${outcome}`);
    assert.deepEqual(r.metrics, { continues: 1, maxContinues: 2 });
  }
});

test("every approval outcome the adapter maps to (approved/denied/timeout/skipped/ok/failed) is a valid line", () => {
  for (const mode of ["on", "shadow"]) for (const outcome of ["approved", "denied", "timeout", "skipped", "ok", "failed"]) {
    assert.ok(sanitizeAudit({ kind: "approval", event: "tool_call", outcome, mode, decisionId: ID }, 0), `${mode}/${outcome}`);
  }
});
