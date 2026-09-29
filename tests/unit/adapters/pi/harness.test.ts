import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../../../src/adapters/pi/config.ts";
import { JEV_URL, KEY, fakeFetch, fakePi, harness, load, settled, validAnswer, type FakePi, type Harness, type JevRequest } from "./fake-host.ts";

const TASK = "Add a greeting helper to the workspace";
/** Yes probability per review question: every answer favorable at 0.95. */
const PERMIT: Record<string, number> = { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05 };

/** Noul review answers; a Choice request (the completion `done` question) is accepted. */
function noulAnswer(request: JevRequest): Response {
  if (Object.values(request.body.questions).some((question) => question.type === "choice")) return validAnswer(request);
  const answers = Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: "noul", noul: PERMIT[id] ?? 0.5 }]));
  return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
}

interface Receipt {
  receipt: {
    actionId: string;
    request: unknown;
    response: unknown;
    execution: { status: string; reason: string | null; evidence: { toolCallId: string; toolName: string; outcome: string; exitCode: number | null; output: { head: string[] } }[] };
    verification: { status: string; evidenceRefs: string[]; note: string | null };
  };
}

interface Session {
  h: Harness;
  fake: FakePi;
  jev: ReturnType<typeof fakeFetch>;
  ws: string;
  runsDir: string;
  call(toolName: string, input: Record<string, unknown>, toolCallId: string): Promise<unknown>;
  result(toolCallId: string, toolName: string, text: string, isError?: boolean): Promise<void>;
  settle(): Promise<void>;
  /** Pi's final actionable boundary (the completion checkpoint), then an assistant answer when given. */
  beforeSettle(answer?: string): Promise<unknown>;
  products(): Promise<{ run: Record<string, unknown>; receipts: Receipt[]; summary: string }[]>;
}

