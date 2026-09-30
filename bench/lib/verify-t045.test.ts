/** Verifier checks: bench outcome classification against the T043/T044/T045 `pi-jev run --json` shape. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomeOf, type ProcResult } from "./runner.ts";

const proc = (exit: number | null): ProcResult => ({ exit, stdout: "", stderr: "", timedOut: false, error: null });

test("T045: native_off with report:null classifies as native_off", () => {
  assert.equal(outcomeOf(proc(2), { status: "native_off", timedOut: false, sessionError: null }, null), "native_off");
});

test("T045: run.json status cancelled (Ctrl-C record) classifies as cancelled", () => {
  assert.equal(outcomeOf(proc(2), { status: "cancelled", timedOut: false, sessionError: null }, "cancelled"), "cancelled");
});

test("T045 DEFECT: CLI status cancelled (SIGINT abort, run.json says completed) must not be completed", () => {
  // `pi-jev run` overrides run.json `completed` to `cancelled` when the session was interrupted.
  const result = { status: "cancelled", timedOut: false, sessionError: null, interrupted: "SIGINT" } as const;
  assert.equal(outcomeOf(proc(2), result, "completed"), "cancelled");
});
