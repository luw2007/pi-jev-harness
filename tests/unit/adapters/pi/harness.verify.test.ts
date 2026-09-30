/**
 * T041 verification of T036 (D2/D3/D4, checkpoint semantics) and T039 (failed runs) through the
 * real extension entry (`createExtension`) on the fake Pi host. No real Pi, Jev or model.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { JEV_URL, KEY, fakeFetch, fakePi, harness, load, validAnswer, type FakePi, type Harness, type JevRequest } from "./fake-host.ts";

const TASK = "Explain what src/app.js exports";
const MESSAGE_BASE = { provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };
const PERMIT: Record<string, number> = { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05 };

function noulAnswer(request: JevRequest): Response {
  if (Object.values(request.body.questions).some((question) => question.type === "choice")) return validAnswer(request);
  const answers = Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: "noul", noul: PERMIT[id] ?? 0.5 }]));
  return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
}

interface Product {
  name: string;
  run: Record<string, any>;
  receipts: { receipt: { actionId: string; execution: { status: string; reason: string | null } } }[];
  summary: string;
  texts: string[];
}

interface Session {
  h: Harness;
  fake: FakePi;
  jev: ReturnType<typeof fakeFetch>;
  ws: string;
  runsDir: string;
  call(toolName: string, input: Record<string, unknown>, toolCallId: string): Promise<unknown>;
  result(toolCallId: string, toolName: string, text: string, isError?: boolean): Promise<void>;
  answer(text: string): Promise<void>;
  beforeSettle(outcome?: string): Promise<unknown>;
  settle(): Promise<void>;
  products(): Promise<Product[]>;
}

const CONFIG = { mode: "shadow", outbound: { taskIntent: true }, router: { tools: false } };

async function session(options: { config?: Record<string, unknown>; responder?: Parameters<typeof fakeFetch>[0]; env?: Record<string, string>; prepare?: (ws: string) => Promise<void>; startTask?: boolean } = {}): Promise<Session> {
  const h = await harness();
  const ws = join(h.dir, "ws");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "app.js"), "export const answer = 41;\n");
  await writeFile(h.configPath, JSON.stringify(options.config ?? CONFIG));
  await options.prepare?.(ws);
  const jev = fakeFetch(options.responder ?? noulAnswer);
  const fake = fakePi({ cwd: ws });
  load(fake, h.deps({ fetch: jev.fetch, env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL, ...options.env } }));
  await fake.emit("session_start", { reason: "startup" });
  if (options.startTask !== false) await fake.emit("before_agent_start", { prompt: TASK });
  const runsDir = join(h.dir, ".pi", "agent", "pi-jev-harness", "runs");
  return {
    h, fake, jev, ws, runsDir,
    async call(toolName, input, toolCallId) {
      const [result] = await fake.emit("tool_call", { toolName, toolCallId, input });
      return result;
    },
    async result(toolCallId, toolName, text, isError = false) {
      await fake.emit("tool_result", { toolCallId, toolName, input: {}, content: [{ type: "text", text }], isError, details: undefined });
    },
    async answer(text) {
      await fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...MESSAGE_BASE } });
    },
    async beforeSettle(outcome = "completed") {
      const [result] = await fake.emit("agent_before_settle", { entries: [], continue: false, outcome, context: { pendingMessages: [] } });
      return result;
    },
    async settle() {
      await fake.emit("agent_settled", {});
    },
    async products() {
      const names = (await readdir(runsDir).catch(() => [] as string[])).sort();
      return Promise.all(names.map(async (name) => {
        const texts = await Promise.all(["run.json", "receipts.jsonl", "summary.md"].map((file) => readFile(join(runsDir, name, file), "utf8")));
        return {
          name,
          run: JSON.parse(texts[0]!),
          receipts: texts[1]!.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
          summary: texts[2]!,
          texts,
        };
      }));
    },
  };
}

const changeList = (run: Record<string, any>) => (run.changes as { path: string; change: string }[]).map(({ path, change }) => `${change}:${path}`).sort();

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
}

// ---- T036 D3: aborted runs -------------------------------------------------------------------

test("T036 D3: a task aborted before any tool call is cancelled, with no assessment and no changes", async () => {
  const s = await session();
  try {
    assert.equal(await s.beforeSettle("aborted"), undefined);
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "cancelled");
    assert.deepEqual(product!.run.changes, []);
    assert.deepEqual(product!.run.completion, { status: "not_assessed", stopAllowed: null, assessment: null, continuations: { used: 0, max: 2 } });
    assert.equal(s.jev.requests.length, 0);
    assert.deepEqual(product!.receipts, []);
  } finally { await s.h.cleanup(); }
});

test("T036 D3: session shutdown before the task settles writes cancelled once; a late agent_settled writes nothing more", async () => {
  const s = await session({ env: { PI_JEV_RUN_ID: "shut" } });
  try {
    await s.answer("It exports answer.");
    await s.fake.emit("session_shutdown", { reason: "quit" });
    await s.settle();
    const products = await s.products();
    assert.equal(products.length, 1);
    assert.equal(products[0]!.run.status, "cancelled");
    assert.match((products[0]!.run.reasons as string[]).join("\n"), /会话在任务结束前关闭/);
  } finally { await s.h.cleanup(); }
});

test("T036 D3: an abort after a model error is cancelled (the abort wins), not failed", async () => {
  const s = await session();
  try {
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 busy", ...MESSAGE_BASE } });
    await s.beforeSettle("aborted");
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "cancelled");
  } finally { await s.h.cleanup(); }
});

// ---- T036 D2: model errors -------------------------------------------------------------------

test("T036 D2: a model error after a real code change is failed, not incomplete", async () => {
  const s = await session();
  try {
    await s.call("bash", { command: "echo 42 > src/app.js" }, "b1");
    await writeFile(join(s.ws, "src", "app.js"), "export const answer = 42;\n");
    await s.result("b1", "bash", "");
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded", ...MESSAGE_BASE } });
    await s.beforeSettle("error");
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "failed");
    assert.deepEqual(changeList(product!.run), ["modified:src/app.js"], "the change is still reported");
    assert.equal(product!.receipts.filter((r) => r.receipt.actionId === "model_request").length, 1);
  } finally { await s.h.cleanup(); }
});

// ---- T036 D4: workspace changeset through the adapter ----------------------------------------

test("T036 D4 (non-git): a file deleted by bash and a binary file changed by bash are this task's changes", async () => {
  const s = await session({ prepare: async (ws) => {
    await writeFile(join(ws, "old.txt"), "old\n");
    await writeFile(join(ws, "logo.bin"), Buffer.from([137, 80, 78, 71, 0, 0]));
    await writeFile(join(ws, "untouched.txt"), "same\n");
  } });
  try {
    await s.call("bash", { command: "rm old.txt && cp other.bin logo.bin" }, "b1");
    await unlink(join(s.ws, "old.txt"));
    await writeFile(join(s.ws, "logo.bin"), Buffer.from([137, 80, 78, 71, 0, 1]));
    await s.result("b1", "bash", "");
    await s.settle();
    const [product] = await s.products();
    assert.deepEqual(changeList(product!.run), ["deleted:old.txt", "modified:logo.bin"]);
    assert.deepEqual(product!.run.preexistingChanges, []);
    assert.equal(product!.run.status, "incomplete", "changes without a check are never completed");
  } finally { await s.h.cleanup(); }
});

test("T036 D4 (git): pre-existing dirty files never count, even when the task only reads", async () => {
  const s = await session({
    prepare: async (ws) => {
      git(ws, "init", "-q");
      git(ws, "add", ".");
      git(ws, "commit", "-q", "-m", "base");
      await writeFile(join(ws, "src", "app.js"), "export const answer = 40; // user edit\n");
      await writeFile(join(ws, "notes.md"), "draft\n");
    },
  });
  try {
    await s.call("read", { path: "src/app.js" }, "r1");
    await s.result("r1", "read", "export const answer = 40;");
    await s.answer("It exports answer (40 in your working copy).");
    await s.beforeSettle();
    await s.settle();
    const [product] = await s.products();
    assert.deepEqual(product!.run.changes, []);
    assert.deepEqual(product!.run.preexistingChanges, ["notes.md", "src/app.js"]);
    assert.equal(product!.run.status, "completed", "a question task over a dirty tree can still complete");
  } finally { await s.h.cleanup(); }
});

test("T036 D4 (git): a tracked file deleted by bash is a deletion in run.json", async () => {
  const s = await session({
    prepare: async (ws) => {
      git(ws, "init", "-q");
      git(ws, "add", ".");
      git(ws, "commit", "-q", "-m", "base");
    },
  });
  try {
    await s.call("bash", { command: "git rm -q src/app.js" }, "b1");
    await unlink(join(s.ws, "src", "app.js"));
    await s.result("b1", "bash", "");
    await s.settle();
    const [product] = await s.products();
    assert.deepEqual(changeList(product!.run), ["deleted:src/app.js"]);
  } finally { await s.h.cleanup(); }
});

test("T036 D4: an unreadable workspace directory makes the snapshot fail; a passing question task is then verification_unavailable", async () => {
  let locked = "";
  const s = await session({ startTask: false, prepare: async (ws) => {
    locked = join(ws, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
  } });
  try {
    await s.fake.emit("before_agent_start", { prompt: TASK });
    await s.answer("It exports answer.");
    await s.beforeSettle();
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "verification_unavailable");
    assert.match((product!.run.reasons as string[]).join("\n"), /工作区改动检测不完整：工作区快照失败/);
  } finally {
    await chmod(locked, 0o700);
    await s.h.cleanup();
  }
});

// ---- T036: checkpoint semantics through the adapter ------------------------------------------

test("T036: a tool_result arriving while before_settle is assessing voids that assessment; the run is not completed on it", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let asked: () => void = () => {};
  const askedDone = new Promise<void>((resolve) => (asked = resolve));
  const s = await session({
    responder: async (request) => {
      if ("done" in request.body.questions) {
        asked();
        await gate;
      }
      return noulAnswer(request);
    },
  });
  try {
    await s.call("read", { path: "src/app.js" }, "r1"); // result arrives late (parallel tool)
    await s.answer("It exports answer.");
    const pending = s.beforeSettle();
    await askedDone;
    await s.result("r1", "read", "export const answer = 41;");
    release();
    assert.equal(await pending, undefined);
    await s.settle();
    const [product] = await s.products();
    assert.notEqual(product!.run.status, "completed", "a stale acceptance cannot complete the run");
    assert.equal(product!.run.completion.status, "not_assessed", "the discarded assessment is not recorded as the result");
  } finally { await s.h.cleanup(); }
});

// ---- T039: failed runs, scrubbing and idempotent finalize ------------------------------------

const SECRETS = [
  "sk-proj-ABCDEFGH12345678abcdefgh",
  "AIzaSyA1234567890abcdefghijklmnopqrstu",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
];

test("T039: provider errors echoing credentials (Jev key included) are scrubbed from run.json, receipts and summary", async () => {
  for (const secret of [...SECRETS, KEY]) {
    const s = await session({ env: { PI_JEV_RUN_ID: "scrub" } });
    try {
      const provider = `401 {"error":{"message":"bad credential ${secret}","header":"Authorization: Bearer ${"t".repeat(24)}"}}`;
      await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: provider, ...MESSAGE_BASE } });
      await s.beforeSettle("error");
      await s.settle();
      const [product] = await s.products();
      assert.equal(product!.run.status, "failed", secret);
      for (const text of product!.texts) {
        assert.ok(!text.includes(secret), `${secret} leaked`);
        assert.ok(!text.includes("t".repeat(24)), "bearer token leaked");
      }
      assert.match(product!.texts[0]!, /模型请求失败：401/);
      assert.doesNotMatch(await s.fake.command("status"), new RegExp(secret.slice(0, 12)));
    } finally { await s.h.cleanup(); }
  }
});

test("T039: a key straddling the 300-character cap is removed whole, never left as a fragment", async () => {
  for (const pad of [280, 290, 295, 299]) {
    const s = await session({ env: { PI_JEV_RUN_ID: `cap${pad}` } });
    try {
      await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: `${"x".repeat(pad)} sk-proj-ABCDEFGH12345678abcdefgh tail`, ...MESSAGE_BASE } });
      await s.beforeSettle("error");
      await s.settle();
      const [product] = await s.products();
      for (const text of product!.texts) assert.ok(!/sk-proj|ABCDEFGH1234/.test(text), `pad ${pad}`);
    } finally { await s.h.cleanup(); }
  }
});

test("T039: two concurrent agent_settled for a failed run write exactly one run and no write error", async () => {
  const s = await session({ env: { PI_JEV_RUN_ID: "twice" } });
  try {
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", ...MESSAGE_BASE } });
    await s.beforeSettle("error");
    await Promise.all([s.settle(), s.settle()]);
    await s.fake.emit("session_shutdown", { reason: "quit" });
    const products = await s.products();
    assert.deepEqual(products.map((p) => p.name), ["twice"]);
    assert.equal(products[0]!.run.status, "failed");
    assert.doesNotMatch(await s.fake.command("status"), /harness last error/);
  } finally { await s.h.cleanup(); }
});

test("T039: finalize is idempotent across concurrent settles and shutdown: one run, status failed, no write error", async () => {
  const s = await session({ env: { PI_JEV_RUN_ID: "once" } });
  try {
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 resource_pressure", ...MESSAGE_BASE } });
    await s.beforeSettle("error");
    await Promise.all([s.settle(), s.settle(), s.fake.emit("session_shutdown", { reason: "quit" })]);
    const products = await s.products();
    assert.deepEqual(products.map((p) => p.name), ["once"]);
    assert.equal(products[0]!.run.status, "failed");
    assert.equal(products[0]!.receipts.filter((r) => r.receipt.actionId === "model_request").length, 1);
    assert.doesNotMatch(await s.fake.command("status"), /harness last error/);
  } finally { await s.h.cleanup(); }
});

test("T039: shutdown racing a settle that is still writing keeps the settled status (completed run)", async () => {
  // Pi 0.87.1 awaits agent_settled handlers, but a session_shutdown (user quits) can arrive while
  // the handler is still writing; the task had already settled, so it must not become cancelled.
  const s = await session({ env: { PI_JEV_RUN_ID: "race" } });
  try {
    await s.answer("It exports answer.");
    await s.beforeSettle();
    const settling = s.settle();
    await s.fake.emit("session_shutdown", { reason: "quit" });
    await settling;
    const [product] = await s.products();
    assert.equal(product!.run.status, "completed");
  } finally { await s.h.cleanup(); }
});

test("T039: a key glued to a JSON-escaped newline (\\nsk-…) in the provider text is still scrubbed", async () => {
  const s = await session({ env: { PI_JEV_RUN_ID: "escaped" } });
  try {
    // What JSON.stringify of a provider body with a newline before the key looks like.
    const provider = `401 ${JSON.stringify({ error: { message: "Incorrect API key provided:\nsk-proj-ABCDEFGH12345678abcdefgh" } })}`;
    await s.fake.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: provider, ...MESSAGE_BASE } });
    await s.beforeSettle("error");
    await s.settle();
    const [product] = await s.products();
    for (const text of product!.texts) assert.ok(!text.includes("sk-proj-ABCDEFGH"), "key leaked into run products");
  } finally { await s.h.cleanup(); }
});