/** A fake Pi session over a temp workspace holding `src/app.js`; config written only when given. */
async function session(
  config: Record<string, unknown> | null,
  responder: Parameters<typeof fakeFetch>[0] = noulAnswer,
  extraEnv: Record<string, string> = {},
  /** Prepares the workspace (for example a git repository) before the task starts. */
  prepare?: (ws: string) => Promise<void>,
  /** Switch the session to `on` before the task (only `on` blocks enforced kinds). */
  on = false,
): Promise<Session> {
  const h = await harness();
  const ws = join(h.dir, "ws");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "app.js"), "export const answer = 41;\n");
  if (config) await writeFile(h.configPath, JSON.stringify(config));
  await prepare?.(ws);
  const jev = fakeFetch(responder);
  const fake = fakePi({ cwd: ws });
  load(fake, h.deps({ fetch: jev.fetch, env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL, ...extraEnv } }));
  await fake.emit("session_start", { reason: "startup" });
  if (on) await fake.command("mode on");
  await fake.emit("before_agent_start", { prompt: TASK });
  const runsDir = join(h.dir, ".pi", "agent", "pi-jev-harness", "runs");
  return {
    h, fake, jev, ws, runsDir,
    async call(toolName, input, toolCallId) {
      const results = await fake.emit("tool_call", { toolName, toolCallId, input });
      assert.equal(results.length, 1, "one tool_call handler");
      return results[0];
    },
    async result(toolCallId, toolName, text, isError = false) {
      await fake.emit("tool_result", { toolCallId, toolName, input: {}, content: [{ type: "text", text }], isError, details: undefined });
    },
    async settle() {
      await fake.emit("agent_settled", {});
    },
    async beforeSettle(answer) {
      if (answer !== undefined) await fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: answer }] } });
      const [result] = await fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: { pendingMessages: [] } });
      return result;
    },
    async products() {
      const names = await readdir(runsDir).catch(() => [] as string[]);
      return Promise.all(names.sort().map(async (name) => ({
        run: JSON.parse(await readFile(join(runsDir, name, "run.json"), "utf8")) as Record<string, unknown>,
        receipts: (await readFile(join(runsDir, name, "receipts.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Receipt),
        summary: await readFile(join(runsDir, name, "summary.md"), "utf8"),
      })));
    },
  };
}

function shadowConfig(harnessConfig: Record<string, unknown> = {}, taskIntent = true) {
  // Routers off: every Jev request in these tests is an action review.
  return { mode: "shadow", outbound: { taskIntent }, router: { tools: false }, harness: harnessConfig };
}

test("off: no envelope, no review, no run products", async () => {
  const s = await session(null);
  try {
    assert.equal(await s.call("write", { path: "src/new.js", content: "x\n" }, "c1"), undefined);
    await s.result("c1", "write", "ok");
    await s.settle();
    assert.equal(s.jev.requests.length, 0);
    await assert.rejects(readdir(s.runsDir), { code: "ENOENT" });
    const status = await s.fake.command("status");
    assert.match(status, /harness: off/);
    assert.match(status, /harness actions this session: 0 /);
    assert.match(status, /harness run products: none yet \(next: .*<generated run id>\)/);
  } finally { await s.h.cleanup(); }
});

test("shadow: every tool_call resolves to undefined, valid or not; reviews follow local validation", async () => {
  const s = await session(shadowConfig());
  try {
    const calls: [string, Record<string, unknown>][] = [
      ["read", { path: "src/app.js" }],
      ["write", { path: "src/greet.js", content: "export const greet = () => 'hi';\n" }],
      ["edit", { path: "src/app.js", edits: [{ oldText: "41", newText: "42" }] }],
      ["bash", { command: "ls" }],
      ["write", { path: "src/app.js", content: "replaced\n" }],
      ["edit", { path: "src/app.js", edits: [{ oldText: "not there", newText: "x" }] }],
      ["delete", { path: "src/app.js" }],
    ];
    for (const [index, [tool, input]] of calls.entries()) assert.equal(await s.call(tool, input, `c${index}`), undefined, `${tool} #${index}`);
    for (const [index, [tool]] of calls.entries()) await s.result(`c${index}`, tool, "done");
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.receipts.length, calls.length);
    // Only the valid create and the valid edit were reviewed.
    assert.equal(s.jev.requests.length, 2);
    assert.deepEqual(s.jev.requests.map((r) => (r.body.state.action as { kind: string }).kind).sort(), ["create", "edit"]);
    // The edit review carries the preimage the adapter read before the tool ran (diff + excerpt).
    const edit = s.jev.requests.find((r) => (r.body.state.action as { kind: string }).kind === "edit")!;
    assert.match((edit.body.state.action as { diff: string }).diff, /^-export const answer = 41;$/m);
    assert.equal((edit.body.state.preimageExcerpt as { path: string }).path, "src/app.js");
    assert.match(JSON.stringify(edit.body.state.preimageExcerpt), /answer = 41/);
    const reasons = product!.receipts.map((r) => r.receipt.execution.reason ?? "");
    assert.match(reasons[4]!, /validation failed \(shadow; not blocked\): .*already exists/);
    assert.match(reasons[5]!, /validation failed \(shadow; not blocked\): .*matches 0 times/);
    assert.match(reasons[6]!, /validation failed \(shadow; not blocked\): unsupported action/);
    assert.ok(product!.receipts.every((r) => r.receipt.execution.status === "executed"), "shadow never blocks");
    assert.match(await s.fake.command("status"), /harness actions this session: 7 \(validation failed 3, blocked 0, reviews sent 2\)/);
  } finally { await s.h.cleanup(); }
});

test("an out-of-root write is recorded in shadow and blocked by enforced(create) in on; neither contacts Jev", async () => {
  const shadow = await session(shadowConfig());
  const enforced = await session(shadowConfig({ enforce: ["create"] }), noulAnswer, {}, undefined, true);
  try {
    const input = { path: "../outside.js", content: "x\n" };
    assert.equal(await shadow.call("write", input, "w1"), undefined);
    await shadow.result("w1", "write", "ok");
    await shadow.settle();
    const [shadowRun] = await shadow.products();
    assert.equal(shadowRun!.receipts[0]!.receipt.execution.status, "executed");
    assert.match(shadowRun!.receipts[0]!.receipt.execution.reason!, /validation failed \(shadow; not blocked\): .*outside the allowed roots/);
    assert.equal(shadow.jev.requests.length, 0);

    const blocked = await enforced.call("write", input, "w1") as { block: boolean; reason: string };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /validation failed: .*outside the allowed roots/);
    await enforced.settle();
    const [enforcedRun] = await enforced.products();
    assert.equal(enforcedRun!.receipts[0]!.receipt.execution.status, "blocked");
    assert.equal(enforcedRun!.receipts[0]!.receipt.request, null);
    assert.equal(enforcedRun!.run.status, "blocked");
    assert.equal(enforced.jev.requests.length, 0);
  } finally { await shadow.h.cleanup(); await enforced.h.cleanup(); }
});

