import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatHandle,
  isSpillNotice,
  recallPayload,
  spillNotice,
  storePayload,
  type SpillFs,
} from "../../../src/context/spill.ts";

const SESSION = "sess-a";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-spill-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function storedHandle(result: Awaited<ReturnType<typeof storePayload>>): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { handle: string }).handle;
}

function digestOf(handle: string): string {
  return handle.slice(handle.lastIndexOf(":") + 1);
}

test("store then recall returns identical content", async () => {
  await withTempDir(async (dir) => {
    const payload = `port=8471\n${"noise\n".repeat(500)}ünïcode ✓ 日本語`;
    const handle = storedHandle(await storePayload(dir, payload, { sessionId: SESSION }));
    assert.match(handle, /^spill:sess-a:[0-9a-f]{64}$/);
    const recalled = await recallPayload(dir, handle, { sessionId: SESSION });
    assert.deepEqual(recalled, { ok: true, content: payload });
  });
});

test("archived file is 0600 and session directory is 0700", async () => {
  await withTempDir(async (dir) => {
    const handle = storedHandle(await storePayload(dir, "secret output", { sessionId: SESSION }));
    const fileMode = (await stat(join(dir, SESSION, digestOf(handle)))).mode & 0o777;
    const dirMode = (await stat(join(dir, SESSION))).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  });
});

test("failure during write leaves no file behind and returns ok:false", async () => {
  await withTempDir(async (dir) => {
    const failingFs: SpillFs = {
      ...(realFs as unknown as SpillFs),
      async writeFile(path, data, options) {
        // Simulate a partial write that dies half way.
        await realFs.writeFile(path, data.subarray(0, Math.floor(data.byteLength / 2)), options);
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const result = await storePayload(dir, "x".repeat(4096), { sessionId: SESSION, fs: failingFs });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "io_error");
    assert.deepEqual(await readdir(join(dir, SESSION)), []);
  });
});

test("failure during rename leaves no file behind and returns ok:false", async () => {
  await withTempDir(async (dir) => {
    const failingFs: SpillFs = {
      ...(realFs as unknown as SpillFs),
      async rename() {
        throw Object.assign(new Error("rename failed"), { code: "EIO" });
      },
    };
    const result = await storePayload(dir, "payload", { sessionId: SESSION, fs: failingFs });
    assert.equal(result.ok, false);
    assert.deepEqual(await readdir(join(dir, SESSION)), []);
  });
});

test("tampering one byte makes recall return corrupted", async () => {
  await withTempDir(async (dir) => {
    const handle = storedHandle(await storePayload(dir, "the error code is PG-42703", { sessionId: SESSION }));
    const path = join(dir, SESSION, digestOf(handle));
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 0x01;
    await writeFile(path, bytes);
    const recalled = await recallPayload(dir, handle, { sessionId: SESSION });
    assert.equal(recalled.ok, false);
    assert.equal((recalled as { reason: string }).reason, "corrupted");
  });
});

test("recall rejects path traversal, foreign session and absolute path handles", async () => {
  await withTempDir(async (dir) => {
    const handle = storedHandle(await storePayload(dir, "mine", { sessionId: SESSION }));
    const digest = digestOf(handle);
    const other = storedHandle(await storePayload(dir, "theirs", { sessionId: "sess-b" }));

    const traversal = [
      `spill:../sess-b:${digest}`,
      `spill:${SESSION}:../${digest}`,
      `../sess-b/${digest}`,
      `spill:${SESSION}:${digest}/../../etc/passwd`,
      `spill:..:${digest}`,
    ];
    for (const bad of traversal) {
      const r = await recallPayload(dir, bad, { sessionId: SESSION });
      assert.equal(r.ok, false, bad);
      assert.equal((r as { reason: string }).reason, "invalid_handle", bad);
    }

    const foreign = await recallPayload(dir, other, { sessionId: SESSION });
    assert.equal(foreign.ok, false);
    assert.equal((foreign as { reason: string }).reason, "foreign_session");

    for (const abs of [join(dir, SESSION, digest), "/etc/passwd"]) {
      const r = await recallPayload(dir, abs, { sessionId: SESSION });
      assert.equal(r.ok, false, abs);
      assert.equal((r as { reason: string }).reason, "invalid_handle", abs);
    }

    // The legitimate handle still works.
    assert.deepEqual(await recallPayload(dir, handle, { sessionId: SESSION }), { ok: true, content: "mine" });
  });
});

test("store rejects unsafe session ids", async () => {
  await withTempDir(async (dir) => {
    for (const sessionId of ["..", ".", "a/b", "", "/abs"]) {
      const r = await storePayload(dir, "x", { sessionId });
      assert.equal(r.ok, false, sessionId);
      assert.equal((r as { reason: string }).reason, "invalid_session", sessionId);
    }
    assert.deepEqual(await readdir(dir), []);
  });
});

test("payload over the per-payload limit fails with ok:false", async () => {
  await withTempDir(async (dir) => {
    const r = await storePayload(dir, "x".repeat(101), { sessionId: SESSION, maxPayloadBytes: 100 });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "payload_too_large");
    const ok = await storePayload(dir, "x".repeat(100), { sessionId: SESSION, maxPayloadBytes: 100 });
    assert.equal(ok.ok, true);
  });
});

test("payload over the session total limit fails with ok:false", async () => {
  await withTempDir(async (dir) => {
    const opts = { sessionId: SESSION, maxSessionBytes: 150 };
    assert.equal((await storePayload(dir, "a".repeat(100), opts)).ok, true);
    const r = await storePayload(dir, "b".repeat(60), opts);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "session_quota_exceeded");
    assert.equal((await readdir(join(dir, SESSION))).length, 1);
    // Re-storing already archived content is idempotent and does not count twice.
    assert.equal((await storePayload(dir, "a".repeat(100), opts)).ok, true);
  });
});

test("storing identical content twice yields one file and the same handle", async () => {
  await withTempDir(async (dir) => {
    const a = storedHandle(await storePayload(dir, "same output", { sessionId: SESSION }));
    const b = storedHandle(await storePayload(dir, "same output", { sessionId: SESSION }));
    assert.equal(a, b);
    assert.deepEqual(await readdir(join(dir, SESSION)), [digestOf(a)]);
  });
});

test("recall of a missing archive returns not_found", async () => {
  await withTempDir(async (dir) => {
    const r = await recallPayload(dir, formatHandle(SESSION, "0".repeat(64)), { sessionId: SESSION });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "not_found");
  });
});

test("spillNotice names jev_recall and the handle, and isSpillNotice recognises it", () => {
  const handle = formatHandle(SESSION, "a".repeat(64));
  const notice = spillNotice(handle, { chars: 12345, head: "port=8471" });
  assert.ok(notice.includes("jev_recall"));
  assert.ok(notice.includes(handle));
  assert.ok(notice.startsWith("port=8471\n"));
  assert.equal(isSpillNotice(notice), true);
  assert.equal(isSpillNotice(spillNotice(handle, { chars: 1 })), true);
  assert.equal(isSpillNotice("ordinary tool output"), false);
  assert.equal(isSpillNotice("mentions jev_recall but no notice"), false);
});
