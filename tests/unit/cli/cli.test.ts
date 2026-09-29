import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../src/cli/main.ts";
import type { CliDeps } from "../../../src/cli/context.ts";
import { WORKSPACE_SNAPSHOT_VERSION, workspaceSnapshot } from "../../../src/cli/replay.ts";
import { recordToolResult, summarizeChangeset } from "../../../src/harness/evidence.ts";
import { createRuntimeReceipt } from "../../../src/harness/receipt.ts";
import { summarizeUsage, writeRunArtifacts, type RunRecord } from "../../../src/harness/run-artifacts.ts";
import { createTelemetryWriter } from "../../../src/telemetry/index.ts";
import { containsCredential } from "../../../src/adapters/pi/config.ts";
import { EXPECTED_REGISTRATIONS, PINNED_PI_VERSION } from "../../../src/cli/doctor.ts";
import { REDACTED, commandBinary } from "../../../src/cli/export.ts";

const KEY = "tsk-cli-test-secret-value-0123456789";

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-cli-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface Harness {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  execCalls: string[][];
}

function harness(root: string, overrides: Partial<CliDeps> = {}): Harness {
  let out = "";
  let err = "";
  const execCalls: string[][] = [];
  const deps: CliDeps = {
    env: {},
    home: join(root, "home"),
    cwd: root,
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    execFile: (command, args) => {
      execCalls.push([command, ...args]);
      return "0.87.1\n";
    },
    ...overrides,
  };
  return { deps, out: () => out, err: () => err, execCalls };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A workspace with one changed file and a run directory whose single receipt binds it. */
async function makeRun(root: string, overrides: Partial<RunRecord> = {}): Promise<{ dir: string; workspace: string }> {
  const workspace = join(root, "ws");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "page.js"), "export const page = 1;\n");
  const snapshot = await workspaceSnapshot(workspace, ["src/page.js"]);
  assert.ok("digest" in snapshot);
  const { evidence, artifact } = recordToolResult(
    { actionId: "act-1", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "1 passed" }], startedAt: 0, endedAt: 5 },
    { artifacts: "full" },
  );
  const receipt = createRuntimeReceipt({
    runId: "run-1", sessionId: "sess-1", branchId: "br-1", generation: 2, actionId: "act-1",
    snapshot: { digest: snapshot.digest, version: WORKSPACE_SNAPSHOT_VERSION },
    execution: { status: "executed", reason: null, evidence: [evidence] },
    verification: { status: "passed", evidenceRefs: ["call-1"], note: null },
  });
  const dir = join(root, "runs", "run-1");
  await writeRunArtifacts(dir, {
    runId: "run-1",
    task: "修复分页",
    status: "completed",
    workspace,
    changes: summarizeChangeset({ "src/page.js": sha("old") }, { "src/page.js": sha("export const page = 1;\n") }),
    verification: [{ name: "单元测试", status: "passed", evidenceRefs: ["call-1"] }],
    reasons: [],
    remaining: [],
    receipts: [receipt],
    artifacts: artifact ? [artifact] : [],
    usage: summarizeUsage([null]),
    ...overrides,
  });
  return { dir, workspace };
}

async function trustedFile(root: string, extra: Record<string, unknown> = {}): Promise<string> {
  const path = join(root, "trusted.json");
  await writeFile(path, JSON.stringify({ sessionId: "sess-1", branchId: "br-1", generation: 2, actions: { "act-1": { request: null, response: null, authorizationRef: null, ...extra } } }));
  return path;
}

test("report exit code follows run.json status: completed 0, incomplete and verification_unavailable 2", async () => {
  await withTemp(async (root) => {
    const cases = [
      ["completed", {}, 0, "状态：已完成（completed）"],
      ["incomplete", { status: "incomplete", verification: [], remaining: ["补回归测试"] }, 2, "状态：已结束，仍未完成（incomplete）"],
      ["verification_unavailable", { status: "verification_unavailable", verification: [{ name: "单元测试", status: "unavailable", evidenceRefs: [] }] }, 2, "状态：已结束，完成验收不可用（verification_unavailable）"],
    ] as const;
    for (const [name, overrides, code, label] of cases) {
      const { dir } = await makeRun(join(root, name), overrides as Partial<RunRecord>);
      const h = harness(root);
      assert.equal(await main(["report", dir], h.deps), code, name);
      assert.match(h.out(), new RegExp(label.replace(/[()]/g, "\\$&")));
      assert.match(h.out(), /用量：输入 未知（0\/1 个来源有数据），输出 未知/);
      assert.match(h.out(), /任务：修复分页/);
    }
  });
});