test("enforced(create): a permitted create whose target appears during review is blocked as stale", async () => {
  let wsDir = "";
  const s = await session(shadowConfig({ enforce: ["create"] }), async (request) => {
    const path = (request.body.state.action as { path: string }).path;
    if (path === "src/raced.js") await writeFile(join(wsDir, path), "written by someone else\n");
    return noulAnswer(request);
  }, {}, undefined, true);
  wsDir = s.ws;
  try {
    assert.equal(await s.call("write", { path: "src/calm.js", content: "export {};\n" }, "ok1"), undefined, "permit on an unchanged target executes");
    const result = await s.call("write", { path: "src/raced.js", content: "export {};\n" }, "raced") as { block: boolean; reason: string };
    assert.equal(result.block, true);
    assert.match(result.reason, /stale: .*raced\.js was created since the action was built/);
    assert.equal(await readFile(join(s.ws, "src", "raced.js"), "utf8"), "written by someone else\n");
    assert.equal(s.jev.requests.length, 2);
    await s.result("ok1", "write", "ok");
    await s.settle();
    const [product] = await s.products();
    const raced = product!.receipts[1]!.receipt;
    assert.equal(raced.execution.status, "blocked");
    assert.match(raced.execution.reason!, /^stale: /);
    assert.notEqual(raced.response, null, "the permit that preceded the stale check is on record");
  } finally { await s.h.cleanup(); }
});

test("enforced(create): an unavailable review blocks, whether Jev fails or outbound is not allowed", async () => {
  const down = await session(shadowConfig({ enforce: ["create"] }), () => new Response("down", { status: 503 }), {}, undefined, true);
  const closed = await session(shadowConfig({ enforce: ["create"] }, false), noulAnswer, {}, undefined, true);
  try {
    const failed = await down.call("write", { path: "src/a.js", content: "x\n" }, "w1") as { block: boolean; reason: string };
    assert.equal(failed.block, true);
    assert.match(failed.reason, /Enforced review unavailable/);
    assert.equal(down.jev.requests.length, 1);
    const withheld = await closed.call("write", { path: "src/a.js", content: "x\n" }, "w1") as { block: boolean; reason: string };
    assert.equal(withheld.block, true);
    assert.match(withheld.reason, /Enforced review unavailable: outbound\.taskIntent=false/);
    assert.equal(closed.jev.requests.length, 0);
    await assert.rejects(readFile(join(down.ws, "src", "a.js")), { code: "ENOENT" });
  } finally { await down.h.cleanup(); await closed.h.cleanup(); }
});

test("H1: shadow never blocks an enforced kind; it records the block on would cause (validation and review)", async () => {
  const deny = (request: JevRequest) => new Response(JSON.stringify({ model: request.body.model,
    answers: Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: "noul", noul: 0.01 }])) }), { status: 200, headers: { "content-type": "application/json" } });
  const s = await session(shadowConfig({ enforce: ["create"] }), deny);
  try {
    assert.equal(await s.call("write", { path: "../outside.js", content: "x\n" }, "w1"), undefined, "invalid create is not blocked in shadow");
    assert.equal(await s.call("write", { path: "src/new.js", content: "x\n" }, "w2"), undefined, "a non-permit review does not block in shadow");
    await s.result("w1", "write", "ok");
    await s.result("w2", "write", "ok");
    await s.settle();
    const [product] = await s.products();
    const receipts = product!.receipts.map((r) => r.receipt.execution);
    assert.deepEqual(receipts.map((r) => r.status), ["executed", "executed"]);
    assert.match(receipts[0]!.reason!, /would be blocked in on \(shadow; not blocked\): validation failed: .*outside the allowed roots/);
    assert.match(receipts[1]!.reason!, /would be blocked in on \(shadow; not blocked\): /);
    assert.notEqual(product!.run.status, "blocked");
    const status = await s.fake.command("status");
    assert.match(status, /blocked 0, would block in on 2,/);
    assert.match(status, /强制评审：仅观察（shadow 不拦截：create）/);
    // The same session switched to on blocks the next invalid create.
    await s.fake.command("mode on");
    await s.fake.emit("before_agent_start", { prompt: TASK });
    const blocked = await s.call("write", { path: "../outside2.js", content: "x\n" }, "w3") as { block: boolean };
    assert.equal(blocked.block, true);
    assert.match(await s.fake.command("status"), /强制评审：create\n/);
  } finally { await s.h.cleanup(); }
});

