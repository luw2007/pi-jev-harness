import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../../vendor/jev-harness/src/audit/receipt.ts";
import { outputDigest, recordToolResult } from "../../../src/harness/evidence.ts";
import {
  createRuntimeReceipt,
  REPLAY_INTEGRITY_NOTE,
  REPLAY_UNCHECKED_NOTES,
  replayReceipt,
  type RuntimeReceiptInput,
  type SealedRuntimeReceipt,
  type TrustedCurrent,
} from "../../../src/harness/receipt.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const OUTPUT = "tests passed";

function sample(): { input: RuntimeReceiptInput; current: TrustedCurrent } {
  const { evidence } = recordToolResult({ actionId: "act-1", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: OUTPUT }], startedAt: 10, endedAt: 20 });
  const input: RuntimeReceiptInput = {
    runId: "run-1",
    sessionId: "sess-1",
    branchId: "br-1",
    generation: 3,
    actionId: "act-1",
    snapshot: { digest: sha("snapshot"), version: "host-snapshot-v1" },
    request: { digest: sha("request"), version: "host-action-v1" },
    response: { digest: sha("response"), version: "jev-response-v1" },
    authorizationRef: "grant-1",
    execution: { status: "executed", reason: null, evidence: [evidence] },
    verification: { status: "passed", evidenceRefs: ["call-1"], note: null },
    usage: { inputTokens: 120, outputTokens: 7 },
  };
  const current: TrustedCurrent = {
    runId: "run-1", sessionId: "sess-1", branchId: "br-1", generation: 3, actionId: "act-1",
    snapshot: { digest: sha("snapshot"), version: "host-snapshot-v1" },
    request: { digest: sha("request"), version: "host-action-v1" },
    response: { digest: sha("response"), version: "jev-response-v1" },
    authorizationRef: "grant-1",
    outputs: { "call-1": outputDigest([{ type: "text", text: OUTPUT }]) },
  };
  return { input, current };
}

test("receipt digest is sha256 over H canonicalJson and replays as match", () => {
  const { input, current } = sample();
  const sealed = createRuntimeReceipt(input);
  assert.equal(sealed.integrity.digest, sha(canonicalJson(sealed.receipt)));
  assert.equal(sealed.receipt.schemaVersion, 1);
  assert.equal(Object.hasOwn(sealed.receipt, "arm"), false);
  assert.equal(Object.hasOwn(sealed.receipt.execution, "applied"), false);
  const unchecked = { status: "match", notes: [REPLAY_INTEGRITY_NOTE, REPLAY_UNCHECKED_NOTES.both] };
  assert.deepEqual(replayReceipt(JSON.parse(canonicalJson(sealed)), current), unchecked);
  assert.deepEqual(replayReceipt(canonicalJson(sealed), current), unchecked);
  const checked = { ...current, execution: { status: "executed" as const }, verification: { status: "passed" as const } };
  assert.deepEqual(replayReceipt(sealed, checked), { status: "match", notes: [REPLAY_INTEGRITY_NOTE] });
  assert.deepEqual(replayReceipt(sealed, { ...current, verification: { status: "passed" } }).notes, [REPLAY_INTEGRITY_NOTE, REPLAY_UNCHECKED_NOTES.execution]);
});

test("usage: missing entirely is null; missing fields are null, never zero", () => {
  const { input } = sample();
  assert.equal(createRuntimeReceipt({ ...input, usage: undefined }).receipt.usage, null);
  assert.equal(createRuntimeReceipt({ ...input, usage: null }).receipt.usage, null);
  assert.deepEqual(createRuntimeReceipt(input).receipt.usage, { inputTokens: 120, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null });
  assert.deepEqual(createRuntimeReceipt({ ...input, usage: { inputTokens: Number.NaN, costUsd: -1 } }).receipt.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null });
});

test("changing any single byte of the stored receipt makes replay report mismatch", () => {
  const { input, current } = sample();
  const line = canonicalJson(createRuntimeReceipt(input));
  let checked = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    const flipped = code === 0x61 ? "b" : code === 0x31 ? "2" : null; // 'a' → 'b', '1' → '2'
    if (flipped === null) continue;
    const tampered = line.slice(0, i) + flipped + line.slice(i + 1);
    const result = replayReceipt(tampered, current);
    assert.equal(result.status, "mismatch", `byte ${i} tampered: ${tampered.slice(Math.max(0, i - 20), i + 20)}`);
    checked++;
  }
  assert.ok(checked > 50);
});