test("report --json prints run.json byte for byte and keeps the status exit code", async () => {
  await withTemp(async (root) => {
    const { dir } = await makeRun(root, { status: "incomplete", verification: [], remaining: ["x"] });
    const h = harness(root);
    assert.equal(await main(["report", "--json", dir], h.deps), 2);
    assert.equal(h.out(), await readFile(join(dir, "run.json"), "utf8"));
  });
});

test("report without run.json says the products are incomplete and exits non-zero", async () => {
  await withTemp(async (root) => {
    const { dir } = await makeRun(root);
    await rm(join(dir, "run.json"));
    const h = harness(root);
    assert.equal(await main(["report", dir], h.deps), 1);
    assert.equal(h.out(), "");
    assert.match(h.err(), /产物不完整/);
  });
});

test("report --telemetry aggregates the local directory; skipped lines are counted, never echoed", async () => {
  await withTemp(async (root) => {
    const dir = join(root, "telemetry");
    await mkdir(dir);
    const writer = createTelemetryWriter({ dir, now: () => 1000 });
    const run = "run_00000000-0000-4000-8000-000000000001";
    assert.equal(await writer.record({ runId: run, decisionId: "dec_00000000-0000-4000-8000-000000000002", kind: "diagnostic", outcome: "skipped", durationMs: 7, source: "adapter:duplicate_load" }), true);
    await writeFile(join(dir, "events.jsonl"), `${await readFile(join(dir, "events.jsonl"), "utf8")}{"secret task body"}\n`);
    const h = harness(root);
    assert.equal(await main(["report", "--telemetry", dir], h.deps), 0);
    assert.match(h.out(), /事件 1，跳过 1/);
    assert.match(h.out(), /diagnostic \/ skipped：1 次/);
    assert.doesNotMatch(h.out(), /secret task body/);
  });
});

