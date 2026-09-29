import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordToolResult, summarizeChangeset } from "../../../src/harness/evidence.ts";
import { createRuntimeReceipt, replayReceipt } from "../../../src/harness/receipt.ts";
import {
  defaultRunDir,
  summarizeUsage,
  writeRunArtifacts,
  type RunArtifactsFs,
  type RunRecord,
} from "../../../src/harness/run-artifacts.ts";

const HEX = (c: string) => c.repeat(64);

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-run-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const { evidence, artifact } = recordToolResult(
    { actionId: "act-1", toolCallId: "call-1", toolName: "bash", isError: false, content: "1 passed", startedAt: 0, endedAt: 5 },
    { artifacts: "full" },
  );
  const receipt = createRuntimeReceipt({
    runId: "run-1", sessionId: "s", branchId: "b", generation: 0, actionId: "act-1",
    snapshot: { digest: HEX("a"), version: "host-snapshot-v1" },
    execution: { status: "executed", reason: null, evidence: [evidence] },
    verification: { status: "passed", evidenceRefs: ["call-1"], note: null },
  });
  return {
    runId: "run-1",
    task: "修复空列表分页",
    status: "completed",
    workspace: "/work/repo",
    changes: summarizeChangeset({ "src/page.ts": HEX("a") }, { "src/page.ts": HEX("b") }),
    verification: [{ name: "回归测试", status: "passed", evidenceRefs: ["call-1"] }],
    reasons: [],
    remaining: [],
    receipts: [receipt],
    artifacts: artifact ? [artifact] : [],
    usage: summarizeUsage([receipt.receipt.usage]),
    ...overrides,
  };
}

test("writes summary.md, run.json, receipts.jsonl, and artifacts with private permissions", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "runs", "run-1");
    const run = sampleRun();
    await writeRunArtifacts(dir, run);
    const json = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    assert.equal(json.runId, "run-1");
    assert.equal(json.status, "completed");
    assert.equal(json.workspace, "/work/repo");
    assert.deepEqual(json.changes, run.changes);
    assert.deepEqual(json.verification, run.verification);
    assert.deepEqual(json.report, { dir, summary: "summary.md", receipts: "receipts.jsonl", artifacts: [run.artifacts[0]!.ref] });
    assert.match(await readFile(join(dir, "summary.md"), "utf8"), /^任务：修复空列表分页\n状态：已完成\n/);
    const lines = (await readFile(join(dir, "receipts.jsonl"), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(replayReceipt(lines[0], { runId: "run-1", sessionId: "s", branchId: "b", generation: 0, actionId: "act-1", snapshot: { digest: HEX("a"), version: "host-snapshot-v1" }, outputs: { "call-1": run.receipts[0]!.receipt.execution.evidence[0]!.output.sha256 } }).status, "match");
    assert.equal(await readFile(join(dir, run.artifacts[0]!.ref), "utf8"), "1 passed");
    for (const file of ["run.json", "summary.md", "receipts.jsonl", run.artifacts[0]!.ref])
      assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600, file);
    for (const d of [dir, join(dir, "artifacts")]) assert.equal((await stat(d)).mode & 0o777, 0o700, d);
  });
});

test("verification_unavailable is kept as such in run.json and never shown as completed", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    await writeRunArtifacts(dir, sampleRun({
      status: "verification_unavailable",
      verification: [{ name: "完成验收", status: "unavailable", evidenceRefs: [] }],
      remaining: ["回归测试未确认"],
    }));
    const json = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    assert.equal(json.status, "verification_unavailable");
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /状态：已结束，完成验收不可用/);
    assert.doesNotMatch(summary, /状态：已完成/);
  });
});

test("a completed status with unavailable or failed verification is refused before writing", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    for (const status of ["unavailable", "failed"] as const)
      await assert.rejects(writeRunArtifacts(dir, sampleRun({ verification: [{ name: "x", status, evidenceRefs: [] }] })), /cannot be completed/);
    await assert.rejects(stat(dir), { code: "ENOENT" });
    await assert.rejects(writeRunArtifacts(dir, sampleRun({ status: "blocked" })), /needs a reason/);
  });
});

test("completed needs a passed verification or an explicit waiver", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    await assert.rejects(writeRunArtifacts(dir, sampleRun({ verification: [] })), /needs at least one passed verification/);
    await assert.rejects(
      writeRunArtifacts(dir, sampleRun({ verification: [{ name: "a", status: "not_run", evidenceRefs: [] }, { name: "b", status: "not_run", evidenceRefs: [] }] })),
      /needs at least one passed verification/,
    );
    await assert.rejects(
      writeRunArtifacts(dir, sampleRun({ verification: [{ name: "a", status: "passed", evidenceRefs: [] }, { name: "b", status: "not_run", evidenceRefs: [] }] })),
      /needs at least one passed verification/,
    );
    await assert.rejects(writeRunArtifacts(dir, sampleRun({ verification: [], verificationWaiver: { reason: "  " } })), /non-empty reason/);
    await assert.rejects(stat(dir), { code: "ENOENT" });

    const json = await writeRunArtifacts(dir, sampleRun({ verification: [], verificationWaiver: { reason: "问答任务，无可运行的验证" } }));
    assert.deepEqual(json.verificationWaiver, { reason: "问答任务，无可运行的验证" });
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /状态：已完成/);
    assert.match(summary, /^验证\n- 无需验证：问答任务，无可运行的验证$/m);
    assert.doesNotMatch(summary, /没有执行验证/);
  });
});

