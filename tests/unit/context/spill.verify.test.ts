// verification: edge cases for src/context/spill.ts beyond the builder tests.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatHandle, isSpillNotice, recallPayload, spillNotice, storePayload } from "../../../src/context/spill.ts";

const SESSION = "sess-a";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-spill-v-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const handleOf = (r: Awaited<ReturnType<typeof storePayload>>): string => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { handle: string }).handle;
};

test("verify spill: concurrent stores of identical content all succeed with one handle, one file, no temp leftovers", async () => {
  await withTempDir(async (dir) => {
    const content = "same payload ".repeat(1000);
    const results = await Promise.all(Array.from({ length: 16 }, () => storePayload(dir, content, { sessionId: SESSION })));
    const handles = new Set(results.map(handleOf));
    assert.equal(handles.size, 1);
    assert.deepEqual(await readdir(join(dir, SESSION)), [[...handles][0]!.split(":")[2]]);
    const back = await recallPayload(dir, [...handles][0]!, { sessionId: SESSION });
    assert.deepEqual(back, { ok: true, content });
  });
});

test("verify spill: concurrent stores of different content cannot jointly exceed the session quota", async () => {
  await withTempDir(async (dir) => {
    const opts = { sessionId: SESSION, maxSessionBytes: 150 };
    const results = await Promise.all([storePayload(dir, "a".repeat(100), opts), storePayload(dir, "b".repeat(100), opts)]);
    const ok = results.filter((r) => r.ok).length;
    let total = 0;
    for (const name of await readdir(join(dir, SESSION))) total += (await stat(join(dir, SESSION, name))).size;
    assert.ok(total <= 150, `session holds ${total} bytes with quota 150 (${ok} stores reported ok)`);
  });
});

test("verify spill: handle with uppercase hex, unicode, whitespace or a trailing newline is invalid_handle", async () => {
  await withTempDir(async (dir) => {
    const handle = handleOf(await storePayload(dir, "x", { sessionId: SESSION }));
    const digest = handle.split(":")[2]!;
    for (const bad of [
      formatHandle(SESSION, digest.toUpperCase()),
      formatHandle(SESSION, digest.slice(0, 63) + "é"),
      formatHandle("séss", digest),
      `${handle}\n`,
      ` ${handle}`,
      `${handle} `,
      handle.replace("spill:", "SPILL:"),
      formatHandle(SESSION, digest.slice(0, 63)),
      formatHandle(SESSION, `${digest}0`),
    ]) {
      const r = await recallPayload(dir, bad, { sessionId: SESSION });
      assert.equal(r.ok, false, bad);
      assert.equal((r as { reason: string }).reason, "invalid_handle", JSON.stringify(bad));
    }
  });
});

test("verify spill: non-string handle is invalid, never throws", async () => {
  await withTempDir(async (dir) => {
    for (const bad of [undefined, null, 42, {}, ["spill:x:y"]]) {
      const r = await recallPayload(dir, bad as unknown as string, { sessionId: SESSION });
      assert.deepEqual(r, { ok: false, reason: "invalid_handle" });
    }
  });
});

test("verify spill: pre-existing session dir with wrong permissions is tightened to 0700", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, SESSION), { mode: 0o777 });
    await chmod(join(dir, SESSION), 0o777);
    handleOf(await storePayload(dir, "payload", { sessionId: SESSION }));
    assert.equal((await stat(join(dir, SESSION))).mode & 0o777, 0o700);
  });
});

