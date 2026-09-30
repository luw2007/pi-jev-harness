/** T105 L7 (found on real omp): Jev may pick dag/parallel for a one-slice task; jev_plan degrades to single. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runJevPlan } from "../../../../src/adapters/omp/plan.ts";
import type { AuditInput } from "../../../../src/telemetry/audit.ts";

for (const mode of ["dag", "parallel"] as const) {
  test(`one slice + Jev mode ${mode}: plan degrades to single, recorded in result and audit`, async () => {
    const audit: AuditInput[] = [];
    const client = {
      choice: async (questions: Array<{ id: string; options: Array<{ id: string }> }>) => ({
        ok: true as const,
        evidence: questions.map((q) => ({ questionId: q.id, choice: q.id === "mode" ? mode : q.options[0]!.id })),
      }),
      noul: async () => ({ ok: false as const, error: { kind: "network_error" as const } }),
    };
    const result = await runJevPlan({ task: "Fix the bug in add.js" }, undefined, {
      mode: "on", taskIntent: true, secrets: [], client: client as never, maxRequests: 1, waitMs: 1000,
      runId: "run_00000000-0000-4000-8000-000000000000", decisionId: "dec_00000000-0000-4000-8000-000000000000",
      audit: { record: async (input) => { audit.push(input); return true; }, flush: async () => {}, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) },
      now: () => 0,
    });
    assert.ok(!result.isError, JSON.stringify(result));
    const plan = result.details.plan!;
    assert.equal(plan.mode, "single");
    assert.equal(plan.slices.length, 1);
    assert.match(plan.rationale, new RegExp(`${mode}.*single`));
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.outcome, "ok");
    assert.equal(audit[0]!.mode, "single");
    assert.equal((audit[0]!.metrics as { degraded?: boolean }).degraded, true);
  });
}