test("harness.enforce containing edit is an invalid config: the adapter stays off", async () => {
  const s = await session(shadowConfig({ enforce: ["create", "edit"] }));
  try {
    assert.equal(await s.call("write", { path: "../outside.js", content: "x\n" }, "w1"), undefined);
    await s.settle();
    const status = await s.fake.command("status");
    assert.match(status, /^Jev: off/);
    assert.match(status, /config: invalid \(harness\.enforce must not include edit/);
    assert.match(status, /harness: off/);
    assert.match(status, /harness actions this session: 0 /);
    await assert.rejects(readdir(s.runsDir), { code: "ENOENT" });
    assert.equal(s.jev.requests.length, 0);
  } finally { await s.h.cleanup(); }
});

test("parallel tool results bind to their own envelope by toolCallId, whatever the arrival order", async () => {
  const s = await session(shadowConfig());
  try {
    await writeFile(join(s.ws, "src", "b.js"), "export const b = 1;\n");
    await s.call("read", { path: "src/app.js" }, "call-a");
    await s.call("bash", { command: "node --test" }, "call-b");
    await s.call("read", { path: "src/b.js" }, "call-c");
    await s.result("call-c", "read", "content of b");
    await s.result("call-b", "bash", "1 failing\n\nCommand exited with code 1", true);
    await s.result("call-a", "read", "content of app");
    await s.settle();
    const [product] = await s.products();
    const rows = product!.receipts.map(({ receipt }) => ({
      call: receipt.execution.evidence[0]!.toolCallId,
      tool: receipt.execution.evidence[0]!.toolName,
      head: receipt.execution.evidence[0]!.output.head[0],
      status: receipt.execution.status,
      exit: receipt.execution.evidence[0]!.exitCode,
    }));
    assert.deepEqual(rows, [
      { call: "call-a", tool: "read", head: "content of app", status: "executed", exit: null },
      { call: "call-b", tool: "bash", head: "1 failing", status: "failed", exit: 1 },
      { call: "call-c", tool: "read", head: "content of b", status: "executed", exit: null },
    ]);
    assert.deepEqual(product!.receipts[1]!.receipt.verification, { status: "failed", evidenceRefs: ["call-b"], note: "node --test" });
    assert.equal(product!.run.status, "incomplete", "a failed check is archived as failed, not completed");
  } finally { await s.h.cleanup(); }
});

test("a code change without any check command is incomplete; the same change with a passing check completes", async () => {
  const s = await session(shadowConfig());
  const app = () => join(s.ws, "src", "app.js");
  try {
    await s.call("edit", { path: "src/app.js", edits: [{ oldText: "41", newText: "42" }] }, "e1");
    await writeFile(app(), "export const answer = 42;\n"); // what Pi's edit does
    await s.result("e1", "edit", "Successfully replaced 1 block(s) in src/app.js.");
    await s.beforeSettle();
    await s.settle();

    await s.fake.emit("before_agent_start", { prompt: TASK });
    await s.call("edit", { path: "src/app.js", edits: [{ oldText: "42", newText: "43" }] }, "e2");
    await writeFile(app(), "export const answer = 43;\n");
    await s.result("e2", "edit", "Successfully replaced 1 block(s) in src/app.js.");
    await s.call("bash", { command: "npm test" }, "t2");
    await s.result("t2", "bash", "ok");
    // Completed needs the completion assessment too: host evidence is complete and Jev accepts.
    await s.beforeSettle();
    await s.settle();

    const products = await s.products();
    const byStatus = Object.fromEntries(products.map((p) => [p.run.status as string, p]));
    assert.deepEqual(Object.keys(byStatus).sort(), ["completed", "incomplete"]);
    const incomplete = byStatus.incomplete!;
    assert.deepEqual((incomplete.run.changes as { path: string; change: string }[]).map(({ path, change }) => ({ path, change })), [{ path: "src/app.js", change: "modified" }]);
    assert.deepEqual(incomplete.run.verification, []);
    assert.deepEqual(incomplete.run.remaining, ["缺少验证证据：有代码改动，但没有运行任何检查命令"]);
    assert.match(incomplete.summary, /状态：已结束，仍未完成/);
    assert.deepEqual(byStatus.completed!.run.verification, [{ name: "npm test", status: "passed", evidenceRefs: ["t2"] }]);
  } finally { await s.h.cleanup(); }
});

test("PI_JEV_RUNS_DIR and PI_JEV_RUN_ID place the run directory exactly; a later task gets <id>-2; status shows the path", async () => {
  const runs = await mkdtemp(join(tmpdir(), "pi-jev-runs-"));
  const s = await session(shadowConfig(), noulAnswer, { PI_JEV_RUNS_DIR: runs, PI_JEV_RUN_ID: "ci-run-1" });
  try {
    assert.match(await s.fake.command("status"), new RegExp(`harness run products: ${escape(join(runs, "ci-run-1"))} \\(task in progress\\)`));
    await s.call("read", { path: "src/app.js" }, "r1");
    await s.result("r1", "read", "export const answer = 41;");
    await s.beforeSettle("The answer is 41.");
    await s.settle();
    const first = JSON.parse(await readFile(join(runs, "ci-run-1", "run.json"), "utf8")) as { status: string };
    assert.equal(first.status, "completed");
    assert.match(await s.fake.command("status"), new RegExp(`harness run products: ${escape(join(runs, "ci-run-1"))} \\(written\\)`));

    await s.fake.emit("before_agent_start", { prompt: TASK });
    await s.settle();
    assert.deepEqual((await readdir(runs)).sort(), ["ci-run-1", "ci-run-1-2"]);
    await readFile(join(runs, "ci-run-1-2", "run.json"), "utf8");
    await assert.rejects(readdir(s.runsDir), { code: "ENOENT" }, "the default runs directory is not used");
  } finally { await s.h.cleanup(); await rm(runs, { recursive: true, force: true }); }
});

test("an existing run.json under the injected run id is never overwritten; the failure shows in status", async () => {
  const runs = await mkdtemp(join(tmpdir(), "pi-jev-runs-"));
  await mkdir(join(runs, "taken"));
  await writeFile(join(runs, "taken", "run.json"), "keep\n");
  const s = await session(shadowConfig(), noulAnswer, { PI_JEV_RUNS_DIR: runs, PI_JEV_RUN_ID: "taken" });
  try {
    await s.call("read", { path: "src/app.js" }, "r1");
    await s.result("r1", "read", "x");
    await s.settle();
    assert.equal(await readFile(join(runs, "taken", "run.json"), "utf8"), "keep\n");
    const status = await s.fake.command("status");
    assert.match(status, /harness run products: .*taken \(write failed\)/);
    assert.match(status, /harness last error: run products: .*already holds run\.json/);
  } finally { await s.h.cleanup(); await rm(runs, { recursive: true, force: true }); }
});

test("an invalid PI_JEV_RUN_ID or a relative PI_JEV_RUNS_DIR makes the config invalid: the adapter stays off", async () => {
  for (const [env, reason] of [
    [{ PI_JEV_RUN_ID: "../escape" }, /PI_JEV_RUN_ID must be one path segment/],
    [{ PI_JEV_RUNS_DIR: "relative/runs" }, /PI_JEV_RUNS_DIR must be an absolute path/],
  ] as const) {
    const s = await session(shadowConfig(), noulAnswer, env);
    try {
      assert.equal(await s.call("write", { path: "../outside.js", content: "x\n" }, "w1"), undefined);
      await s.settle();
      const status = await s.fake.command("status");
      assert.match(status, /^Jev: off/);
      assert.match(status, reason);
      assert.match(status, /harness: off/);
      await assert.rejects(readdir(s.runsDir), { code: "ENOENT" });
      assert.equal(s.jev.requests.length, 0);
    } finally { await s.h.cleanup(); }
  }
});

test("run directory precedence: injected option > PI_JEV_RUNS_DIR > file harness.runsDir > default; file runsDir must be absolute", async () => {
  const file = (runsDir: string) => async () => JSON.stringify({ mode: "shadow", harness: { runsDir } });
  const home = "/home/test";
  const fromEnv = await loadConfig({ home, readText: file("/from/file"), env: { PI_JEV_RUNS_DIR: "/from/env", PI_JEV_RUN_ID: "r-1" } });
  const continuation = { enabled: false, max: 2 };
  assert.deepEqual(fromEnv.config.harness, { enforce: [], continuation, runsDir: "/from/env", runId: "r-1" });
  const injected = await loadConfig({ home, readText: file("/from/file"), env: { PI_JEV_RUNS_DIR: "/from/env", PI_JEV_RUN_ID: "r-1" }, runsDir: "/injected", runId: "r-2" });
  assert.deepEqual(injected.config.harness, { enforce: [], continuation, runsDir: "/injected", runId: "r-2" });
  const fromFile = await loadConfig({ home, readText: file("/from/file"), env: {} });
  assert.deepEqual(fromFile.config.harness, { enforce: [], continuation, runsDir: "/from/file" });
  const missing = await loadConfig({ home, readText: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
  assert.equal(missing.config.harness.runsDir, join(home, ".pi", "agent", "pi-jev-harness", "runs"));
  const relative = await loadConfig({ home, readText: file("runs"), env: {} });
  assert.equal(relative.source, "invalid");
  assert.match(relative.reason!, /harness\.runsDir must be an absolute path/);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// verifier regressions.
test("T031: a task whose model request ended in error is never completed, even without changes", async () => {
  const s = await session(shadowConfig());
  try {
    await s.fake.emit("message_end", {
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 },
    });
    await s.settle();
    const [product] = await s.products();
    assert.ok(product, "run products written");
    assert.notEqual(product.run.status, "completed", "a provider failure is not a finished question-and-answer task");
  } finally { await s.h.cleanup(); }
});

test("T031: a file written by bash is in the changeset, so the task is not completed without a check", async () => {
  const s = await session(shadowConfig());
  try {
    await s.call("bash", { command: "printf 'export const two = 2;\\n' > src/two.js" }, "b1");
    await writeFile(join(s.ws, "src", "two.js"), "export const two = 2;\n"); // what the command does
    await s.result("b1", "bash", "");
    await s.settle();
    const [product] = await s.products();
    assert.ok(product, "run products written");
    assert.ok((product.run.changes as { path: string }[]).some((c) => c.path === "src/two.js"), "bash-written file listed in changes");
    assert.notEqual(product.run.status, "completed");
  } finally { await s.h.cleanup(); }
});

// aborted runs (D3), explicit model-error status (D2), workspace changeset (D4), structured completion.
const MESSAGE_BASE = { provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };

test("T036 D3: an aborted agent run is cancelled, never completed, even when a change was made", async () => {
  const s = await session(shadowConfig());
  try {
    await s.call("edit", { path: "src/app.js", edits: [{ oldText: "41", newText: "42" }] }, "e1");
    await writeFile(join(s.ws, "src", "app.js"), "export const answer = 42;\n");
    await s.result("e1", "edit", "Successfully replaced 1 block(s) in src/app.js.");
    const [result] = await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "aborted", context: { pendingMessages: [] } });
    assert.equal(result, undefined, "no continuation after an abort");
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "cancelled");
    assert.match((product!.run.reasons as string[]).join("\n"), /用户取消：任务被中止（agent_before_settle outcome aborted）/);
    assert.deepEqual((product!.run.changes as { path: string }[]).map((c) => c.path), ["src/app.js"], "changes are kept, not presented as rolled back");
    assert.match(product!.summary, /状态：已取消/);
  } finally { await s.h.cleanup(); }
});

test("T036 D3: an aborted assistant message or the host abort signal cancels a question task", async () => {
  for (const variant of ["message", "signal"] as const) {
    const s = await session(shadowConfig());
    try {
      if (variant === "message")
        await s.fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", ...MESSAGE_BASE } });
      else (s.fake.ctx as { signal?: AbortSignal }).signal = AbortSignal.abort("max-time");
      await s.beforeSettle();
      await s.settle();
      const [product] = await s.products();
      assert.equal(product!.run.status, "cancelled", variant);
      assert.equal(s.jev.requests.filter((r) => "done" in r.body.questions).length, 0, `${variant}: no completion assessment after an abort`);
    } finally { await s.h.cleanup(); }
  }
});

test("T036 D2: a model error is failed with its reason; a later successful reply (Pi retry) clears it", async () => {
  const s = await session(shadowConfig(), noulAnswer, { PI_JEV_RUN_ID: "d2" });
  try {
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", ...MESSAGE_BASE } });
    // Pi's boundary outcome mirrors the last assistant stopReason.
    await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "error", context: { pendingMessages: [] } });
    await s.settle();
    assert.equal(s.jev.requests.length, 0, "a failed model request is not assessed");
    await s.fake.emit("before_agent_start", { prompt: TASK });
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503", ...MESSAGE_BASE } });
    await s.beforeSettle("The answer is 41.");
    await s.settle();
    const [first, second] = await s.products();
    assert.equal(first!.run.status, "failed");
    assert.match((first!.run.reasons as string[]).join("\n"), /模型请求失败：503 resource_pressure/);
    assert.equal(second!.run.status, "completed", "the retried reply answered the question and Jev accepted it");
  } finally { await s.h.cleanup(); }
});