test("a write failing midway leaves no partial or temporary file", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    const failing: RunArtifactsFs = {
      mkdir: fs.mkdir,
      chmod: fs.chmod,
      rename: fs.rename,
      rm: fs.rm,
      async writeFile(path, data, options) {
        if (path.includes("summary.md")) {
          await fs.writeFile(path, data.slice(0, 5), options);
          throw Object.assign(Error("disk full"), { code: "ENOSPC" });
        }
        await fs.writeFile(path, data, options);
      },
    };
    await assert.rejects(writeRunArtifacts(dir, sampleRun(), failing), /disk full/);
    const files = await readdir(dir);
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
    assert.equal(files.includes("summary.md"), false);
    assert.equal(files.includes("run.json"), false);

    const renameFails: RunArtifactsFs = { ...fs, rename: async () => { throw Error("rename failed"); } } as RunArtifactsFs;
    const dir2 = join(root, "run-2");
    await assert.rejects(writeRunArtifacts(dir2, sampleRun(), renameFails), /rename failed/);
    assert.deepEqual((await readdir(dir2)).filter((f) => f !== "artifacts"), []);
    assert.deepEqual(await readdir(join(dir2, "artifacts")), []);
  });
});

test("a directory already holding run.json is refused by default and left untouched", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    await writeRunArtifacts(dir, sampleRun());
    const before = await Promise.all(["run.json", "summary.md", "receipts.jsonl"].map((f) => readFile(join(dir, f), "utf8")));
    await assert.rejects(writeRunArtifacts(dir, sampleRun({ task: "另一个任务" })), /already holds run\.json; pass \{ replace: true \}/);
    assert.deepEqual(await Promise.all(["run.json", "summary.md", "receipts.jsonl"].map((f) => readFile(join(dir, f), "utf8"))), before);

    await writeRunArtifacts(dir, sampleRun({ task: "另一个任务" }), fs as RunArtifactsFs, { replace: true });
    assert.match(await readFile(join(dir, "summary.md"), "utf8"), /^任务：另一个任务\n/);
  });
});

test("a replacement failing midway leaves no run.json, so the mixed set is never marked complete", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    await writeRunArtifacts(dir, sampleRun());
    const before = await readFile(join(dir, "summary.md"), "utf8");
    const failing: RunArtifactsFs = {
      ...fs,
      async writeFile(path, data, options) {
        if (!path.includes("summary.md")) return fs.writeFile(path, data, options);
        await fs.writeFile(path, data.slice(0, 5), options);
        throw Error("disk full");
      },
    } as RunArtifactsFs;
    await assert.rejects(writeRunArtifacts(dir, sampleRun({ task: "另一个任务" }), failing, { replace: true }), /disk full/);
    const files = await readdir(dir);
    assert.equal(files.includes("run.json"), false);
    assert.equal(await readFile(join(dir, "summary.md"), "utf8"), before);
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
  });
});

test("default run directory lives under the injected home, outside the workspace", () => {
  assert.equal(defaultRunDir("/home/u", "run-1"), "/home/u/.pi/agent/pi-jev-harness/runs/run-1");
});

const USAGE = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 0.012 };

test("usage totals are null with coverage whenever any source is unknown, never zero", () => {
  const usage = summarizeUsage([
    USAGE,
    { ...USAGE, inputTokens: 100, cacheWriteTokens: null, costUsd: null },
    null,
  ]);
  assert.deepEqual(usage.input, { value: null, known: 2, sources: 3 });
  assert.deepEqual(usage.cacheWrite, { value: null, known: 1, sources: 3 });
  assert.deepEqual(usage.costUsd, { value: null, known: 1, sources: 3 });

  const full = summarizeUsage([USAGE, { ...USAGE, inputTokens: 100 }]);
  assert.deepEqual(full.input, { value: 1300, known: 2, sources: 2 });
  assert.deepEqual(full.cacheWrite, { value: 0, known: 2, sources: 2 });

  assert.deepEqual(summarizeUsage([]).output, { value: null, known: 0, sources: 0 });
});

test("run.json and summary.md carry usage; unknown figures read 未知, not 0", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    const usage = summarizeUsage([USAGE, { ...USAGE, costUsd: null }]);
    await writeRunArtifacts(dir, sampleRun({ usage }));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "run.json"), "utf8")).usage, usage);
    const line = (await readFile(join(dir, "summary.md"), "utf8")).split("\n").find((l) => l.startsWith("用量："));
    assert.equal(line, "用量：输入 2400，输出 600，缓存读 1600，缓存写 0，费用 未知（1/2 个来源有数据）");

    await writeRunArtifacts(dir, sampleRun({ usage: summarizeUsage([]) }), fs as RunArtifactsFs, { replace: true });
    assert.match(await readFile(join(dir, "summary.md"), "utf8"), /^用量：输入 未知，输出 未知，缓存读 未知，缓存写 未知，费用 未知$/m);
  });
});

