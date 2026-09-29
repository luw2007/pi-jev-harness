/**
 * verification of D4 (`src/adapters/pi/workspace.ts`): the task changeset baseline.
 * Real git and real temp directories; no Pi, Jev or model.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotWorkspace, type WorkspaceDiff } from "../../../../src/adapters/pi/workspace.ts";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe" });
}

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function temp(fn: (dir: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-jev-ws-verify-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const paths = (diff: WorkspaceDiff) => diff.changes.map((change) => change.path).sort();

/** A committed repository: a.txt, b.txt, bin/blob.bin, src/keep.js. */
async function repo(dir: string) {
  await mkdir(join(dir, "bin"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "a.txt"), "alpha\n");
  await writeFile(join(dir, "b.txt"), "beta\n");
  await writeFile(join(dir, "bin", "blob.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]));
  await writeFile(join(dir, "src", "keep.js"), "export const k = 1;\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
}

test("git: every kind of pre-existing dirt left alone by the task is never a task change", async () => {
  await temp(async (dir) => {
    await repo(dir);
    // Before the task: modified tracked, staged new file, untracked file, deleted tracked file, staged-then-modified.
    await writeFile(join(dir, "a.txt"), "alpha user edit\n");
    await writeFile(join(dir, "staged.txt"), "staged\n");
    git(dir, "add", "staged.txt");
    await writeFile(join(dir, "draft with space ü.md"), "draft\n");
    await unlink(join(dir, "b.txt"));
    await writeFile(join(dir, "src", "keep.js"), "export const k = 2;\n");
    git(dir, "add", "src/keep.js");
    await writeFile(join(dir, "src", "keep.js"), "export const k = 3;\n");
    const baseline = await snapshotWorkspace(dir);
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes, [], "nothing the task did");
    assert.deepEqual([...diff.preexisting].sort(), ["a.txt", "b.txt", "draft with space ü.md", "src/keep.js", "staged.txt"]);
    assert.equal(diff.note, null);
  });
});

test("git: a tracked file deleted by bash is a deletion (before = HEAD blob, after = null)", async () => {
  await temp(async (dir) => {
    await repo(dir);
    const baseline = await snapshotWorkspace(dir);
    await unlink(join(dir, "a.txt"));
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes, [{ path: "a.txt", before: sha("alpha\n"), after: null }]);
    assert.deepEqual(diff.preexisting, []);
  });
});

test("git: a pre-existing untracked file deleted by the task is this task's change", async () => {
  await temp(async (dir) => {
    await repo(dir);
    await writeFile(join(dir, "scratch.txt"), "user scratch\n");
    const baseline = await snapshotWorkspace(dir);
    await unlink(join(dir, "scratch.txt"));
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes, [{ path: "scratch.txt", before: sha("user scratch\n"), after: null }]);
    assert.deepEqual(diff.preexisting, ["scratch.txt"]);
  });
});

test("git: a pre-existing change the task reverts to HEAD is this task's change (content differs from start)", async () => {
  await temp(async (dir) => {
    await repo(dir);
    await writeFile(join(dir, "a.txt"), "alpha user edit\n");
    const baseline = await snapshotWorkspace(dir);
    await writeFile(join(dir, "a.txt"), "alpha\n"); // git status is clean again
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes, [{ path: "a.txt", before: sha("alpha user edit\n"), after: sha("alpha\n") }]);
  });
});

test("git: a binary file changed by the task is detected by content hash", async () => {
  await temp(async (dir) => {
    await repo(dir);
    const baseline = await snapshotWorkspace(dir);
    const next = Buffer.from([0, 1, 2, 255, 254, 0, 10, 14]);
    await writeFile(join(dir, "bin", "blob.bin"), next);
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes, [{ path: "bin/blob.bin", before: sha(Buffer.from([0, 1, 2, 255, 254, 0, 10, 13])), after: sha(next) }]);
  });
});

test("git: rewriting a file with identical bytes is not a change", async () => {
  await temp(async (dir) => {
    await repo(dir);
    await writeFile(join(dir, "a.txt"), "dirty\n");
    const baseline = await snapshotWorkspace(dir);
    await writeFile(join(dir, "a.txt"), "dirty\n");
    await writeFile(join(dir, "b.txt"), "beta\n");
    assert.deepEqual((await baseline.diff()).changes, []);
  });
});

