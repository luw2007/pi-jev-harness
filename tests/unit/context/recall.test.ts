import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_TOOL_NAME, recall } from "../../../src/context/recall.ts";
import { storePayload } from "../../../src/context/spill.ts";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-jev-recall-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function archived(content: string, sessionId = "s1"): Promise<string> {
  const stored = await storePayload(dir, content, { sessionId });
  assert.ok(stored.ok);
  return stored.handle;
}

test("recall tool name is jev_recall", () => {
  assert.equal(RECALL_TOOL_NAME, "jev_recall");
});

test("recall returns the exact archived content", async () => {
  const content = "line 1\nüñïçødé ✓ 🎉\n" + "x".repeat(10_000);
  const handle = await archived(content);
  assert.deepEqual(await recall({ handle, sessionId: "s1", dir }), { ok: true, content });
});

test("recall rejects a handle of another session", async () => {
  const handle = await archived("secret of s2", "s2");
  const out = await recall({ handle, sessionId: "s1", dir });
  assert.deepEqual(out, { ok: false, reason: "foreign_session" });
});

test("recall rejects paths and traversal instead of handles", async () => {
  const digest = "a".repeat(64);
  for (const handle of [
    "/etc/passwd",
    "../s1/" + digest,
    `spill:../s1:${digest}`,
    `spill:s1:../${digest.slice(3)}`,
    `spill:s1:${digest}/../../etc/passwd`,
    join(dir, "s1", digest),
    "",
  ]) {
    const out = await recall({ handle, sessionId: "s1", dir });
    assert.equal(out.ok, false, handle);
    if (!out.ok) assert.equal(out.reason, "invalid_handle", handle);
  }
});

test("recall rejects a non-string handle and a relative archive dir", async () => {
  assert.deepEqual(await recall({ handle: { path: "/etc/passwd" }, sessionId: "s1", dir }), {
    ok: false,
    reason: "invalid_handle",
  });
  const handle = await archived("content");
  assert.deepEqual(await recall({ handle, sessionId: "s1", dir: "relative/dir" }), { ok: false, reason: "invalid_dir" });
});

test("recall of an unknown digest is not_found", async () => {
  const out = await recall({ handle: `spill:s1:${"b".repeat(64)}`, sessionId: "s1", dir });
  assert.deepEqual(out, { ok: false, reason: "not_found" });
});