test("verify spill: an already archived file with loose permissions is tightened to 0600 on re-store", async () => {
  await withTempDir(async (dir) => {
    const handle = handleOf(await storePayload(dir, "payload", { sessionId: SESSION }));
    const file = join(dir, SESSION, handle.split(":")[2]!);
    await chmod(file, 0o644);
    handleOf(await storePayload(dir, "payload", { sessionId: SESSION }));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test("verify spill: an unwritable session directory fails with io_error and leaves nothing behind", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  await withTempDir(async (dir) => {
    // storePayload chmods an existing session dir back to 0700 itself, so make the parent read-only instead.
    const parent = join(dir, "ro");
    await mkdir(parent, { mode: 0o500 });
    const r = await storePayload(parent, "payload", { sessionId: SESSION });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "io_error");
    await chmod(parent, 0o700);
    assert.deepEqual(await readdir(parent), []);
  });
});

test("verify spill: an existing corrupted archive file is replaced by a correct one", async () => {
  await withTempDir(async (dir) => {
    const handle = handleOf(await storePayload(dir, "payload", { sessionId: SESSION }));
    const file = join(dir, SESSION, handle.split(":")[2]!);
    await writeFile(file, "tampered");
    assert.equal(handleOf(await storePayload(dir, "payload", { sessionId: SESSION })), handle);
    assert.deepEqual(await recallPayload(dir, handle, { sessionId: SESSION }), { ok: true, content: "payload" });
  });
});

test("verify spill: session ids with path characters are rejected on store and recall", async () => {
  await withTempDir(async (dir) => {
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "a\0b", "a b", "sess\n", ".hidden", "é", "x".repeat(129)]) {
      const s = await storePayload(dir, "x", { sessionId: bad });
      assert.deepEqual(s, { ok: false, reason: "invalid_session" }, JSON.stringify(bad));
      const r = await recallPayload(dir, formatHandle(SESSION, "a".repeat(64)), { sessionId: bad });
      assert.deepEqual(r, { ok: false, reason: "invalid_session" }, JSON.stringify(bad));
    }
    assert.deepEqual(await readdir(dir), []);
    // Longest allowed id works.
    handleOf(await storePayload(dir, "x", { sessionId: "x".repeat(128) }));
  });
});

test("verify spill: session ids differing only by case never share an archive", async () => {
  await withTempDir(async (dir) => {
    const handle = handleOf(await storePayload(dir, "secret of lower", { sessionId: "sess-a" }));
    const digest = handle.split(":")[2]!;
    const r = await recallPayload(dir, formatHandle("SESS-A", digest), { sessionId: "SESS-A" });
    assert.equal(r.ok, false, `session SESS-A read session sess-a's archive: ${JSON.stringify(r)}`);
  });
});

test("verify spill: multi-byte and emoji content round-trips; lone surrogates are refused", async () => {
  await withTempDir(async (dir) => {
    const content = "中文 ✓ 🧪 \u0000 end";
    const h = handleOf(await storePayload(dir, content, { sessionId: SESSION }));
    assert.deepEqual(await recallPayload(dir, h, { sessionId: SESSION }), { ok: true, content });
    const lone = await storePayload(dir, "bad \ud800 surrogate", { sessionId: SESSION });
    assert.deepEqual(lone, { ok: false, reason: "invalid_content" });
  });
});

test("verify spill: payload exactly at the byte limit is stored, one byte over is refused (UTF-8 bytes, not chars)", async () => {
  await withTempDir(async (dir) => {
    assert.equal((await storePayload(dir, "é".repeat(5), { sessionId: SESSION, maxPayloadBytes: 10 })).ok, true);
    const over = await storePayload(dir, "é".repeat(5) + "x", { sessionId: SESSION, maxPayloadBytes: 10 });
    assert.deepEqual(over, { ok: false, reason: "payload_too_large" });
  });
});

test("verify spill: empty content is stored and recalled", async () => {
  await withTempDir(async (dir) => {
    const h = handleOf(await storePayload(dir, "", { sessionId: SESSION }));
    assert.deepEqual(await recallPayload(dir, h, { sessionId: SESSION }), { ok: true, content: "" });
  });
});

test("verify spill: notice with a head is still recognised and a plain mention of jev_recall is not", () => {
  const h = formatHandle(SESSION, "b".repeat(64));
  assert.equal(isSpillNotice(spillNotice(h, { chars: 5, head: "first lines" })), true);
  assert.equal(isSpillNotice("call jev_recall with a handle"), false);
  assert.equal(isSpillNotice(`[jev spill: see jev_recall spill:${SESSION}:${"B".repeat(64)}`), false);
});
