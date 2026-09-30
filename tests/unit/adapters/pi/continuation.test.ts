/**
 * T027: completion checkpoint and bounded continuation through the Pi adapter, driven by the
 * fake host's real event names (`agent_before_settle`, `agent_settled`, `input`, `tool_result`).
 * No real Pi, model or Jev: Jev is a fake fetch.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { JEV_URL, KEY, fakeFetch, fakePi, harness, load, settled, validAnswer, type FakePi, type Harness, type JevRequest } from "./fake-host.ts";

const TASK = "Change the answer in src/app.js to 42";
const REVIEW_PERMIT: Record<string, number> = { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05 };

interface Policy {
  /** Acceptance `done` choice; "down" answers 503. */
  accept?: "accepted" | "rejected" | "down";
  /** Continuation Noul answers. */
  done?: number;
  autonomous?: number;
  /** Hold continuation requests until released. */
  hold?: Promise<void>;
}

const isChoice = (request: JevRequest) => Object.values(request.body.questions).some((q) => q.type === "choice");
const isContinuation = (request: JevRequest) => !isChoice(request) && "autonomous" in request.body.questions;

function responder(policy: Policy) {
  return async (request: JevRequest): Promise<Response> => {
    if (isChoice(request)) {
      if (!("done" in request.body.questions)) return validAnswer(request);
      if (policy.accept === "down") return new Response("down", { status: 503 });
      const choice = policy.accept ?? "accepted";
      const other = choice === "accepted" ? "rejected" : "accepted";
      const body = { model: request.body.model, answers: { done: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9, [other]: 0.1 } } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (isContinuation(request) && policy.hold) await policy.hold;
    const yes = (id: string) => (id === "done" ? (policy.done ?? 0.2) : id === "autonomous" ? (policy.autonomous ?? 0.9) : (REVIEW_PERMIT[id] ?? 0.5));
    const answers = Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, { type: "noul", noul: yes(id) }]));
    return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

interface Receipt {
  receipt: { actionId: string; request: unknown; response: unknown; execution: { status: string; reason: string | null } };
}

interface Session {
  h: Harness;
  fake: FakePi;
  jev: ReturnType<typeof fakeFetch>;
  registry: object;
  edit(id: string): Promise<void>;
  beforeSettle(extra?: Record<string, unknown>): Promise<{ entries?: { type: string; customType?: string; content?: string }[]; continue?: boolean } | undefined>;
  settle(): Promise<unknown[]>;
  products(): Promise<{ run: { status: string; reasons: string[]; remaining: string[] }; receipts: Receipt[]; summary: string }[]>;
  status(): Promise<string>;
  /** Waits for pending telemetry writes, then removes the temp dir (avoids ENOTEMPTY). */
  cleanup(): Promise<void>;
}

function config(options: { mode?: string; continuation?: Record<string, unknown>; enforce?: string[]; taskIntent?: boolean; routing?: boolean } = {}) {
  return {
    mode: options.mode ?? "shadow",
    outbound: { taskIntent: options.taskIntent ?? true },
    router: { tools: options.routing ?? false },
    harness: { enforce: options.enforce ?? [], ...(options.continuation ? { continuation: options.continuation } : {}) },
  };
}

async function session(cfg: Record<string, unknown> | null, policy: Policy = {}, pending: () => boolean = () => false, prompt = TASK): Promise<Session> {
  const h = await harness();
  const ws = join(h.dir, "ws");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "app.js"), "export const answer = 41;\n");
  if (cfg) await writeFile(h.configPath, JSON.stringify(cfg));
  const jev = fakeFetch(responder(policy));
  const fake = fakePi({ cwd: ws, pendingMessages: pending });
  const registry = load(fake, h.deps({ fetch: jev.fetch, env: { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL } }));
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("before_agent_start", { prompt });
  const runsDir = join(h.dir, ".pi", "agent", "pi-jev-harness", "runs");
  let edits = 0;
  return {
    h, fake, jev, registry,
    async edit(id) {
      const from = 41 + edits++;
      await fake.emit("tool_call", { toolName: "edit", toolCallId: id, input: { path: "src/app.js", edits: [{ oldText: String(from), newText: String(from + 1) }] } });
      await writeFile(join(ws, "src", "app.js"), `export const answer = ${from + 1};\n`);
      await fake.emit("tool_result", { toolCallId: id, toolName: "edit", input: {}, content: [{ type: "text", text: "Successfully replaced 1 block(s)." }], isError: false, details: undefined });
    },
    async beforeSettle(extra = {}) {
      const [result] = await fake.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: { pendingMessages: [] }, ...extra });
      return result as never;
    },
    settle: () => fake.emit("agent_settled", {}),
    async products() {
      const names = await readdir(runsDir).catch(() => [] as string[]);
      return Promise.all(names.sort().map(async (name) => ({
        run: JSON.parse(await readFile(join(runsDir, name, "run.json"), "utf8")),
        receipts: (await readFile(join(runsDir, name, "receipts.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Receipt),
        summary: await readFile(join(runsDir, name, "summary.md"), "utf8"),
      })));
    },
    status: () => fake.command("status"),
    async cleanup() { await settled(registry); await h.cleanup(); },
  };
}

const continuationReceipts = (receipts: Receipt[]) => receipts.filter((r) => r.receipt.actionId.startsWith("continuation_")).map((r) => r.receipt);

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition not reached");
}

