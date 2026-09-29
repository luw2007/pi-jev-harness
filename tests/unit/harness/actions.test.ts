import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, lstat, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  buildEnvelope,
  checkFreshness,
  isFastPathRead,
  replacementsToUnifiedDiff,
  validateEnvelope,
} from "../../../src/harness/actions.ts";
import type { ActionHost, ActionPolicy, AuthorizationScope, HarnessFs, ToolCallInput } from "../../../src/harness/types.ts";

const fs: HarnessFs = { readFile, lstat, realpath };
const ALL: AuthorizationScope = {
  id: "goal",
  kinds: ["read", "search", "edit", "create", "overwrite", "command"],
  maxFileBytes: 1024,
};

let base = "";
let root = "";
let outside = "";
let ids = 0;
const SUM = "export function sum(items: number[], n: number) {\n  let total = 0;\n  for (let i = 0; i < n - 1; i++) total += items[i];\n  return total;\n}\n";

before(async () => {
  base = await mkdtemp(join(tmpdir(), "pi-jev-actions-"));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "src/sum.ts"), SUM);
  await writeFile(join(root, "README.md"), "# demo\n");
  await writeFile(join(root, "twice.txt"), "same\nsame\n");
  await writeFile(join(root, "big.txt"), "x".repeat(2048));
  await writeFile(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await writeFile(join(outside, "secret.txt"), "token\n");
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await symlink(outside, join(root, "outdir"));
});
after(() => rm(base, { recursive: true, force: true }));

function host(overrides: Partial<ActionHost> = {}): ActionHost {
  return { cwd: root, fs, allowedRoots: [root], grants: [ALL], newId: () => `id-${++ids}`, ...overrides };
}
const policy = (overrides: Partial<ActionPolicy> = {}): ActionPolicy => ({ fs, allowedRoots: [root], grants: [ALL], ...overrides });

async function check(call: ToolCallInput, h = host(), p = policy()) {
  const envelope = await buildEnvelope(call, h);
  return { envelope, result: await validateEnvelope(envelope, p) };
}
function rejected(result: { ok: boolean; reason?: string }, pattern: RegExp) {
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, pattern);
}