// every model request fails (provider 503/401) before any successful turn or tool call.
test("T039: a model error on the first turn writes a failed run once, with the provider message scrubbed", async () => {
  const secret = "sk-proj-ABCDEFGH12345678abcdefgh";
  const s = await session(shadowConfig(), noulAnswer, { PI_JEV_RUN_ID: "t039" });
  try {
    // Pi retries a retryable error: two failed assistant messages, the first key-bearing one padded so a cap-then-scrub would cut the key.
    const provider = `${"x".repeat(257)} 401 Incorrect API key provided: ${secret}`;
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: provider, ...MESSAGE_BASE } });
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", ...MESSAGE_BASE } });
    await s.fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "error", context: { pendingMessages: [] } });
    await s.settle();
    // Idempotent finalize: a second settle and the session shutdown write nothing more.
    await s.settle();
    await s.fake.emit("session_shutdown", { reason: "quit" });
    assert.equal(s.jev.requests.length, 0, "a failed model request is not assessed");
    const products = await s.products();
    assert.equal(products.length, 1);
    const [product] = products;
    assert.equal(product!.run.status, "failed");
    const reasons = product!.run.reasons as string[];
    assert.match(reasons[0]!, /^模型请求失败：x+ 401 Incorrect API key provided: \[已移除：疑似凭据\]$/);
    const model = product!.receipts.filter((r) => r.receipt.actionId === "model_request");
    assert.equal(model.length, 1, "one receipt records the failed model request");
    assert.equal(model[0]!.receipt.execution.status, "failed");
    assert.match(model[0]!.receipt.execution.reason!, /^模型请求失败：.*\[已移除：疑似凭据\]$/);
    const texts = await Promise.all(["run.json", "receipts.jsonl", "summary.md"].map((name) => readFile(join(s.runsDir, "t039", name), "utf8")));
    for (const text of texts) assert.ok(!text.includes("sk-proj-"), "no credential fragment reaches the run products");
    assert.match(await s.fake.command("status"), /harness run products: .*t039 \(written\)/);
    assert.doesNotMatch(await s.fake.command("status"), /harness last error/);
  } finally { await s.h.cleanup(); }
});

