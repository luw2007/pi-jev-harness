/**
 * Real Pi host test for the action harness (T016): the installed `pi` runs the adapter in shadow
 * on a fresh temp git repository per task — one JS module with an off-by-one bug and a failing
 * `node --test` test — against a local fake Jev that answers action reviews with permit, accepts the
 * completion `done` Choice, and answers the continuation done/autonomous Noul as not done and not
 * autonomously actionable (the runs are shadow, so a continuation is only recorded, never applied):
 *   (a) explain a function (read); (b) fix the bug (edit); (c) add a helper and its test (create);
 *   (d) run the tests and report (check); plus one enforced(create) run asked to overwrite a file.
 *
 * Model: one cheap non-deepseek model (T009b's), `--model` pinned. Pi has no `--max-time` flag, so
 * each run gets a wall-clock limit here and is killed when it runs over. Model requests are capped
 * per run (MAX_MODEL_REQUESTS / number of runs): a run is killed before it can make one more, so the
 * total can never exceed MAX_MODEL_REQUESTS. HOME is a temp directory whose models.json holds only
 * that provider (key command read from the user's file, read-only); nothing under the real ~/.pi is
 * written. Real Jev is never called: the key is fake and PI_JEV_URL points at the local fake.
 * Run products go through the `pi-jev run` contract: PI_JEV_RUNS_DIR (temp) + PI_JEV_RUN_ID per task.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// PI_JEV_HOST_PROVIDER / PI_JEV_HOST_MODEL override the pinned model when its upstream is down (T040).
const PROVIDER = process.env.PI_JEV_HOST_PROVIDER ?? "gcloud";
const MODEL_ID = process.env.PI_JEV_HOST_MODEL ?? "google/gemini-3-flash";
const MODEL = `${PROVIDER}/${MODEL_ID}`;
const FAKE_KEY = "fake-typesafe-key-for-host-test";
const EXTENSION = resolve(import.meta.dirname, "../../src/adapters/pi/index.ts");
const REAL_HOME = homedir();
/** Wall-clock limit per task (the `--max-time` of this test). */
const MAX_TIME_MS = 240_000;
/** Model requests allowed across every run of this test. */
const MAX_MODEL_REQUESTS = 40;
/** Runs in this test: four shadow tasks plus one enforced(create) run. */
const RUNS = 5;
/** Hard per-run cap; together they never exceed MAX_MODEL_REQUESTS. */
const MAX_MODEL_REQUESTS_PER_RUN = Math.floor(MAX_MODEL_REQUESTS / RUNS);
const PERMIT: Record<string, number> = { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05 };

const RANGE_JS = `/** Numbers from 0 up to, but not including, n. */
export function range(n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(i);
  return out;
}

/** Sum of a list of numbers. */
export function sum(list) {
  return list.reduce((total, x) => total + x, 0);
}
`;
const RANGE_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { range, sum } from "../src/range.js";

test("range(3) has exactly three numbers", () => {
  assert.deepEqual(range(3), [0, 1, 2]);
});