test("replay: untouched receipt matches, one flipped byte is a mismatch (exit 3), nothing is executed", async () => {
  await withTemp(async (root) => {
    const { dir, workspace } = await makeRun(root);
    const trusted = await trustedFile(root, { execution: { status: "executed" }, verification: { status: "passed" } });
    const before = await readFile(join(workspace, "src", "page.js"), "utf8");

    const clean = harness(root);
    assert.equal(await main(["replay", dir, "--trusted", trusted], clean.deps), 0);
    assert.match(clean.out(), /#1 act-1：match/);
    assert.match(clean.out(), /sha256 只做完整性核对/);

    const receipts = join(dir, "receipts.jsonl");
    const text = await readFile(receipts, "utf8");
    const at = text.indexOf("1 passed");
    await writeFile(receipts, `${text.slice(0, at)}2${text.slice(at + 1)}`);
    const tampered = harness(root);
    assert.equal(await main(["replay", receipts, "--trusted", trusted], tampered.deps), 3);
    assert.match(tampered.out(), /#1 act-1：mismatch\n {2}- 不一致：Receipt digest mismatch\./);

    assert.deepEqual([...clean.execCalls, ...tampered.execCalls], []);
    assert.equal(await readFile(join(workspace, "src", "page.js"), "utf8"), before);
  });
});

test("replay without a trusted file reports the unsourced bindings as cannot_verify, exit 0", async () => {
  await withTemp(async (root) => {
    const { dir } = await makeRun(root);
    const h = harness(root);
    assert.equal(await main(["replay", dir], h.deps), 0);
    assert.match(h.out(), /#1 act-1：cannot_verify\n {2}- 缺少可信来源：sessionId、branchId、generation、actionId\n/);
    assert.match(h.out(), /执行\/验证状态未核对/);
  });
});

test("replay compares the workspace and the retained artifact, not the receipt's own values", async () => {
  await withTemp(async (root) => {
    const { dir, workspace } = await makeRun(root);
    const trusted = await trustedFile(root);

    await writeFile(join(workspace, "src", "page.js"), "export const page = 2;\n");
    const drifted = harness(root);
    assert.equal(await main(["replay", dir, "--trusted", trusted], drifted.deps), 3);
    assert.match(drifted.out(), /snapshot differs from the trusted current state/);
    await writeFile(join(workspace, "src", "page.js"), "export const page = 1;\n");

    const [artifact] = await readdir(join(dir, "artifacts"));
    await writeFile(join(dir, "artifacts", artifact!), "1 failed");
    const edited = harness(root);
    assert.equal(await main(["replay", dir, "--trusted", trusted], edited.deps), 3);
    assert.match(edited.out(), /Output of call-1 differs from the recorded digest/);

    await rm(join(dir, "artifacts", artifact!));
    await rm(join(dir, "run.json"));
    const bare = harness(root);
    assert.equal(await main(["replay", dir, "--trusted", trusted], bare.deps), 0);
    assert.match(bare.out(), /产物不完整/);
    assert.match(bare.out(), /缺少可信来源：runId、snapshot、outputs\.call-1/);
  });
});

test("replay: a trusted file cannot stand in for run.json, the workspace, or artifacts", async () => {
  await withTemp(async (root) => {
    const { dir } = await makeRun(root);
    await rm(join(dir, "run.json"));
    const trusted = await trustedFile(root, { runId: "run-1", snapshot: { digest: "0".repeat(64), version: WORKSPACE_SNAPSHOT_VERSION }, outputs: { "call-1": "0".repeat(64) } });
    const h = harness(root);
    assert.equal(await main(["replay", dir, "--trusted", trusted], h.deps), 0);
    assert.match(h.out(), /缺少可信来源：runId、snapshot/);
  });
});

test("doctor reports config state and key presence without printing the key, and removes its probe files", async () => {
  await withTemp(async (root) => {
    const home = join(root, "home");
    const agent = join(home, ".pi", "agent");
    await mkdir(join(agent, "pi-jev-harness", "runs"), { recursive: true });
    const configPath = join(root, "config.json");
    const states: [string | null, RegExp][] = [
      [null, /配置：缺失/],
      ['{"mode":"shadow"}', /配置：有效.*生效 mode shadow/],
      ["{not json", /配置：损坏.*config file is not valid JSON/],
      ['{"mode":"on"}', /配置：损坏.*mode on has not passed/],
    ];
    for (const [content, expected] of states) {
      if (content === null) await rm(configPath, { force: true });
      else await writeFile(configPath, content);
      const h = harness(root, { env: { TYPESAFE_API_KEY: KEY }, configPath });
      assert.equal(await main(["doctor"], h.deps), 0);
      assert.match(h.out(), expected);
      assert.match(h.out(), /TYPESAFE_API_KEY：已设置/);
      assert.match(h.out(), /Pi：0\.87\.1/);
      assert.match(h.out(), /运行产物目录：可写/);
      assert.match(h.out(), /telemetry 目录：可写（.*尚不存在/);
      assert.ok(!h.out().includes(KEY));
      const json = harness(root, { env: { TYPESAFE_API_KEY: KEY }, configPath });
      await main(["doctor", "--json"], json.deps);
      assert.ok(!json.out().includes(KEY));
      assert.equal(JSON.parse(json.out()).jevKey.present, true);
    }
    assert.deepEqual(await readdir(join(agent, "pi-jev-harness")), ["runs"]);
    assert.deepEqual(await readdir(join(agent, "pi-jev-harness", "runs")), []);

    const unset = harness(root);
    await main(["doctor"], unset.deps);
    assert.match(unset.out(), /TYPESAFE_API_KEY：未设置/);
  });
});

test("doctor flags the extension loaded both from the extensions directory and settings", async () => {
  await withTemp(async (root) => {
    const agent = join(root, "home", ".pi", "agent");
    const pkg = join(root, "harness");
    await mkdir(join(pkg, "src", "adapters", "pi"), { recursive: true });
    await mkdir(join(agent, "extensions"), { recursive: true });
    await writeFile(join(pkg, "src", "adapters", "pi", "index.ts"), "export {};\n");

    const once = harness(root);
    await symlink(pkg, join(agent, "extensions", "jev"));
    await main(["doctor"], once.deps);
    assert.match(once.out(), /扩展：加载一次/);

    await writeFile(join(agent, "settings.json"), JSON.stringify({ extensions: [join(pkg, "src", "adapters", "pi", "index.ts"), "./other.ts"] }));
    const twice = harness(root);
    await main(["doctor", "--json"], twice.deps);
    const report = JSON.parse(twice.out());
    assert.equal(report.extension.status, "fail");
    assert.equal(report.extension.loads.length, 2);
  });
});

test("doctor reports an unavailable pi without failing the command", async () => {
  await withTemp(async (root) => {
    const h = harness(root, {
      execFile: () => {
        throw Error("spawn pi ENOENT");
      },
    });
    assert.equal(await main(["doctor"], h.deps), 0);
    assert.match(h.out(), /Pi：不可用（spawn pi ENOENT）/);
  });
});

const SECRET_CHECK = "API_KEY=sk-live-0123456789abcdef npm test -- --grep pagination";

/** A run inside the home directory whose free text carries a credential, the task, tool args and output. */
async function makeSensitiveRun(root: string): Promise<{ dir: string; home: string }> {
  const home = join(root, "home");
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const ok = recordToolResult(
    { actionId: "act-1", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "RAW-FILE-CONTENT const x = 1;" }], startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_010 },
    { artifacts: "none" },
  );
  const bad = recordToolResult(
    { actionId: "act-2", toolCallId: "call-2", toolName: "bash", isError: true, details: { exitCode: 1 }, content: [{ type: "text", text: "RAW-OUTPUT 1 failing" }], startedAt: 1_700_000_000_020, endedAt: 1_700_000_000_090 },
    { artifacts: "none" },
  );
  const base = { runId: "run-s", sessionId: "sess-1", branchId: "br-1", generation: 1, snapshot: { digest: sha("snap"), version: "v1" } };
  const receipts = [
    createRuntimeReceipt({ ...base, actionId: "act-1", execution: { status: "executed", reason: null, evidence: [ok.evidence] },
      request: { digest: sha("req"), version: "jev" }, response: { digest: sha("res"), version: "jev" } }),
    createRuntimeReceipt({ ...base, actionId: "act-2",
      execution: { status: "failed", reason: `tool result error (exit code 1); shadow review deny: cat ${home}/.env | grep password=hunter2hunter2`, evidence: [bad.evidence] },
      verification: { status: "failed", evidenceRefs: ["call-2"], note: SECRET_CHECK } }),
  ];
  const dir = join(root, "runs", "run-s");
  await writeRunArtifacts(dir, {
    runId: "run-s",
    task: "修复分页 SECRET-TASK-TEXT",
    status: "incomplete",
    workspace,
    changes: summarizeChangeset({ "src/page.js": sha("old") }, { "src/page.js": sha("new"), "src/new.js": sha("n") }),
    verification: [{ name: SECRET_CHECK, status: "failed", evidenceRefs: ["call-2"] }],
    reasons: [`stale: ${home}/ws/src/page.js changed since read`],
    remaining: [`检查未通过：${SECRET_CHECK}`],
    receipts,
    artifacts: [],
    usage: summarizeUsage([{ inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null }]),
  });
  return { dir, home };
}

test("report --export writes a share file without credentials, task text, tool args, outputs or home paths", async () => {
  await withTemp(async (root) => {
    const { dir, home } = await makeSensitiveRun(root);
    const h = harness(root, { home, env: { TYPESAFE_API_KEY: KEY } });
    assert.equal(await main(["report", dir, "--export", "share.json", "--export-md", "share.md"], h.deps), 2);
    assert.match(h.out(), /已导出分享报告：.*share\.json\n已导出分享报告：.*share\.md\n/);
    for (const file of ["share.json", "share.md"]) {
      const text = await readFile(join(root, file), "utf8");
      assert.equal(containsCredential(text, KEY), false, file);
      for (const banned of ["SECRET-TASK-TEXT", "修复分页", "--grep", "pagination", "sk-live", "hunter2", ".env", "RAW-OUTPUT", "RAW-FILE-CONTENT", home, sha("new"), "\"command\"", "arguments"])
        assert.ok(!text.includes(banned), `${file} contains ${banned}`);
    }
    const x = JSON.parse(await readFile(join(root, "share.json"), "utf8"));
    assert.equal(x.schema, "pi-jev-share-export-v1");
    assert.equal(x.runId, "run-s");
    assert.equal(x.status, "incomplete");
    assert.equal(x.workspace, "~/ws");
    assert.deepEqual([...x.changes].sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)), [
      { path: "src/new.js", change: "added" },
      { path: "src/page.js", change: "modified" },
    ]);
    assert.deepEqual(x.verification, [{ binary: "npm", status: "failed", exitCodes: [1] }]);
    assert.deepEqual(x.usage.input, { value: 10, known: 1, sources: 1 });
    assert.deepEqual(x.usage.costUsd, { value: null, known: 0, sources: 1 });
    assert.equal(x.decisions.receipts, 2);
    assert.equal(x.decisions.jevRequests, 1);
    assert.equal(x.decisions.jevResponses, 1);
    assert.equal(x.decisions.execution.failed, 1);
    assert.equal(x.decisions.execution.executed, 1);
    assert.deepEqual(x.fallbackReasons.map((r: { label: string }) => r.label).sort(), ["shadow review deny", "stale", "tool result error (exit code 1)"]);
    assert.deepEqual(x.remaining, [{ label: "检查未通过", count: 1 }]);
    assert.equal(x.timestamps.firstActionAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(x.timestamps.lastActionAt, new Date(1_700_000_000_090).toISOString());
    assert.equal(x.harness.mode, "shadow");
  });
});

