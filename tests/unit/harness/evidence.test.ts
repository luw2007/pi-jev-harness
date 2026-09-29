import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EvidenceLedger, outputDigest, recordToolResult, summarizeChangeset } from "../../../src/harness/evidence.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const text = (t: string) => [{ type: "text", text: t }];
const base = { actionId: "act-1", toolCallId: "call-1", toolName: "bash", startedAt: 1_000, endedAt: 1_250 };

test("parallel results arriving out of order bind to their own action by toolCallId", () => {
  const ledger = new EvidenceLedger();
  ledger.expect("call-a", "act-A");
  ledger.expect("call-b", "act-B");
  ledger.expect("call-c", "act-A");
  for (const id of ["call-c", "call-b", "call-a"])
    ledger.accept({ toolCallId: id, toolName: "read", isError: false, content: text(`out ${id}`), startedAt: 0, endedAt: 1 });
  assert.deepEqual(ledger.forAction("act-A").map((e) => [e.toolCallId, e.actionId, e.output.sha256]), [
    ["call-a", "act-A", outputDigest(text("out call-a"))],
    ["call-c", "act-A", outputDigest(text("out call-c"))],
  ]);
  assert.deepEqual(ledger.forAction("act-B").map((e) => [e.toolCallId, e.actionId]), [["call-b", "act-B"]]);
  assert.deepEqual(ledger.pending(), []);
});

test("ledger rejects unknown, duplicate, and rebound tool calls", () => {
  const ledger = new EvidenceLedger();
  ledger.expect("call-a", "act-A");
  const result = { toolCallId: "call-a", toolName: "read", isError: false, content: text("x"), startedAt: 0, endedAt: 1 };
  assert.throws(() => ledger.accept({ ...result, toolCallId: "call-x" }), /Unknown toolCallId/);
  assert.throws(() => ledger.expect("call-a", "act-B"), /already bound/);
  ledger.accept(result);
  assert.throws(() => ledger.accept(result), /Duplicate result/);
});

test("failed command records error outcome and the reported exit code", () => {
  const { evidence } = recordToolResult({ ...base, isError: true, content: text("boom\n\nCommand exited with code 2") });
  assert.equal(evidence.outcome, "error");
  assert.equal(evidence.exitCode, 2);
  assert.equal(evidence.durationMs, 250);
});

test("timeout and cancellation are recorded as such, not as generic errors", () => {
  const timeout = recordToolResult({ ...base, isError: true, content: text("partial\n\nCommand timed out after 30 seconds") }).evidence;
  assert.equal(timeout.outcome, "timeout");
  assert.equal(timeout.exitCode, null);
  const aborted = recordToolResult({ ...base, isError: true, content: text("Command aborted") }).evidence;
  assert.equal(aborted.outcome, "cancelled");
  const declared = recordToolResult({ ...base, toolName: "custom", isError: true, content: text("x"), details: { timedOut: true, exitCode: 124 } }).evidence;
  assert.deepEqual([declared.outcome, declared.exitCode], ["timeout", 124]);
  const plain = recordToolResult({ ...base, toolName: "edit", isError: true, content: text("old text not found") }).evidence;
  assert.deepEqual([plain.outcome, plain.exitCode], ["error", null]);
});

test("successful bash has exit code 0; other successful tools report none", () => {
  assert.equal(recordToolResult({ ...base, isError: false, content: text("ok") }).evidence.exitCode, 0);
  assert.equal(recordToolResult({ ...base, toolName: "read", isError: false, content: text("ok") }).evidence.exitCode, null);
});

test("isError:false contradicted by details is recorded conservatively and flagged as a conflict", () => {
  const exit1 = recordToolResult({ ...base, isError: false, content: text("ok?"), details: { exitCode: 1 } }).evidence;
  assert.deepEqual([exit1.outcome, exit1.exitCode, exit1.conflict], ["error", 1, true]);
  const timedOut = recordToolResult({ ...base, isError: false, content: text("ok?"), details: { timedOut: true } }).evidence;
  assert.deepEqual([timedOut.outcome, timedOut.conflict], ["timeout", true]);
  const cancelled = recordToolResult({ ...base, isError: false, content: text("ok?"), details: { cancelled: true } }).evidence;
  assert.deepEqual([cancelled.outcome, cancelled.conflict], ["cancelled", true]);
  const aborted = recordToolResult({ ...base, toolName: "custom", isError: false, content: text("ok?"), details: { aborted: true } }).evidence;
  assert.deepEqual([aborted.outcome, aborted.conflict], ["cancelled", true]);
  const errorExit0 = recordToolResult({ ...base, isError: true, content: text("x"), details: { exitCode: 0 } }).evidence;
  assert.deepEqual([errorExit0.outcome, errorExit0.conflict], ["error", true]);
  const consistent = recordToolResult({ ...base, isError: false, content: text("ok"), details: { exitCode: 0 } }).evidence;
  assert.deepEqual([consistent.outcome, Object.hasOwn(consistent, "conflict")], ["ok", false]);
});