test("sum adds a list", () => {
  assert.equal(sum([1, 2, 3]), 6);
});
`;
const README = "# fixture\n\nOriginal readme; must stay unchanged.\n";

interface FakeJev {
  url: string;
  /** One entry per review request: the reviewed action's kind and path. */
  reviews: { kind: string; path: string }[];
  /** Completion (`done` Choice) and continuation (done/autonomous Noul) requests, in order. */
  assessments: ("completion" | "continuation")[];
  close(): Promise<void>;
}

/** Deterministic continuation answers: the task is not done and has no autonomous next action. */
const CONTINUATION: Record<string, number> = { done: 0.2, autonomous: 0.2 };

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

/**
 * Review Noul → permit; completion `done` Choice → accepted; continuation done/autonomous Noul →
 * CONTINUATION. Anything else is a 400.
 */
async function startFakeJev(): Promise<FakeJev> {
  const reviews: FakeJev["reviews"] = [];
  const assessments: FakeJev["assessments"] = [];
  const reply = (response: ServerResponse, model: string, answers: Record<string, unknown>) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model, answers }));
  };
  const server = createServer(async (request, response) => {
    try {
      const parsed = JSON.parse(await body(request)) as { model: string; state: { action?: { kind: string; path: string } }; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
      const ids = Object.keys(parsed.questions);
      const types = Object.values(parsed.questions).map((q) => q.type);
      if (ids.length === 1 && ids[0] === "done" && types[0] === "choice") {
        assessments.push("completion");
        const options = Object.keys(parsed.questions.done!.criteria ?? {});
        if (!options.includes("accepted")) throw new Error("unexpected done choice");
        const rest = 0.1 / (options.length - 1);
        return reply(response, parsed.model, {
          done: { type: "choice", choice: "accepted", confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === "accepted" ? 0.9 : rest])) },
        });
      }
      if (types.some((t) => t !== "noul")) throw new Error("not a noul request");
      if (!parsed.state.action) {
        if (ids.slice().sort().join(",") !== "autonomous,done") throw new Error("unknown noul request");
        assessments.push("continuation");
        return reply(response, parsed.model, Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: CONTINUATION[id]! }])));
      }
      reviews.push({ kind: parsed.state.action.kind, path: parsed.state.action.path });
      reply(response, parsed.model, Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: PERMIT[id] ?? 0.5 }])));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/systemone`, reviews, assessments, close: () => new Promise<void>((done) => server.close(() => done())) };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function fixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pi-jev-harness-repo-"));
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, "test"));
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  await writeFile(join(repo, "src", "range.js"), RANGE_JS);
  await writeFile(join(repo, "test", "range.test.js"), RANGE_TEST_JS);
  await writeFile(join(repo, "README.md"), README);
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  return repo;
}

async function prepareHome(enforce: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pi-jev-harness-home-"));
  const agentDir = join(home, ".pi", "agent");
  await mkdir(join(agentDir, "pi-jev-harness"), { recursive: true });
  const models = JSON.parse(await readFile(join(REAL_HOME, ".pi", "agent", "models.json"), "utf8")) as { providers: Record<string, { apiKey?: string }> };
  const provider = models.providers[PROVIDER];
  assert.ok(provider, `${PROVIDER} provider missing from the user's models.json`);
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey.replaceAll("$HOME", REAL_HOME) : provider.apiKey;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER]: { ...provider, apiKey } } }));
  // Routers off: every Jev request of this test is an action review.
  const config = { mode: "shadow", outbound: { taskIntent: true }, router: { tools: false }, harness: { enforce } };
  await writeFile(join(agentDir, "pi-jev-harness", "config.json"), JSON.stringify(config));
  return home;
}

interface PiRun {
  code: number | null;
  timedOut: boolean;
  /** Killed because the next model request would exceed the per-run cap. */
  overBudget: boolean;
  stderr: string;
  events: Record<string, unknown>[];
}

function runPi(home: string, cwd: string, extraEnv: Record<string, string>, prompt: string, before: string[] = []): Promise<PiRun> {
  const args = ["-p", "--no-session", "--mode", "json", "--extension", EXTENSION, "--model", MODEL, ...before, prompt];
  assert.ok(!args.some((arg) => /deepseek/i.test(arg)));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TYPESAFE_API_KEY: FAKE_KEY, ...extraEnv };
  delete env.PI_CODING_AGENT_DIR;
  // T040: inherited from this runner, it makes every nested `node --test` exit 0 (child reporter mode).
  delete env.NODE_TEST_CONTEXT;
  const child = spawn("pi", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false, overBudget = false, scanned = 0, requests = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, MAX_TIME_MS);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    // Count finished assistant messages as they stream; stop the run before a request over the cap.
    const end = stdout.lastIndexOf("\n");
    if (end < scanned) return;
    for (const line of stdout.slice(scanned, end).split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } };
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      requests++;
      if (requests >= MAX_MODEL_REQUESTS_PER_RUN && event.message.stopReason === "toolUse" && !overBudget) {
        overBudget = true;
        child.kill("SIGTERM");
      }
    }
    scanned = end + 1;
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, timedOut, overBudget, stderr, events: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) });
    });
  });
}