test("report --export refuses an existing file unless --force, and leaves it untouched", async () => {
  await withTemp(async (root) => {
    const { dir } = await makeRun(root);
    await writeFile(join(root, "out.json"), "keep");
    const refused = harness(root);
    assert.equal(await main(["report", dir, "--export", "out.json"], refused.deps), 1);
    assert.match(refused.err(), /导出文件已存在.*--force/);
    assert.equal(await readFile(join(root, "out.json"), "utf8"), "keep");
    // A refused second target writes neither file.
    const both = harness(root);
    assert.equal(await main(["report", dir, "--export-md", "new.md", "--export", "out.json"], both.deps), 1);
    await assert.rejects(readFile(join(root, "new.md")), { code: "ENOENT" });
    const forced = harness(root);
    assert.equal(await main(["report", dir, "--export", "out.json", "--force"], forced.deps), 0);
    assert.equal(JSON.parse(await readFile(join(root, "out.json"), "utf8")).runId, "run-1");
  });
});

test("report --export without run.json exits 1 and writes nothing; bad flag combinations are usage errors", async () => {
  await withTemp(async (root) => {
    const { dir } = await makeRun(root);
    await rm(join(dir, "run.json"));
    const h = harness(root);
    assert.equal(await main(["report", dir, "--export", "out.json"], h.deps), 1);
    assert.match(h.err(), /产物不完整/);
    await assert.rejects(readFile(join(root, "out.json")), { code: "ENOENT" });
    for (const argv of [["report", dir, "--force"], ["report", dir, "--export", "a.json", "--json"], ["report", "--telemetry", "--export", "a.json"], ["doctor", "--force"], ["replay", dir, "--export", "a.json"]]) {
      const u = harness(root);
      assert.equal(await main(argv, u.deps), 1, argv.join(" "));
      assert.match(u.err(), /用法：/);
    }
  });
});