test("git: a staged rename made by the task lists the old path deleted and the new path added", async () => {
  await temp(async (dir) => {
    await repo(dir);
    const baseline = await snapshotWorkspace(dir);
    git(dir, "mv", "a.txt", "renamed.txt");
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes.map(({ path, before, after }) => [path, before !== null, after !== null]).sort(), [
      ["a.txt", true, false],
      ["renamed.txt", false, true],
    ]);
  });
});

test("git: cwd in a subdirectory sees only that subtree, paths relative to cwd", async () => {
  await temp(async (dir) => {
    await repo(dir);
    await writeFile(join(dir, "a.txt"), "dirty outside cwd\n");
    const cwd = join(dir, "src");
    const baseline = await snapshotWorkspace(cwd);
    await writeFile(join(dir, "b.txt"), "changed outside cwd\n");
    await writeFile(join(cwd, "keep.js"), "export const k = 9;\n");
    await writeFile(join(cwd, "new.js"), "export const n = 1;\n");
    const diff = await baseline.diff();
    assert.deepEqual(paths(diff), ["keep.js", "new.js"]);
    assert.deepEqual(diff.preexisting, []);
  });
});

test("git: the run products directory inside the workspace is excluded", async () => {
  await temp(async (dir) => {
    await repo(dir);
    const runs = join(dir, ".pi-runs");
    const baseline = await snapshotWorkspace(dir, [runs]);
    await mkdir(join(runs, "run_1"), { recursive: true });
    await writeFile(join(runs, "run_1", "run.json"), "{}\n");
    await writeFile(join(dir, "c.txt"), "c\n");
    assert.deepEqual(paths(await baseline.diff()), ["c.txt"]);
  });
});

test("non-git directory: added, modified, deleted and binary files are found by the walk; unchanged files are not", async () => {
  await temp(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "src", "a.js"), "a\n");
    await writeFile(join(dir, "src", "gone.js"), "gone\n");
    await writeFile(join(dir, "keep.txt"), "keep\n");
    await writeFile(join(dir, "img.bin"), Buffer.from([0, 0, 1]));
    const baseline = await snapshotWorkspace(dir);
    await writeFile(join(dir, "src", "a.js"), "a changed\n");
    await unlink(join(dir, "src", "gone.js"));
    await writeFile(join(dir, "src", "new.js"), "new\n");
    await writeFile(join(dir, "img.bin"), Buffer.from([0, 0, 2]));
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "ignored\n");
    const diff = await baseline.diff();
    assert.deepEqual(diff.changes.map(({ path, before, after }) => `${before === null ? "+" : after === null ? "-" : "~"}${path}`).sort(), ["+src/new.js", "-src/gone.js", "~img.bin", "~src/a.js"]);
    assert.deepEqual(diff.preexisting, [], "a walk cannot tell pre-existing dirt, and never invents it");
    assert.equal(diff.note, null);
  });
});

test("non-git directory: an excluded run directory and .git-less nested folders are handled", async () => {
  await temp(async (dir) => {
    const runs = join(dir, "out", "runs");
    await mkdir(runs, { recursive: true });
    await writeFile(join(dir, "out", "report.txt"), "r\n");
    const baseline = await snapshotWorkspace(dir, [runs]);
    await writeFile(join(runs, "run.json"), "{}\n");
    await writeFile(join(dir, "out", "report.txt"), "r2\n");
    assert.deepEqual(paths(await baseline.diff()), ["out/report.txt"]);
  });
});

test("the baseline reads the file as it was at snapshot time, not at diff time", async () => {
  await temp(async (dir) => {
    await repo(dir);
    await writeFile(join(dir, "a.txt"), "v1\n");
    const baseline = await snapshotWorkspace(dir);
    await writeFile(join(dir, "a.txt"), "v2\n");
    const [change] = (await baseline.diff()).changes;
    assert.equal(change!.before, sha("v1\n"));
    assert.equal(change!.after, sha(await readFile(join(dir, "a.txt"))));
  });
});