test("shadow computes and records the continuation decision but never returns a continue request", async () => {
  const s = await session(config({ continuation: { enabled: true } }));
  try {
    await s.edit("e1");
    assert.equal(await s.beforeSettle(), undefined);
    assert.equal(s.jev.requests.filter(isContinuation).length, 1, "the decision was computed");
    await s.settle();
    const [product] = await s.products();
    const [decision] = continuationReceipts(product!.receipts);
    assert.equal(decision!.execution.status, "not_requested");
    assert.match(decision!.execution.reason!, /guard:shadow_mode/);
    assert.notEqual(decision!.request, null);
    assert.match(product!.run.reasons.join("\n"), /完成验收：未通过（incomplete）；允许结束：否；自动续跑：已用 0\/2，剩余 2/);
    await settled(s.registry);
    const kinds = (await s.h.events()).filter((e) => e.kind === "completion" || e.kind === "continuation").map((e) => `${e.kind}:${e.outcome}`);
    assert.deepEqual(kinds.sort(), ["completion:rejected", "continuation:withheld"]);
  } finally { await s.cleanup(); }
});

test("enabled + on: continues at most twice with the specific prompt, appended to earlier entries", async () => {
  const s = await session(config({ continuation: { enabled: true } }));
  try {
    assert.match(await s.fake.command("mode on"), /续跑：启用，已用 0\/2/);
    await s.edit("e1");
    const earlier = { type: "custom", customType: "other-extension" };
    for (const attempt of [1, 2]) {
      const result = await s.beforeSettle(attempt === 1 ? { entries: [earlier] } : {});
      assert.equal(result?.continue, true, `continuation ${attempt}`);
      const entries = result!.entries!;
      if (attempt === 1) assert.deepEqual(entries[0], earlier, "earlier boundary entries are kept");
      const prompt = entries.at(-1)!;
      assert.equal(prompt.type, "custom_message");
      assert.equal(prompt.customType, "pi-jev-continuation");
      assert.match(prompt.content!, new RegExp(`^Automatic continuation ${attempt} of 2\\.`));
      assert.match(prompt.content!, /- 缺少验证：/, "names the concrete gap, not a generic keep-going");
    }
    assert.equal(await s.beforeSettle(), undefined, "a third continuation is never returned");
    assert.match(await s.status(), /续跑：启用，已用 2\/2/);
    await s.settle();
    const [product] = await s.products();
    const decisions = continuationReceipts(product!.receipts);
    assert.deepEqual(decisions.map((d) => d.execution.status), ["executed", "executed", "not_requested"]);
    assert.match(decisions[2]!.execution.reason!, /limit_reached|guard:continuation_cap/);
    assert.equal(product!.run.status, "incomplete");
    assert.match(product!.run.reasons.join("\n"), /自动续跑：已用 2\/2，剩余 0/);
  } finally { await s.cleanup(); }
});

test("agent_settled only closes the record: it never returns a prompt or asks Jev", async () => {
  const s = await session(config({ continuation: { enabled: true } }));
  try {
    await s.fake.command("mode on");
    await s.edit("e1");
    const results = await s.settle();
    assert.deepEqual(results, [undefined]);
    assert.equal(s.jev.requests.filter((r) => isChoice(r) || isContinuation(r)).length, 0, "settled sends no assessment");
    const [product] = await s.products();
    assert.equal(continuationReceipts(product!.receipts).length, 0);
    assert.equal(product!.run.status, "incomplete", "host evidence: a change without a check");
    assert.match(product!.run.reasons.join("\n"), /完成验收：未进行/);
  } finally { await s.cleanup(); }
});

