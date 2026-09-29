import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareWorkspace, runProc, startFakeJev } from "./runner.ts";

const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");

test("prepareWorkspace copies a fixture into a fresh committed git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-test-"));
  try {
    const ws = join(dir, "ws");
    await prepareWorkspace({ id: "t", category: "small_fix", repo: { fixture: "tiny-fix" }, prompt: "p", acceptance: ["true"], timeoutSec: 1 }, FIXTURES, ws, process.env);
    assert.match(await readFile(join(ws, "math.js"), "utf8"), /a - b/);
    const status = await runProc(["git", "status", "--porcelain"], { cwd: ws, env: process.env, timeoutMs: 10_000 });
    assert.equal(status.exit, 0);
    assert.equal(status.stdout, "");
    const acc = await runProc(["node", join(dirname(FIXTURES), "tasks", "smoke", "check-fix-add.mjs")], { cwd: ws, env: process.env, timeoutMs: 10_000 });
    assert.equal(acc.exit, 1, "fixture starts failing its acceptance");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fake Jev answers 503 and counts requests", async () => {
  const jev = await startFakeJev();
  try {
    const res = await fetch(jev.url, { method: "POST", body: "{}" });
    assert.equal(res.status, 503);
    await res.text();
    assert.equal(jev.count(), 1);
  } finally {
    await jev.close();
  }
});

test("runProc reports timeouts and spawn errors without throwing", async () => {
  const slow = await runProc(["node", "-e", "setTimeout(()=>{}, 10000)"], { cwd: tmpdir(), env: process.env, timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  const missing = await runProc(["/nonexistent/bin"], { cwd: tmpdir(), env: process.env, timeoutMs: 1000 });
  assert.equal(missing.exit, null);
  assert.notEqual(missing.error, null);
});