interface Receipt {
  receipt: {
    actionId: string;
    request: unknown;
    execution: { status: string; reason: string | null; evidence: { toolCallId: string; toolName: string; exitCode: number | null; outcome: string }[] };
    verification: { status: string; evidenceRefs: string[]; note: string | null };
  };
}

interface RunJson {
  status: string;
  changes: { path: string; change: string }[];
  verification: { name: string; status: string; evidenceRefs: string[] }[];
  remaining: string[];
  reasons: string[];
  completion?: { status: string; stopAllowed: boolean | null; assessment: string | null; continuations: { used: number; max: number } };
}

interface TaskOutcome {
  name: string;
  run: PiRun;
  runJson: RunJson;
  /** Action receipts (one per tool call); continuation decisions are in `continuations`. */
  receipts: Receipt[];
  continuations: Receipt[];
  modelRequests: number;
  toolEnds: { toolCallId: string; toolName: string; isError: boolean; text: string }[];
  blockedCalls: number;
  reviews: FakeJev["reviews"];
  repo: string;
}

function toolEnds(events: Record<string, unknown>[]): TaskOutcome["toolEnds"] {
  return events.filter((event) => event.type === "tool_execution_end").map((event) => {
    const result = event.result as { content?: { type: string; text?: string }[] } | undefined;
    return {
      toolCallId: String(event.toolCallId),
      toolName: String(event.toolName),
      isError: event.isError === true,
      text: (result?.content ?? []).map((block) => block.text ?? "").join("\n"),
    };
  });
}

function assistantMessages(events: Record<string, unknown>[]): { provider: string; model: string }[] {
  return events
    .filter((event) => event.type === "message_end" && (event.message as { role?: string }).role === "assistant")
    .map((event) => {
      const message = event.message as { provider: string; model: string };
      return { provider: message.provider, model: message.model };
    });
}