test("a user message while the continuation assessment is in flight discards the decision", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const s = await session(config({ continuation: { enabled: true } }), { hold });
  try {
    await s.fake.command("mode on");
    await s.edit("e1");
    const pending = s.beforeSettle();
    await waitFor(() => s.jev.requests.some(isContinuation));
    await s.fake.emit("input", { text: "actually stop", source: "interactive", streamingBehavior: "steer" });
    release();
    assert.equal(await pending, undefined, "the stale continuation is not returned");
    await s.settle();
    const [product] = await s.products();
    const [decision] = continuationReceipts(product!.receipts);
    assert.equal(decision!.execution.status, "not_requested");
    assert.match(decision!.execution.reason!, /stale:user_message/);
  } finally { await s.cleanup(); }
});

test("a pending user message stops the continuation", async () => {
  let queued = false;
  const s = await session(config({ continuation: { enabled: true } }), {}, () => queued);
  try {
    await s.fake.command("mode on");
    await s.edit("e1");
    assert.equal(await s.beforeSettle({ context: { pendingMessages: [{ role: "user" }] } }), undefined);
    await s.edit("e2");
    queued = true;
    assert.equal(await s.beforeSettle(), undefined, "ctx.hasPendingMessages() also stops it");
    await s.settle();
    const [product] = await s.products();
    const decisions = continuationReceipts(product!.receipts);
    assert.equal(decisions.length, 2);
    for (const decision of decisions) {
      assert.equal(decision.execution.status, "not_requested");
      assert.match(decision.execution.reason!, /pending_user_message/);
    }
  } finally { await s.cleanup(); }
});

test("an unavailable completion assessment ends as verification_unavailable, never completed", async () => {
  const answer = "src/app.js exports answer = 41.";
  const question = "What does src/app.js export?";
  const passes = await session(config(), { accept: "accepted" }, () => false, question);
  const down = await session(config(), { accept: "down" }, () => false, question);
  const closed = await session(config({ taskIntent: false }), { accept: "accepted" }, () => false, question);
  try {
    for (const s of [passes, down, closed]) {
      await s.fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: answer }] } });
      assert.equal(await s.beforeSettle(), undefined);
      await s.settle();
    }
    const [ok] = await passes.products();
    assert.equal(ok!.run.status, "completed", "a question task passes on its answer with Jev acceptance");
    for (const s of [down, closed]) {
      const [product] = await s.products();
      assert.equal(product!.run.status, "verification_unavailable");
      assert.match(product!.summary, /状态：已结束，完成验收不可用/);
      assert.match(product!.run.remaining.join("\n"), /完成验收不可用：/);
      assert.match(product!.run.reasons.join("\n"), /完成验收：不可用（unavailable）；允许结束：是/);
    }
    assert.equal(closed.jev.requests.length, 0, "outbound.taskIntent=false: no request at all");
    assert.equal(down.jev.requests.filter(isChoice).length, 1);
    assert.equal(down.jev.requests.filter(isContinuation).length, 0, "no continuation is assessed after an unavailable completion");
  } finally { for (const s of [passes, down, closed]) await s.cleanup(); }
});

test("/jev status lists each capability with its real effective state", async () => {
  const s = await session(config({ enforce: ["create", "overwrite"], routing: true }));
  const closed = await session(config({ taskIntent: false, continuation: { enabled: true, max: 1 } }));
  const off = await session(null);
  try {
    const status = await s.status();
    for (const line of ["工具路由：仅观察", "模型路由：由 magpie 负责（harness 不处理）", "强制评审：仅观察（shadow 不拦截：create,overwrite）", "完成验收：开启", "续跑：仅观察（harness.continuation.enabled=false），已用 0/2", "当前任务：running"])
      assert.ok(status.split("\n").includes(line), `missing line ${line}\n${status}`);
    const closedStatus = (await closed.status()).split("\n");
    assert.ok(closedStatus.includes("完成验收：不可用（outbound.taskIntent=false，不发请求）"));
    assert.ok(closedStatus.includes("续跑：仅观察（shadow 模式不续跑），已用 0/1"), "enabled in config is not enabled in shadow");
    assert.ok(closedStatus.includes("工具路由：关闭"));
    await closed.fake.command("mode on");
    assert.ok((await closed.status()).split("\n").includes("续跑：启用，已用 0/1"));
    const offStatus = (await off.status()).split("\n");
    for (const line of ["工具路由：关闭", "模型路由：由 magpie 负责（harness 不处理）", "强制评审：关闭", "完成验收：关闭", "续跑：关闭"]) assert.ok(offStatus.includes(line), `off: missing ${line}`);
  } finally { for (const x of [s, closed, off]) await x.cleanup(); }
});