test("current state differing from the recorded binding is a mismatch, not trusted from the receipt", () => {
  const { input, current } = sample();
  const sealed = createRuntimeReceipt(input);
  const stale = replayReceipt(sealed, { ...current, generation: 4 });
  assert.equal(stale.status, "mismatch");
  const changedOutput = replayReceipt(sealed, { ...current, outputs: { "call-1": sha("other") } });
  assert.equal(changedOutput.status, "mismatch");
  const unexpectedRequest = replayReceipt(createRuntimeReceipt({ ...input, request: null }), current);
  assert.equal(unexpectedRequest.status, "mismatch");
});

test("current state missing a bound field returns cannot_verify naming it", () => {
  const { input, current } = sample();
  const sealed = createRuntimeReceipt(input);
  const { snapshot: _s, outputs: _o, ...partial } = current;
  assert.deepEqual(replayReceipt(sealed, partial), {
    status: "cannot_verify",
    missing: ["snapshot", "outputs.call-1"],
    notes: [REPLAY_INTEGRITY_NOTE, REPLAY_UNCHECKED_NOTES.both],
  });
  assert.deepEqual(replayReceipt(sealed, {}).status, "cannot_verify");
});

test("replay never invokes execution: host executor spies stay at zero calls", () => {
  const { input, current } = sample();
  const sealed = createRuntimeReceipt(input);
  const calls: string[] = [];
  const host = {
    ...current,
    execute: () => calls.push("execute"),
    runTool: () => calls.push("runTool"),
    exec: () => calls.push("exec"),
  };
  assert.equal(replayReceipt(sealed, host).status, "match");
  assert.equal(replayReceipt(sealed, { ...host, generation: 9 }).status, "mismatch");
  const { snapshot: _s, ...partialHost } = host;
  assert.equal(replayReceipt(sealed, partialHost).status, "cannot_verify");
  assert.equal(calls.length, 0);
});

test("execution status must agree with its evidence", () => {
  const { input } = sample();
  const failed = recordToolResult({ actionId: "act-1", toolCallId: "call-2", toolName: "bash", isError: true, content: "x\n\nCommand exited with code 1", startedAt: 0, endedAt: 1 }).evidence;
  assert.throws(() => createRuntimeReceipt({ ...input, execution: { status: "executed", reason: null, evidence: [failed] }, verification: undefined }), /only successful/);
  assert.throws(() => createRuntimeReceipt({ ...input, execution: { status: "blocked", reason: null, evidence: [] }, verification: undefined }), /needs a reason/);
  const ok = createRuntimeReceipt({ ...input, execution: { status: "failed", reason: "tests failed", evidence: [failed] }, verification: { status: "failed", evidenceRefs: ["call-2"], note: null } });
  assert.equal(ok.receipt.execution.status, "failed");
  assert.throws(() => createRuntimeReceipt({ ...input, actionId: "act-2" }), /another action/);
});

test("tampered execution/verification with a recomputed sha256 is a mismatch once trusted summaries are given", () => {
  const { input, current } = sample();
  const sealed = createRuntimeReceipt(input);
  const resealed = (receipt: SealedRuntimeReceipt["receipt"]): SealedRuntimeReceipt => ({
    receipt,
    integrity: { algorithm: "sha256", digest: sha(canonicalJson(receipt)) },
  });
  // Executed → not_requested with evidence dropped, passed → not_run: self-consistent after resealing.
  const forged = resealed({
    ...sealed.receipt,
    execution: { status: "not_requested", reason: null, evidence: [] },
    verification: { status: "not_run", evidenceRefs: [], note: null },
  });
  const trusted = { ...current, execution: { status: "executed" as const }, verification: { status: "passed" as const } };
  const withTrusted = replayReceipt(forged, trusted);
  assert.equal(withTrusted.status, "mismatch");
  assert.deepEqual(withTrusted.status === "mismatch" && withTrusted.reasons, [
    "execution status differs from the trusted current state.",
    "verification status differs from the trusted current state.",
  ]);
  assert.deepEqual(withTrusted.notes, [REPLAY_INTEGRITY_NOTE]);
  // Without trusted summaries the forgery is only integrity-consistent, and replay says so.
  const without = replayReceipt(forged, current);
  assert.deepEqual(without, { status: "match", notes: [REPLAY_INTEGRITY_NOTE, REPLAY_UNCHECKED_NOTES.both] });
});