async function runTask(jev: FakeJev, runsDir: string, cleanup: string[], name: string, runId: string, prompt: string, enforce: string[] = []): Promise<TaskOutcome> {
  const repo = await fixtureRepo();
  const home = await prepareHome(enforce);
  cleanup.push(repo, home);
  const before = jev.reviews.length;
  // T046: since T044 (H1) shadow never blocks and config refuses mode on, so the enforced run
  // switches the session to on first; the other runs stay in the config's shadow.
  const run = await runPi(home, repo, { PI_JEV_URL: jev.url, PI_JEV_RUNS_DIR: runsDir, PI_JEV_RUN_ID: runId }, prompt, enforce.length > 0 ? ["/jev mode on"] : []);
  const dirs = (await readdir(runsDir)).filter((dir) => dir.startsWith(runId));
  assert.deepEqual(dirs, [runId], `${name}: exactly the injected run directory; stderr: ${run.stderr}`);
  await assert.rejects(readdir(join(home, ".pi", "agent", "pi-jev-harness", "runs")), { code: "ENOENT" }, `${name}: default runs dir unused`);
  const dir = join(runsDir, runId);
  const runJson = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as RunJson;
  const all = (await readFile(join(dir, "receipts.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Receipt);
  const isContinuation = (r: Receipt) => r.receipt.actionId.startsWith("continuation_");
  const ends = toolEnds(run.events);
  const messages = assistantMessages(run.events);
  for (const message of messages) assert.ok(!/deepseek/i.test(`${message.provider}/${message.model}`));
  assert.ok(messages.every((m) => m.provider === PROVIDER && m.model === MODEL_ID), `${name}: model stays ${MODEL}`);
  return {
    name,
    run,
    runJson,
    receipts: all.filter((r) => !isContinuation(r)),
    continuations: all.filter(isContinuation),
    modelRequests: messages.length,
    toolEnds: ends,
    blockedCalls: ends.filter((end) => end.isError && end.text.startsWith("pi-jev-harness:")).length,
    reviews: jev.reviews.slice(before),
    repo,
  };
}

function report(outcome: TaskOutcome) {
  const checks = outcome.receipts
    .filter((r) => r.receipt.verification.note !== null)
    .map((r) => `${r.receipt.verification.note} → exit ${r.receipt.execution.evidence.at(-1)?.exitCode ?? "none"} (${r.receipt.verification.status})`);
  console.log([
    `${outcome.name}: exit=${outcome.run.code}${outcome.run.timedOut ? " (killed at max time)" : ""}${outcome.run.overBudget ? " (killed at request cap)" : ""} status=${outcome.runJson.status}`,
    `changes=${JSON.stringify(outcome.runJson.changes.map((c) => `${c.change}:${c.path}`))}`,
    `checks=${JSON.stringify(checks)}`,
    `receipts=${outcome.receipts.length} toolResults=${outcome.toolEnds.length - outcome.blockedCalls} blocked=${outcome.blockedCalls}`,
    `tools=${JSON.stringify(outcome.toolEnds.map((end) => `${end.toolName}${end.isError ? "!" : ""}`))}`,
    `jevReviews=${JSON.stringify(outcome.reviews.map((r) => `${r.kind}:${r.path}`))} modelRequests=${outcome.modelRequests}`,
    `completion=${JSON.stringify(outcome.runJson.completion)} continuationReceipts=${outcome.continuations.length}`,
    `remaining=${JSON.stringify(outcome.runJson.remaining)} reasons=${JSON.stringify(outcome.runJson.reasons)}`,
  ].join("\n  "));
}

/** Every review that left the machine belongs to an action whose local validation passed. */
function assertOutboundAfterValidation(outcome: TaskOutcome) {
  const sent = outcome.receipts.filter((r) => r.receipt.request !== null);
  assert.equal(sent.length, outcome.reviews.length, `${outcome.name}: one recorded request per review received`);
  for (const r of sent) assert.doesNotMatch(r.receipt.execution.reason ?? "", /validation failed/, `${outcome.name}: review sent only after validation passed`);
}

test("real pi: shadow harness on read/edit/create/check tasks, and enforced(create) blocks an overwrite", { timeout: 1_500_000 }, async () => {
  const jev = await startFakeJev();
  const runsDir = await mkdtemp(join(tmpdir(), "pi-jev-harness-runs-"));
  const cleanup: string[] = [runsDir];
  const outcomes: TaskOutcome[] = [];
  try {
    outcomes.push(await runTask(jev, runsDir, cleanup, "(a) read", "t016-a-read",
      "Read src/range.js and explain in two sentences what the function `sum` does. Do not modify any file and do not run any command."));
    outcomes.push(await runTask(jev, runsDir, cleanup, "(b) edit", "t016-b-edit",
      "src/range.js has an off-by-one bug: range(n) must return exactly n numbers starting at 0. Fix it with the edit tool. Do not run any command or test."));
    outcomes.push(await runTask(jev, runsDir, cleanup, "(c) create", "t016-c-create",
      "Create a new file src/clamp.js exporting `clamp(x, lo, hi)`, and a new test file test/clamp.test.js that tests it with node:test. Use the write tool for both files. Do not run any command."));
    outcomes.push(await runTask(jev, runsDir, cleanup, "(d) check", "t016-d-check",
      "Run `node --test` in the repository root with the bash tool, exactly once, and report whether the tests passed. Do not modify any file."));
    const enforced = await runTask(jev, runsDir, cleanup, "(e) enforced(create)", "t016-e-enforced",
      "Use the write tool to replace the entire content of the existing file README.md with the single line `replaced`. Do not read it first. If the write is blocked, do not retry and do not use any other tool; just report what happened.",
      ["create"]);
    outcomes.push(enforced);
    for (const outcome of outcomes) report(outcome);
    const totalModelRequests = outcomes.reduce((sum, o) => sum + o.modelRequests, 0);
    console.log(`model requests total: ${totalModelRequests} (limit ${MAX_MODEL_REQUESTS}); fake Jev reviews total: ${jev.reviews.length}; assessments: ${JSON.stringify(jev.assessments)}`);

    assert.ok(totalModelRequests <= MAX_MODEL_REQUESTS, "model request budget");
    for (const outcome of outcomes) {
      assert.equal(outcome.run.timedOut, false, `${outcome.name}: finished within max time`);
      assert.equal(outcome.run.overBudget, false, `${outcome.name}: finished within ${MAX_MODEL_REQUESTS_PER_RUN} model requests`);
      assert.equal(outcome.run.code, 0, `${outcome.name}: ${outcome.run.stderr}`);
      assert.equal(outcome.receipts.length, outcome.toolEnds.length, `${outcome.name}: one receipt per tool call`);
      assertOutboundAfterValidation(outcome);
    }
    const [a, b, c, d] = outcomes as [TaskOutcome, TaskOutcome, TaskOutcome, TaskOutcome];
    for (const shadow of [a, b, c, d]) {
      assert.equal(shadow.blockedCalls, 0, `${shadow.name}: shadow blocks nothing`);
      assert.equal(shadow.receipts.length, shadow.toolEnds.length, `${shadow.name}: receipts = tool results`);
      // Shadow computes continuation decisions but never applies one.
      assert.ok(shadow.continuations.every((r) => r.receipt.execution.status === "not_requested"), `${shadow.name}: no continuation applied`);
      assert.equal(shadow.runJson.completion?.continuations.used, 0, `${shadow.name}: no continuation used`);
    }

    assert.deepEqual(a.runJson.changes, [], "(a) changes nothing");
    assert.equal(a.runJson.status, "completed", "(a) a question without changes completes: host evidence has no gap and Jev accepts");
    assert.equal(a.runJson.completion?.status, "passed", "(a) completion assessment passed");

    assert.ok(b.runJson.changes.some((change) => change.path === "src/range.js" && change.change === "modified"), "(b) lists the fixed file");
    if (b.runJson.verification.length === 0) assert.equal(b.runJson.status, "incomplete", "(b) changed code without a check is incomplete");

    assert.ok(c.runJson.changes.some((change) => change.path === "src/clamp.js" && change.change === "added"), "(c) lists the new file");
    if (c.runJson.verification.length === 0) assert.equal(c.runJson.status, "incomplete", "(c) new code without a check is incomplete");

    const check = d.receipts.find((r) => r.receipt.verification.note !== null && /node --test/.test(r.receipt.verification.note));
    assert.ok(check, "(d) recorded the check command");
    const recordedExit = check.receipt.execution.evidence.at(-1)!.exitCode;
    const { NODE_TEST_CONTEXT: _nested, ...plainEnv } = process.env;
    const actual = spawnSync("node", ["--test"], { cwd: d.repo, encoding: "utf8", env: plainEnv });
    console.log(`(d) recorded exit code ${recordedExit}; actual \`node --test\` exit code in the same repo ${actual.status}`);
    assert.equal(recordedExit, actual.status, "(d) exit code matches reality");
    assert.notEqual(actual.status, 0, "(d) the fixture test really fails");
    assert.equal(check.receipt.verification.status, "failed", "(d) failure archived as failed");
    assert.ok(d.runJson.verification.some((v) => v.status === "failed"));
    assert.equal(d.runJson.status, "incomplete", "(d) a failed check is archived as incomplete, never completed");

    assert.ok(enforced.blockedCalls >= 1, "(e) the write was blocked");
    assert.ok(enforced.receipts.some((r) => r.receipt.execution.status === "blocked"), "(e) block is on the receipt");
    assert.equal(enforced.runJson.status, "blocked");
    assert.equal(await readFile(join(enforced.repo, "README.md"), "utf8"), README, "(e) README.md unchanged");
    assert.equal(enforced.reviews.length, 0, "(e) blocked by local validation before any Jev request");
  } finally {
    await jev.close();
    await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