test("share export helpers: binary name drops env assignments and paths; credential-bearing strings are redacted", () => {
  assert.equal(commandBinary("API_KEY=x FOO=y ./node_modules/.bin/tsc --noEmit"), "tsc");
  assert.equal(commandBinary("单元测试"), "单元测试");
  assert.ok(REDACTED.length > 0 && !containsCredential(REDACTED, undefined));
});

test("doctor: Pi version is compared with the pinned version; a mismatch warns without failing", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies["@earendil-works/pi-coding-agent"], PINNED_PI_VERSION);
  await withTemp(async (root) => {
    const same = harness(root, { execFile: () => "pi 0.87.1\n" });
    assert.equal(await main(["doctor", "--json"], same.deps), 0);
    assert.deepEqual(JSON.parse(same.out()).pi, { status: "ok", version: "0.87.1", pinned: "0.87.1", matchesPinned: true });
    const other = harness(root, { execFile: () => "0.88.2\n" });
    assert.equal(await main(["doctor"], other.deps), 0);
    assert.match(other.out(), /Pi：0\.88\.2（警告：与固定版本 0\.87\.1 不一致）/);
    const garbled = harness(root, { execFile: () => "dev build\n" });
    await main(["doctor", "--json"], garbled.deps);
    assert.equal(JSON.parse(garbled.out()).pi.matchesPinned, null);
    assert.equal(JSON.parse(garbled.out()).pi.status, "warn");
  });
});