test("output summary: digest covers every block; byte count covers the full text; head keeps the first N lines", () => {
  const full = Array.from({ length: 30 }, (_, i) => `línea ${i}`).join("\n");
  const content = [...text(full), { type: "image", data: "AAAA", mimeType: "image/png" }];
  const { evidence, artifact } = recordToolResult({ ...base, isError: false, content });
  assert.equal(evidence.output.sha256, outputDigest(content));
  assert.deepEqual(evidence.output.blocks, [
    { type: "text", mimeType: null, sha256: sha(full), bytes: Buffer.byteLength(full, "utf8") },
    { type: "image", mimeType: "image/png", sha256: sha("AAAA"), bytes: 4 },
  ]);
  assert.equal(evidence.output.bytes, Buffer.byteLength(full, "utf8"));
  assert.equal(evidence.output.lines, 30);
  assert.equal(evidence.output.head.length, 20);
  assert.equal(evidence.output.head[19], "línea 19");
  assert.equal(evidence.output.headTruncated, true);
  assert.equal(evidence.output.nonTextBlocks, 1);
  assert.equal(evidence.artifactRef, null);
  assert.equal(artifact, null);

  const short = recordToolResult({ ...base, isError: false, content: text(full) }, { summaryLines: 3, artifacts: "full" });
  assert.deepEqual(short.evidence.output.head, ["línea 0", "línea 1", "línea 2"]);
  assert.equal(short.evidence.artifactRef, `artifacts/${outputDigest(text(full))}.txt`);
  assert.deepEqual(short.artifact, { ref: `artifacts/${outputDigest(text(full))}.txt`, text: full });
});

test("two different images with the same text and block count get different output digests", () => {
  const withImage = (data: string, mimeType = "image/png") => [...text("screenshot"), { type: "image", data, mimeType }];
  const a = recordToolResult({ ...base, isError: false, content: withImage("iVBORw0KGgoAAAA") }).evidence.output;
  const b = recordToolResult({ ...base, isError: false, content: withImage("iVBORw0KGgoBBBB") }).evidence.output;
  assert.deepEqual([a.bytes, a.lines, a.nonTextBlocks, a.head], [b.bytes, b.lines, b.nonTextBlocks, b.head]);
  assert.notEqual(a.sha256, b.sha256);
  const jpeg = recordToolResult({ ...base, isError: false, content: withImage("iVBORw0KGgoAAAA", "image/jpeg") }).evidence.output;
  assert.notEqual(a.sha256, jpeg.sha256);
});

test("malformed host input is rejected", () => {
  assert.throws(() => recordToolResult({ ...base, isError: false, content: text("x"), endedAt: 999 }), /precedes/);
  assert.throws(() => recordToolResult({ ...base, toolCallId: "", isError: false, content: text("x") }), /toolCallId/);
  assert.throws(() => recordToolResult({ ...base, isError: false, content: text("x") }, { summaryLines: -1 }), /summaryLines/);
});

test("summarizeChangeset lists added, modified, and deleted files and omits unchanged", () => {
  const [a, b, c] = [sha("a"), sha("b"), sha("c")];
  assert.deepEqual(summarizeChangeset({ "keep.ts": a, "mod.ts": a, "gone.ts": b }, { "keep.ts": a, "mod.ts": c, "new.ts": b }), [
    { path: "gone.ts", change: "deleted", before: b, after: null },
    { path: "mod.ts", change: "modified", before: a, after: c },
    { path: "new.ts", change: "added", before: null, after: b },
  ]);
  assert.throws(() => summarizeChangeset({ "x.ts": "not-a-digest" }, {}), /invalid entry/);
});