test("T039: a run without a model error gets no model_request receipt", async () => {
  const s = await session(shadowConfig(), noulAnswer, { PI_JEV_RUN_ID: "t039ok" });
  try {
    await s.beforeSettle("The answer is 41.");
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "completed");
    assert.equal(product!.receipts.filter((r) => r.receipt.actionId === "model_request").length, 0);
  } finally { await s.h.cleanup(); }
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
}

test("T036 D4: in a git workspace, pre-existing changes are listed separately; the task's own bash writes count", async () => {
  const s = await session(shadowConfig(), noulAnswer, {}, async (ws) => {
    await writeFile(join(ws, "notes.txt"), "user draft\n");
    await writeFile(join(ws, "keep.js"), "export const k = 1;\n");
    git(ws, "init", "-q");
    git(ws, "add", "src/app.js", "keep.js");
    git(ws, "commit", "-q", "-m", "base");
    // Dirty before the task: an untracked draft and a modified tracked file.
    await writeFile(join(ws, "keep.js"), "export const k = 2;\n");
  });
  try {
    await s.call("bash", { command: "printf ... > src/two.js && sed -i s/41/40/ src/app.js" }, "b1");
    await writeFile(join(s.ws, "src", "two.js"), "export const two = 2;\n");
    await writeFile(join(s.ws, "src", "app.js"), "export const answer = 40;\n");
    await s.result("b1", "bash", "");
    await s.beforeSettle();
    await s.settle();
    const [product] = await s.products();
    const changes = (product!.run.changes as { path: string; change: string }[]).map(({ path, change }) => `${change}:${path}`);
    assert.deepEqual(changes, ["added:src/two.js", "modified:src/app.js"].sort((a, b) => a.split(":")[1]!.localeCompare(b.split(":")[1]!)));
    assert.deepEqual(product!.run.preexistingChanges, ["keep.js", "notes.txt"]);
    assert.equal(product!.run.status, "incomplete", "a code change by bash without a check is not completed");
    assert.match(product!.summary, /任务开始前已有改动（不计入本次改动）\n- keep\.js\n- notes\.txt/);
  } finally { await s.h.cleanup(); }
});

