// M2: a pre-existing symlink at the store root or session directory is refused, and nothing
// is chmodded or written through it.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storePayload } from "../../../src/context/spill.ts";

const SESSION = "sess-link";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-spill-link-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a symlinked session directory is refused and its target is left untouched", async () => {
  await withTempDir(async (root) => {
    const store = join(root, "store");
    const elsewhere = join(root, "elsewhere");
    await mkdir(store);
    await mkdir(elsewhere, { mode: 0o755 });
    await chmod(elsewhere, 0o755);
    await symlink(elsewhere, join(store, SESSION));
    const result = await storePayload(store, "archived text", { sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "io_error");
    assert.match((result as { detail?: string }).detail ?? "", /symlink/);
    assert.deepEqual(await readdir(elsewhere), [], "nothing written through the link");
    assert.equal((await stat(elsewhere)).mode & 0o777, 0o755, "the link target was not chmodded");
  });
});

test("a symlinked store root is refused", async () => {
  await withTempDir(async (root) => {
    const real = join(root, "real-store");
    await mkdir(real);
    const store = join(root, "store");
    await symlink(real, store);
    const result = await storePayload(store, "archived text", { sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "io_error");
    assert.deepEqual(await readdir(real), [], "nothing created through the link");
  });
});

test("a session path that is a regular file is refused", async () => {
  await withTempDir(async (store) => {
    await writeFile(join(store, SESSION), "not a directory");
    const result = await storePayload(store, "archived text", { sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "io_error");
  });
});

test("a normal store still works and the session directory is private", async () => {
  await withTempDir(async (store) => {
    const result = await storePayload(store, "archived text", { sessionId: SESSION });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await stat(join(store, SESSION))).mode & 0o777, 0o700);
  });
});