test("read inside the root is valid and takes the fast path", async () => {
  const { envelope, result } = await check({ toolName: "read", args: { path: "src/sum.ts" }, toolCallId: "call-1", rationale: "need the loop" });
  assert.deepEqual(result, { ok: true });
  assert.equal(envelope.kind, "read");
  assert.equal(envelope.toolCallId, "call-1");
  assert.equal(envelope.rationale, "need the loop");
  assert.deepEqual(envelope.targets, [await realpath(join(root, "src/sum.ts"))]);
  assert.equal(envelope.preimage?.bytes, Buffer.byteLength(SUM));
  assert.match(envelope.preimage!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(isFastPathRead(envelope), true);
});

test("search tools resolve to the cwd by default and take the fast path", async () => {
  for (const call of [{ toolName: "grep", args: { pattern: "sum" } }, { toolName: "find", args: { pattern: "*.ts", path: "src" } }, { toolName: "ls", args: {} }]) {
    const { envelope, result } = await check(call);
    assert.deepEqual(result, { ok: true }, call.toolName);
    assert.equal(envelope.kind, "search");
    assert.equal(isFastPathRead(envelope), true, call.toolName);
  }
});

test("`../` escaping the root is rejected and is not a fast-path read", async () => {
  await writeFile(join(base, "outside.txt"), "x\n");
  const { envelope, result } = await check({ toolName: "read", args: { path: "../outside.txt" } });
  rejected(result, /outside the allowed roots/);
  assert.equal(isFastPathRead(envelope), false);
  rejected((await check({ toolName: "grep", args: { pattern: "x", path: "src/../../outside" } })).result, /outside the allowed roots/);
});

test("symbolic links resolving outside the root are rejected", async () => {
  const file = await check({ toolName: "read", args: { path: "link.txt" } });
  rejected(file.result, /symbolic link resolving outside/);
  assert.equal(isFastPathRead(file.envelope), false);
  rejected((await check({ toolName: "write", args: { path: "outdir/new.txt", content: "x" } })).result, /symbolic link resolving outside|outside the allowed roots/);
  rejected((await check({ toolName: "edit", args: { path: "link.txt", edits: [{ oldText: "token", newText: "t" }] } })).result, /symbolic link resolving outside/);
});

test("reads without a covering grant are blocked and never fast-path", async () => {
  const noRead = { ...ALL, id: "edits-only", kinds: ["edit"] as const };
  const { envelope, result } = await check({ toolName: "read", args: { path: "README.md" } }, host({ grants: [noRead] }), policy({ grants: [noRead] }));
  rejected(result, /no grant authorizes read/);
  assert.equal(isFastPathRead(envelope), false);
});

test("edit requires an existing target", async () => {
  rejected((await check({ toolName: "edit", args: { path: "src/missing.ts", edits: [{ oldText: "a", newText: "b" }] } })).result, /does not exist/);
});

test("edit oldText must match exactly once", async () => {
  const good = await check({ toolName: "edit", args: { path: "src/sum.ts", edits: [{ oldText: "i < n - 1", newText: "i < n" }] } });
  assert.deepEqual(good.result, { ok: true });
  assert.deepEqual(good.envelope.change, { format: "replacements", edits: [{ oldText: "i < n - 1", newText: "i < n" }] });
  assert.equal(isFastPathRead(good.envelope), false);
  assert.deepEqual((await check({ toolName: "edit", args: { path: "src/sum.ts", oldText: "let total = 0;", newText: "let total = 1;" } })).result, { ok: true });
  rejected((await check({ toolName: "edit", args: { path: "src/sum.ts", edits: [{ oldText: "i <= n", newText: "x" }] } })).result, /matches 0 times/);
  rejected((await check({ toolName: "edit", args: { path: "twice.txt", edits: [{ oldText: "same", newText: "x" }] } })).result, /matches 2 times/);
  rejected(
    (await check({ toolName: "edit", args: { path: "src/sum.ts", edits: [{ oldText: "let total = 0;", newText: "a" }, { oldText: "total = 0", newText: "b" }] } })).result,
    /overlap/,
  );
});

test("checkFreshness reports stale once the preimage changes", async () => {
  const path = join(root, "fresh.txt");
  await writeFile(path, "alpha\n");
  const { envelope, result } = await check({ toolName: "edit", args: { path: "fresh.txt", edits: [{ oldText: "alpha", newText: "beta" }] } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await checkFreshness(envelope, fs), { status: "fresh" });
  await writeFile(path, "alpha changed\n");
  const stale = await checkFreshness(envelope, fs);
  assert.equal(stale.status, "stale");
  rejected(await validateEnvelope(envelope, policy()), /preimage does not match/);
});

test("create refuses an existing file; the overwrite marker allows replacing it", async () => {
  rejected((await check({ toolName: "write", args: { path: "README.md", content: "# new\n" } })).result, /already exists.*overwrite marker/);
  const replaced = await check({ toolName: "write", args: { path: "README.md", content: "# new\n" }, overwrite: true });
  assert.deepEqual(replaced.result, { ok: true });
  assert.equal(replaced.envelope.kind, "overwrite");
  assert.equal(replaced.envelope.preimage?.bytes, 7);
  const created = await check({ toolName: "write", args: { path: "src/new.ts", content: "export {};\n" } });
  assert.deepEqual(created.result, { ok: true });
  assert.equal(created.envelope.kind, "create");
  const digest = createHash("sha256").update("export {};\n").digest("hex");
  assert.deepEqual(created.envelope.change, { format: "content", sha256: digest, bytes: 11 });
  await writeFile(join(root, "src/new.ts"), "raced\n");
  assert.equal((await checkFreshness(created.envelope, fs)).status, "stale");
});

test("create requires an existing parent directory", async () => {
  rejected((await check({ toolName: "write", args: { path: "nope/deeper/file.ts", content: "x" } })).result, /parent directory .* does not exist/);
});

test("files and new content above the size limit are rejected", async () => {
  const big = await check({ toolName: "read", args: { path: "big.txt" } });
  rejected(big.result, /2048 bytes; limit is 1024/);
  assert.equal(isFastPathRead(big.envelope), false);
  rejected((await check({ toolName: "write", args: { path: "src/huge.ts", content: "y".repeat(2000) } })).result, /2000 bytes; limit is 1024/);
  rejected((await check({ toolName: "edit", args: { path: "README.md", edits: [{ oldText: "demo", newText: "z".repeat(2000) } ] } })).result, /limit is 1024/);
});

test("binary files and binary content are rejected", async () => {
  rejected((await check({ toolName: "read", args: { path: "image.bin" } })).result, /binary file/);
  rejected((await check({ toolName: "edit", args: { path: "image.bin", edits: [{ oldText: "PNG", newText: "GIF" }] } })).result, /binary file/);
  rejected((await check({ toolName: "write", args: { path: "src/x.bin", content: "a\0b" } })).result, /content is binary/);
});

test("command cwd must be inside the root; a test-named command gets no extra latitude", async () => {
  const inside = await check({ toolName: "bash", args: { command: "pnpm test" } });
  assert.deepEqual(inside.result, { ok: true });
  assert.deepEqual(inside.envelope.change, { format: "command", script: "pnpm test", cwd: await realpath(root) });
  assert.equal(isFastPathRead(inside.envelope), false);
  rejected((await check({ toolName: "bash", args: { command: "pnpm test" } }, host({ cwd: outside }))).result, /outside the allowed roots/);
  const readOnly = { ...ALL, id: "read-only", kinds: ["read", "search"] as const };
  rejected((await check({ toolName: "bash", args: { command: "npm test" } }, host({ grants: [readOnly] }), policy({ grants: [readOnly] }))).result, /no grant authorizes command/);
});

test("rename, delete, and unknown tools are unsupported and withheld", async () => {
  for (const toolName of ["rename", "delete", "move", "delete_file", "run_shell", "toString", "__proto__"]) {
    const { envelope, result } = await check({ toolName, args: { path: "README.md", to: "b.md" } });
    assert.equal(envelope.kind, "unsupported", toolName);
    assert.equal(envelope.withheld, true, toolName);
    assert.equal(envelope.change, null, toolName);
    rejected(result, /withheld/);
    assert.equal(isFastPathRead(envelope), false);
  }
});

test("malformed arguments are blocked before any review", async () => {
  rejected((await check({ toolName: "read", args: null })).result, /plain object/);
  rejected((await check({ toolName: "read", args: { path: 3 } })).result, /read\.path must be a string/);
  rejected((await check({ toolName: "bash", args: { command: "ls", cwd: "/" } })).result, /does not accept argument "cwd"/);
  rejected((await check({ toolName: "edit", args: { path: "README.md" } })).result, /requires edits\[\] or oldText\/newText/);
  rejected((await check({ toolName: "read", args: { path: "~/.ssh/id_rsa" } })).result, /home-relative/);
});

// H's single-file proposal validation cases (tests/unit/vendor-h/proposal-review.test.ts),
// replayed through the envelope path for H's read_file / propose_patch tool shapes.
const GOOD_PATCH = `--- a/src/sum.ts
+++ b/src/sum.ts
@@ -2,3 +2,3 @@
   let total = 0;
-  for (let i = 0; i < n - 1; i++) total += items[i];
+  for (let i = 0; i < n; i++) total += items[i];
   return total;
`;
const good = { path: "src/sum.ts", patch: GOOD_PATCH, rationale: "The loop stops one short of n.", evidence: ["for (let i = 0; i < n - 1; i++) total += items[i];"] };
const proposal = (args: Record<string, unknown>, toolName = "propose_patch") => check({ toolName, args });

test("H cases: a well-formed single-file patch passes", async () => {
  const { envelope, result } = await proposal(good);
  assert.deepEqual(result, { ok: true });
  assert.equal(envelope.kind, "edit");
  assert.deepEqual(envelope.change, { format: "unified_diff", patch: GOOD_PATCH });
  assert.equal(envelope.rationale, good.rationale);
});

test("H cases: `..`, absolute, backslash, and unknown paths are rejected", async () => {
  for (const path of ["../x.ts", "src/../../x.ts", "/etc/passwd", "C:/win.ini", "src\\sum.ts", "src//sum.ts", "./src/sum.ts", "src/missing.ts"]) {
    const { result } = await proposal({ ...good, path, patch: GOOD_PATCH.replaceAll("src/sum.ts", path) });
    assert.equal(result.ok, false, path);
  }
});

test("H cases: multi-file diffs, header mismatches, and mismatched context are rejected", async () => {
  rejected((await proposal({ ...good, patch: GOOD_PATCH + GOOD_PATCH.replaceAll("src/sum.ts", "README.md") })).result, /2 files/);
  rejected((await proposal({ ...good, patch: GOOD_PATCH.replace("+++ b/src/sum.ts", "+++ b/src/other.ts") })).result, /header names/);
  rejected(
    (await proposal({ ...good, patch: GOOD_PATCH.replace("-  for (let i = 0; i < n - 1; i++) total += items[i];", "-  for (let i = 1; i < n; i++) total += items[i];") })).result,
    /context does not match/,
  );
  assert.equal((await proposal({ ...good, patch: "@@ garbage" })).result.ok, false);
});

test("H cases: missing patches, patches on read_file, and extra keys are rejected", async () => {
  const { patch: _p, ...noPatch } = good;
  rejected((await proposal(noPatch)).result, /requires a unified diff/);
  rejected((await proposal(good, "read_file")).result, /must not carry a patch/);
  assert.equal((await proposal({ ...good, extra: 1 })).result.ok, false);
  assert.deepEqual((await proposal({ path: "README.md", rationale: "need context", evidence: [] }, "read_file")).result, { ok: true });
});

test("a unified-diff hunk whose old side appears twice is rejected", async () => {
  const patch = "--- a/twice.txt\n+++ b/twice.txt\n@@ -1,1 +1,1 @@\n-same\n+diff\n";
  rejected((await proposal({ path: "twice.txt", patch, rationale: "r", evidence: [] })).result, /matches 2 positions/);
});

test("replacements become one unified diff: nearby changes share a hunk, line counts shift, EOF newline tracked", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n");
  const diff = replacementsToUnifiedDiff("f.txt", `\uFEFF${text}`, [
    { oldText: "line 20", newText: "twenty\n" },
    { oldText: "line 2\r\nline 3", newText: "two" },
    { oldText: "line 7", newText: "seven\nseven-b" },
  ]);
  assert.equal(diff, [
    "--- a/f.txt", "+++ b/f.txt",
    "@@ -1,10 +1,10 @@", " line 1", "-line 2", "-line 3", "+two", " line 4", " line 5", " line 6",
    "-line 7", "+seven", "+seven-b", " line 8", " line 9", " line 10",
    "@@ -17,4 +17,4 @@", " line 17", " line 18", " line 19", "-line 20", "\\ No newline at end of file", "+twenty",
    "",
  ].join("\n"));
  assert.equal(
    replacementsToUnifiedDiff("g.txt", "a\nb\n", [{ oldText: "a\n", newText: "" }]),
    "--- a/g.txt\n+++ b/g.txt\n@@ -1,2 +1,1 @@\n-a\n b\n",
  );
  assert.throws(() => replacementsToUnifiedDiff("f.txt", "x\nx\n", [{ oldText: "x", newText: "y" }]), /matches 2 times/);
});