test("/jev mode on with nothing enabled behaves like shadow", async () => {
  const s = await session(config());
  try {
    const notice = await s.fake.command("mode on");
    assert.match(notice, /Jev: on \(this session\)/);
    assert.match(notice, /强制评审：无/);
    assert.match(notice, /续跑：仅观察（harness\.continuation\.enabled=false）/);
    const write = await s.fake.emit("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "src/app.js", content: "overwrite\n" } });
    assert.deepEqual(write, [undefined], "no kind is enforced: nothing is blocked");
    await s.edit("e1");
    assert.equal(await s.beforeSettle(), undefined, "no continuation is returned");
    await s.settle();
    const [product] = await s.products();
    const [decision] = continuationReceipts(product!.receipts);
    assert.match(decision!.execution.reason!, /guard:shadow_mode/);
  } finally { await s.cleanup(); }
});

test("jev_acceptance_gate returns the CompletionResult contract and shares the checkpoint assessment", async () => {
  const s = await session(config(), { accept: "accepted" }, () => false, "What does src/app.js export?");
  try {
    assert.deepEqual([...s.fake.tools.keys()].sort(), ["foreman_assess", "jev_acceptance_gate", "jev_route"]);
    await s.fake.emit("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "src/app.js" } });
    await s.fake.emit("tool_result", { toolCallId: "r1", toolName: "read", input: {}, content: [{ type: "text", text: "export const answer = 41;" }], isError: false, details: undefined });
    await s.fake.emit("tool_call", { toolName: "jev_acceptance_gate", toolCallId: "g1", input: {} });
    const tool = await s.fake.runTool("jev_acceptance_gate", { answer: "It exports answer = 41." }, "g1");
    await s.fake.emit("tool_result", { toolCallId: "g1", toolName: "jev_acceptance_gate", input: {}, content: tool.content, isError: false, details: tool.details });
    const result = tool.details as Record<string, unknown>;
    assert.deepEqual(JSON.parse(tool.content[0]!.text!), result);
    assert.equal(result.assessment, "acceptance");
    assert.equal(result.policyVersion, "completion-v1");
    assert.equal(result.completionStatus, "passed");
    assert.equal(result.stopAllowed, true);
    assert.deepEqual(result.validation, { ok: true, errors: [] });
    for (const field of ["gaps", "evidenceRefs", "reason", "model"]) assert.ok(field in result, field);
    assert.equal(s.jev.requests.filter(isChoice).length, 1);
    await s.fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "It exports answer = 41." }] } });
    await s.beforeSettle();
    assert.equal(s.jev.requests.filter(isChoice).length, 1, "before_settle reuses the tool's checkpoint assessment");
    const again = await s.fake.runTool("jev_acceptance_gate", {}, "g2");
    assert.equal((again.details as { completionStatus: string }).completionStatus, "unavailable", "after the task stopped the gate reports it, without a new request");
    assert.equal(s.jev.requests.filter(isChoice).length, 1);
    await s.settle();
    const [product] = await s.products();
    assert.equal(product!.run.status, "completed");
    assert.ok(product!.receipts.every((r) => !JSON.stringify(r).includes("jev_acceptance_gate")), "the gate is not a workspace action");
  } finally { await s.cleanup(); }
});

test("T105 L7: foreman_assess uses the `assess` chain; jev_acceptance_gate keeps `acceptance`", async () => {
  const provider = (id: string) => ({ id, url: `https://${id}.example.invalid/v1`, model: "jev-1.13.0", identity: "none", timeoutMs: 1000, keyEnv: "TYPESAFE_API_KEY" });
  const s = await session({ ...config(), jev: { providers: [provider("acc")], capabilities: { assess: [provider("ass")] } } }, { accept: "accepted" }, () => false, "What does src/app.js export?");
  try {
    await s.fake.runTool("foreman_assess", { answer: "It exports answer = 41." }, "f1");
    await s.fake.runTool("jev_acceptance_gate", { answer: "It exports answer = 41." }, "g1");
    const hosts = s.jev.requests.map((r) => new URL(r.url).host);
    assert.equal(hosts[0], "ass.example.invalid", JSON.stringify(hosts));
    assert.ok(!hosts.includes("acc.example.invalid") || hosts.indexOf("acc.example.invalid") > 0, JSON.stringify(hosts));
  } finally { await s.cleanup(); }
});