test("doctor: tool registration lists what the extension registers against a fake registry and marks missing names", async () => {
  await withTemp(async (root) => {
    const fake = harness(root, {
      loadExtension: async () => (pi) => {
        pi.registerTool({ name: "jev_recall" } as Parameters<typeof pi.registerTool>[0]);
        pi.registerTool({ name: "extra_tool" } as Parameters<typeof pi.registerTool>[0]);
        pi.registerCommand("jev", { handler: async () => {} });
        pi.on("session_start", () => {});
      },
    });
    assert.equal(await main(["doctor", "--json"], fake.deps), 0);
    const reg = JSON.parse(fake.out()).registration;
    assert.equal(reg.status, "warn");
    assert.deepEqual(reg.tools, ["jev_recall", "extra_tool"]);
    assert.deepEqual(reg.commands, ["jev"]);
    assert.deepEqual(reg.events, ["session_start"]);
    assert.deepEqual(reg.expected.filter((e: { registered: boolean }) => e.registered).map((e: { name: string }) => e.name), ["jev_recall", "jev"]);
    const text = harness(root, { loadExtension: fake.deps.loadExtension! });
    await main(["doctor"], text.deps);
    assert.match(text.out(), /工具注册：扩展注册了 2 个工具、1 个命令、1 个事件（部分预期项未注册）/);
    assert.match(text.out(), /  - jev_route：未注册\n/);
    assert.match(text.out(), /  - jev_recall：已注册\n/);
    assert.match(text.out(), /  - \/jev：已注册\n/);
    assert.match(text.out(), /  - 预期外：extra_tool\n/);

    const broken = harness(root, { loadExtension: async () => { throw Error("boom"); } });
    assert.equal(await main(["doctor"], broken.deps), 0);
    assert.match(broken.out(), /工具注册：扩展无法加载（boom）/);
  });
});

test("doctor: the real extension entry registers in-process without starting a session or leaking the key", async () => {
  await withTemp(async (root) => {
    const h = harness(root, { env: { TYPESAFE_API_KEY: KEY } });
    assert.equal(await main(["doctor", "--json"], h.deps), 0);
    assert.ok(!h.out().includes(KEY));
    const reg = JSON.parse(h.out()).registration;
    assert.notEqual(reg.status, "fail");
    assert.ok(reg.commands.includes("jev"));
    assert.ok(reg.events.includes("session_start"));
    assert.equal(reg.expected.length, EXPECTED_REGISTRATIONS.tools.length + EXPECTED_REGISTRATIONS.commands.length);
  });
});

test("T051: doctor keeps a config with a legacy router.models valid and shows one ignore note", async () => {
  await withTemp(async (root) => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ mode: "shadow", router: { tools: "shadow", models: { mode: "on", allow: ["p/m"] } } }));
    const json = harness(root, { configPath });
    assert.equal(await main(["doctor", "--json"], json.deps), 0);
    const config = JSON.parse(json.out()).config;
    assert.equal(config.state, "valid");
    assert.deepEqual(config.notes, ["router.models 配置已忽略（模型路由由 magpie 负责）"]);
    const text = harness(root, { configPath });
    await main(["doctor"], text.deps);
    assert.equal(text.out().split("\n").filter((line) => line === "配置提示：router.models 配置已忽略（模型路由由 magpie 负责）").length, 1);
    await writeFile(configPath, JSON.stringify({ mode: "shadow", router: { tools: "shadow" } }));
    const clean = harness(root, { configPath });
    await main(["doctor", "--json"], clean.deps);
    assert.equal(JSON.parse(clean.out()).config.notes, undefined);
  });
});