test("a partial usage total posing as known is refused before writing", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    const usage = summarizeUsage([USAGE, null]);
    await assert.rejects(writeRunArtifacts(dir, sampleRun({ usage: { ...usage, input: { value: 0, known: 1, sources: 2 } } })), /null exactly when/);
    await assert.rejects(stat(dir), { code: "ENOENT" });
  });
});

test("run.json is written last, after every other product", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    const renamed: string[] = [];
    const recording: RunArtifactsFs = {
      ...fs,
      async rename(from, to) {
        await fs.rename(from, to);
        renamed.push(to.slice(dir.length + 1));
      },
    } as RunArtifactsFs;
    await writeRunArtifacts(dir, sampleRun(), recording);
    assert.equal(renamed.at(-1), "run.json");
    assert.equal(renamed.length, 4);
  });
});

// structured completion and pre-existing workspace changes.
test("completion and preexistingChanges are carried into run.json and rendered in summary.md", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "run-1");
    const run = sampleRun({
      preexistingChanges: ["notes.txt"],
      completion: { status: "passed", stopAllowed: true, assessment: "acceptance", continuations: { used: 1, max: 2 } },
      reasons: ["完成验收：通过（passed）；允许结束：是；自动续跑：已用 1/2，剩余 1"],
    });
    await writeRunArtifacts(dir, run);
    const json = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    assert.deepEqual(json.completion, run.completion);
    assert.deepEqual(json.preexistingChanges, ["notes.txt"]);
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /任务开始前已有改动（不计入本次改动）\n- notes\.txt/);
    assert.match(summary, /- 完成验收：通过（passed，acceptance）；允许结束：是；自动续跑：已用 1\/2/);
    assert.match(summary, /原因\n- 完成验收：通过（passed）；允许结束：是；自动续跑：已用 1\/2，剩余 1/, "the reasons line stays");
  });
});

test("a run without completion omits the field; not_assessed renders 未进行", async () => {
  await withTemp(async (root) => {
    await writeRunArtifacts(join(root, "a"), sampleRun());
    assert.equal("completion" in JSON.parse(await readFile(join(root, "a", "run.json"), "utf8")), false);
    await writeRunArtifacts(join(root, "b"), sampleRun({ completion: { status: "not_assessed", stopAllowed: null, assessment: null, continuations: { used: 0, max: 2 } } }));
    assert.match(await readFile(join(root, "b", "summary.md"), "utf8"), /- 完成验收：未进行；自动续跑：已用 0\/2/);
  });
});

test("malformed completion or preexistingChanges is refused before writing", async () => {
  await withTemp(async (root) => {
    const bad: Partial<RunRecord>[] = [
      { completion: { status: "done" as never, stopAllowed: true, assessment: "acceptance", continuations: { used: 0, max: 2 } } },
      { completion: { status: "passed", stopAllowed: null, assessment: "acceptance", continuations: { used: 0, max: 2 } } },
      { completion: { status: "not_assessed", stopAllowed: false, assessment: null, continuations: { used: 0, max: 2 } } },
      { completion: { status: "incomplete", stopAllowed: false, assessment: "foreman", continuations: { used: 3, max: 2 } } },
      { preexistingChanges: [""] },
    ];
    for (const [i, overrides] of bad.entries()) {
      const dir = join(root, `bad-${i}`);
      await assert.rejects(writeRunArtifacts(dir, sampleRun(overrides)), Error, `case ${i}`);
      await assert.rejects(readdir(dir), { code: "ENOENT" });
    }
  });
});

test("T045 E7 / T051: tool routing outcome is carried into run.json and rendered as one 路由 line; malformed routing is refused", async () => {
  await withTemp(async (root) => {
    const routing = {
      tools: { outcome: "applied" as const, tools: ["read", "bash", "edit"], resident: ["read", "bash"] },
    };
    const dir = join(root, "ok");
    const json = await writeRunArtifacts(dir, sampleRun({ routing }));
    assert.deepEqual(json.routing, routing);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "run.json"), "utf8")).routing, routing);
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /^路由：工具 已应用（read,bash,edit；常驻：read,bash）$/m);
    const none = join(root, "none");
    assert.equal((await writeRunArtifacts(none, sampleRun())).routing, undefined);
    assert.doesNotMatch(await readFile(join(none, "summary.md"), "utf8"), /路由：/);
    for (const [i, bad] of [{ tools: { outcome: "maybe" } }, {}, { tools: { outcome: "off", tools: [1] } }].entries()) {
      const target = join(root, `bad-${i}`);
      await assert.rejects(writeRunArtifacts(target, sampleRun({ routing: bad as never })), /Routing/);
      await assert.rejects(readdir(target), { code: "ENOENT" });
    }
  });
});