test("T036 D4: a pre-existing dirty file the task changes again is this task's change", async () => {
  const s = await session(shadowConfig(), noulAnswer, {}, async (ws) => {
    git(ws, "init", "-q");
    git(ws, "add", "src/app.js");
    git(ws, "commit", "-q", "-m", "base");
    await writeFile(join(ws, "src", "app.js"), "export const answer = 100;\n");
  });
  try {
    await s.call("bash", { command: "echo > src/app.js" }, "b1");
    await writeFile(join(s.ws, "src", "app.js"), "export const answer = 101;\n");
    await s.result("b1", "bash", "");
    await s.settle();
    const [product] = await s.products();
    assert.deepEqual((product!.run.changes as { path: string }[]).map((c) => c.path), ["src/app.js"]);
    assert.deepEqual(product!.run.preexistingChanges, ["src/app.js"]);
  } finally { await s.h.cleanup(); }
});

test("T036: run.json carries the structured completion filled by the adapter", async () => {
  const s = await session(shadowConfig());
  try {
    await s.beforeSettle("The answer is 41.");
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "completed");
    assert.deepEqual(product!.run.completion, { status: "passed", stopAllowed: true, assessment: "acceptance", continuations: { used: 0, max: 2 } });
    assert.deepEqual(product!.run.preexistingChanges, []);
    assert.match(product!.summary, /完成验收：通过（passed，acceptance）；允许结束：是；自动续跑：已用 0\/2/);
  } finally { await s.h.cleanup(); }
});

test("T048: a task closed by the next task's start is written before settled() and shutdown resolve", async () => {
  for (const wait of ["settled", "shutdown"] as const) {
    const h = await harness();
    const runs = join(h.dir, "runs");
    try {
      await writeFile(h.configPath, JSON.stringify(shadowConfig()));
      const fake = fakePi({ cwd: h.dir });
      const registry = load(fake, h.deps({
        fetch: fakeFetch(noulAnswer).fetch,
        env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL, PI_JEV_RUNS_DIR: runs, PI_JEV_RUN_ID: "t048" },
      }));
      await fake.emit("session_start", { reason: "startup" });
      await fake.emit("before_agent_start", { prompt: TASK });
      // The first task never settles: the second task's start closes it.
      await fake.emit("before_agent_start", { prompt: TASK });
      if (wait === "settled") await settled(registry);
      else await fake.emit("session_shutdown", { reason: "quit" });
      const run = JSON.parse(await readFile(join(runs, "t048", "run.json"), "utf8")) as { status: string };
      assert.ok(run.status, `${wait}: the closed task's run.json is complete`);
    } finally {
      await h.cleanup();
    }
  }
});
