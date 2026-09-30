/**
 * Real Pi host test: runs the installed `pi` with the adapter against a local fake Jev service
 * and compares what the host actually did:
 *   1. off, `--model` on the command line;
 *   2. shadow, `--model` on the command line;
 *   3. shadow, no `--model`: the default model comes from the temp agent dir's `settings.json`
 *      (`defaultProvider` / `defaultModel`);
 *   4. shadow with `outbound.taskIntent: false`: the fake Jev must receive zero requests.
 * Shadow runs 2–3 set `outbound.taskIntent: true` (otherwise nothing is sent). Every config keeps a
 * legacy `router.models` (three non-deepseek models): since T051 model selection is magpie's, so it
 * must be ignored; no run may ask a model question or change the model. Tool routing still observes.
 *
 * Model: one cheap non-deepseek model, one model request per run (4 per test run, ≤ 6 total). HOME
 * is a temp directory; its `.pi/agent/models.json` holds only that provider, whose key command reads
 * the user's credential file by absolute path (read-only). Nothing under the real ~/.pi is touched.
 * Real Jev is never called: TYPESAFE_API_KEY is a fake value and PI_JEV_URL points at the fake.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// PI_JEV_HOST_PROVIDER / PI_JEV_HOST_MODEL override the pinned model when its upstream is down (T040).
const PROVIDER = process.env.PI_JEV_HOST_PROVIDER ?? "gcloud";
const MODEL_ID = process.env.PI_JEV_HOST_MODEL ?? "google/gemini-3-flash";
const MODEL = `${PROVIDER}/${MODEL_ID}`;
/** Legacy `router.models.allow` (T051: ignored): three non-deepseek models of the test provider. */
const ALLOW = process.env.PI_JEV_HOST_ALLOW?.split(",") ?? [MODEL, `${PROVIDER}/google/gemini-3.1-flash-lite`, `${PROVIDER}/google/gemini-3.1-pro-low`];
const PROMPT = "Reply with exactly the single word OK and nothing else. Do not use any tools.";
const FAKE_KEY = "fake-typesafe-key-for-host-test";
const EXTENSION = resolve(import.meta.dirname, "../../src/adapters/pi/index.ts");
const REAL_HOME = homedir();

type QuestionKind = "tool" | "model";

interface FakeJev {
  url: string;
  /** Question kinds of every request received, in order (one entry per question). */
  questions: QuestionKind[];
  requests: number;
  /** Every candidate id offered in model questions. */
  modelCandidates: string[];
  /** The fake's answer to each model question. */
  modelChoices: string[];
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

/** The question in the request body tells a tool-routing request from a model-routing one. */
function questionKind(id: string, question: { instructions?: unknown }): QuestionKind | undefined {
  const text = typeof question.instructions === "string" ? question.instructions : "";
  if (id === "tool" && text.startsWith("Which available tool")) return "tool";
  if (id === "model" && text.startsWith("Which candidate model")) return "model";
  return undefined;
}

/**
 * Counts requests and answers each question with a valid Choice built from the candidate set in
 * the request body. Tool questions: first non-clarification option leads. Model questions: the
 * first candidate that is neither the configured model nor a deepseek model leads, so an applied
 * suggestion would show (and never names deepseek).
 */
async function startFakeJev(): Promise<FakeJev> {
  const state = { requests: 0, questions: [] as QuestionKind[], modelCandidates: [] as string[], modelChoices: [] as string[] };
  const server = createServer(async (request, response) => {
    state.requests++;
    let parsed: { model: string; questions: Record<string, { instructions?: unknown; criteria: Record<string, string> }> };
    let kinds: Record<string, QuestionKind>;
    try {
      parsed = JSON.parse(await body(request));
      if (!parsed.questions || typeof parsed.questions !== "object") throw new Error("no questions");
      kinds = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => {
        const kind = questionKind(id, question);
        if (!kind || !question.criteria || Object.keys(question.criteria).length < 2) throw new Error("unknown question");
        return [id, kind];
      }));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => {
      const ids = Object.keys(question.criteria);
      state.questions.push(kinds[id]!);
      if (kinds[id] === "model") state.modelCandidates.push(...ids);
      const isModel = kinds[id] === "model";
      const choice = ids.find((option) => option !== "needs_clarification" && !(isModel && (option === MODEL || /deepseek/i.test(option)))) ?? ids[0]!;
      if (isModel) state.modelChoices.push(choice);
      const rest = 0.3 / (ids.length - 1);
      return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(ids.map((option) => [option, option === choice ? 0.7 : rest])) }];
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: parsed.model, answers }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    get requests() { return state.requests; },
    questions: state.questions,
    modelCandidates: state.modelCandidates,
    modelChoices: state.modelChoices,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * Temp HOME with a models.json holding only the test provider; key read from the real credential
 * file. With `defaultModel`, the temp agent dir's settings.json names the startup model (the
 * user's global settings are not read: HOME is the temp dir and PI_CODING_AGENT_DIR is unset).
 */
async function prepareHome(mode: "off" | "shadow", options: { defaultModel?: boolean; taskIntent?: boolean } = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `pi-jev-host-${mode}-`));
  const agentDir = join(home, ".pi", "agent");
  await mkdir(join(agentDir, "pi-jev-harness"), { recursive: true });
  const models = JSON.parse(await readFile(join(REAL_HOME, ".pi", "agent", "models.json"), "utf8")) as { providers: Record<string, { apiKey?: string; models: { id: string }[] }> };
  const provider = models.providers[PROVIDER];
  assert.ok(provider, `${PROVIDER} provider missing from the user's models.json`);
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey.replaceAll("$HOME", REAL_HOME) : provider.apiKey;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER]: { ...provider, apiKey } } }));
  const config = { mode, outbound: { taskIntent: options.taskIntent ?? true }, router: { models: { allow: ALLOW, excludeProviders: ["deepseek"] } } };
  await writeFile(join(agentDir, "pi-jev-harness", "config.json"), JSON.stringify(config));
  if (options.defaultModel) await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL_ID }));
  return home;
}

interface RunResult {
  code: number | null;
  stderr: string;
  events: Record<string, unknown>[];
}

function runPi(home: string, cwd: string, jevUrl: string, options: { pinModel: boolean }): Promise<RunResult> {
  const args = ["-p", "--no-session", "--mode", "json", "--extension", EXTENSION, ...(options.pinModel ? ["--model", MODEL] : []), PROMPT];
  assert.ok(!args.some((arg) => /deepseek/i.test(arg)));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TYPESAFE_API_KEY: FAKE_KEY, PI_JEV_URL: jevUrl };
  delete env.PI_CODING_AGENT_DIR;
  const child = spawn("pi", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", (code) => done({ code, stderr, events: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) }));
  });
}

interface ModelRequest {
  provider: string;
  model: string;
  stopReason: string;
  tools: string[];
}

/** One row per assistant message: its provider/model and the tool set Pi had declared by then. */
function modelRequests(events: Record<string, unknown>[]): ModelRequest[] {
  const tools = new Set<string>();
  const rows: ModelRequest[] = [];
  for (const event of events) {
    if (event.type !== "message_end") continue;
    const message = event.message as Record<string, unknown>;
    if (message.role === "system") {
      for (const tool of (message.toolsAdded as { name: string }[] | undefined) ?? []) tools.add(tool.name);
      for (const tool of (message.toolsRemoved as { name: string }[] | undefined) ?? []) tools.delete(tool.name);
    }
    if (message.role === "assistant")
      rows.push({ provider: String(message.provider), model: String(message.model), stopReason: String(message.stopReason), tools: [...tools].sort() });
  }
  return rows;
}

async function telemetry(home: string): Promise<string> {
  const dir = join(home, ".pi", "agent", "pi-jev-harness", "telemetry");
  const names = await readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("");
}

type TelemetryRow = { kind: string; outcome: string; source: string };

function telemetryRows(text: string): TelemetryRow[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TelemetryRow);
}

function count(kinds: readonly QuestionKind[]) {
  return { tool: kinds.filter((kind) => kind === "tool").length, model: kinds.filter((kind) => kind === "model").length };
}

test("real pi: off and unauthorized outbound send no Jev request; shadow observes tools without changing model or tools; no model routing", { timeout: 600_000 }, async () => {
  const jev = await startFakeJev();
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-host-cwd-"));
  const homes: string[] = [];
  try {
    const offHome = await prepareHome("off");
    homes.push(offHome);
    const off = await runPi(offHome, cwd, jev.url, { pinModel: true });
    const offJevRequests = jev.requests;
    const offQuestions = count(jev.questions);

    const shadowHome = await prepareHome("shadow");
    homes.push(shadowHome);
    const shadow = await runPi(shadowHome, cwd, jev.url, { pinModel: true });
    const shadowJevRequests = jev.requests - offJevRequests;
    const pinnedQuestionCount = jev.questions.length;
    const shadowQuestions = count(jev.questions.slice(offQuestions.tool + offQuestions.model));

    const settingsHome = await prepareHome("shadow", { defaultModel: true });
    homes.push(settingsHome);
    const settingsRun = await runPi(settingsHome, cwd, jev.url, { pinModel: false });
    const settingsJevRequests = jev.requests - offJevRequests - shadowJevRequests;
    const settingsQuestions = count(jev.questions.slice(pinnedQuestionCount));
    const beforeWithheld = jev.requests;

    const withheldHome = await prepareHome("shadow", { taskIntent: false });
    homes.push(withheldHome);
    const withheldRun = await runPi(withheldHome, cwd, jev.url, { pinModel: true });
    const withheldJevRequests = jev.requests - beforeWithheld;

    const offRequests = modelRequests(off.events);
    const shadowRequests = modelRequests(shadow.events);
    const settingsRequests = modelRequests(settingsRun.events);
    const withheldRequests = modelRequests(withheldRun.events);
    const offTelemetry = await telemetry(offHome);
    const shadowTelemetry = await telemetry(shadowHome);
    const settingsTelemetry = await telemetry(settingsHome);
    const withheldTelemetry = await telemetry(withheldHome);
    const shadowKinds = telemetryRows(shadowTelemetry);
    const settingsKinds = telemetryRows(settingsTelemetry);
    const withheldKinds = telemetryRows(withheldTelemetry);
    const summary = (rows: TelemetryRow[]) => JSON.stringify(rows.map((event) => `${event.kind}:${event.outcome}:${event.source}`));

    console.log(`off (--model):              exit=${off.code} fakeJevRequests=${offJevRequests} questions=${JSON.stringify(offQuestions)} modelRequests=${JSON.stringify(offRequests)}`);
    console.log(`shadow (--model):           exit=${shadow.code} fakeJevRequests=${shadowJevRequests} questions=${JSON.stringify(shadowQuestions)} modelRequests=${JSON.stringify(shadowRequests)}`);
    console.log(`shadow (settings.json):     exit=${settingsRun.code} fakeJevRequests=${settingsJevRequests} questions=${JSON.stringify(settingsQuestions)} modelRequests=${JSON.stringify(settingsRequests)}`);
    console.log(`shadow (taskIntent=false):  exit=${withheldRun.code} fakeJevRequests=${withheldJevRequests} modelRequests=${JSON.stringify(withheldRequests)}`);
    console.log(`off telemetry bytes: ${offTelemetry.length}`);
    console.log(`shadow (--model) telemetry:          ${summary(shadowKinds)}`);
    console.log(`shadow (settings.json) telemetry:    ${summary(settingsKinds)}`);
    console.log(`shadow (taskIntent=false) telemetry: ${summary(withheldKinds)}`);

    assert.equal(off.code, 0, off.stderr);
    assert.equal(shadow.code, 0, shadow.stderr);
    assert.equal(settingsRun.code, 0, settingsRun.stderr);
    assert.equal(withheldRun.code, 0, withheldRun.stderr);
    assert.equal(offJevRequests, 0, "off must not contact Jev");
    assert.ok(shadowJevRequests > 0, "shadow must consult Jev");
    assert.ok(offRequests.length >= 1 && offRequests.length === shadowRequests.length, "same number of model requests");
    assert.ok(offRequests.length + shadowRequests.length + settingsRequests.length + withheldRequests.length <= 6, "model request budget");
    for (const row of [...offRequests, ...shadowRequests, ...settingsRequests, ...withheldRequests]) {
      assert.equal(row.stopReason, "stop");
      assert.ok(!/deepseek/i.test(row.model));
    }
    assert.deepEqual(
      shadowRequests.map(({ provider, model, tools }) => ({ provider, model, tools })),
      offRequests.map(({ provider, model, tools }) => ({ provider, model, tools })),
      "shadow must use the same provider/model and tool set as off for every model request",
    );
    assert.equal(offRequests[0]!.provider, PROVIDER);
    assert.equal(offRequests[0]!.model, MODEL_ID);
    assert.ok(shadowKinds.some((event) => event.kind === "route_tools"));
    for (const rows of [shadowKinds, settingsKinds, withheldKinds])
      assert.ok(rows.every((event) => event.kind !== "route_model"), "T051: no model routing telemetry");
    assert.ok(!shadowTelemetry.includes(PROMPT) && !shadowTelemetry.includes("single word OK"), "no task text in telemetry");
    assert.ok(!shadowTelemetry.includes(FAKE_KEY), "no key in telemetry");
    assert.equal(offTelemetry, "", "off writes no route telemetry");

    // Run 3: without a pin the model comes from settings.json; no model question is ever asked (T051).
    assert.deepEqual([offQuestions.model, shadowQuestions.model, settingsQuestions.model], [0, 0, 0], "T051: no model question");
    assert.deepEqual(jev.modelCandidates, [], "T051: no model candidate leaves the machine");
    assert.ok(settingsQuestions.tool > 0, "settings default model: shadow still asks the tool question");
    assert.ok(settingsRequests.length >= 1);
    for (const row of settingsRequests) {
      assert.equal(row.provider, PROVIDER, "provider from settings.json, not Jev's suggestion");
      assert.equal(row.model, MODEL_ID, "model from settings.json, not Jev's suggestion");
    }
    assert.deepEqual(settingsRequests.map(({ tools }) => tools), offRequests.map(({ tools }) => tools), "tool set unchanged");
    assert.ok(!settingsTelemetry.includes(PROMPT) && !settingsTelemetry.includes(FAKE_KEY), "no task text or key in telemetry");

    // Run 4: outbound.taskIntent=false sends nothing and records withheld.
    assert.equal(withheldJevRequests, 0, "taskIntent=false: fake Jev receives zero requests");
    assert.deepEqual(withheldKinds.filter((event) => event.kind.startsWith("route_")).map((event) => `${event.kind}:${event.outcome}:${event.source}`),
      ["route_tools:withheld:outbound:not_authorized"]);
    // T040: the completion check (T027) is recorded too; without outbound consent it is unavailable, never ok.
    assert.deepEqual(withheldKinds.filter((event) => !event.kind.startsWith("route_")).map((event) => `${event.kind}:${event.outcome}`), ["completion:unavailable"]);
    assert.deepEqual(withheldRequests.map(({ provider, model, tools }) => ({ provider, model, tools })),
      offRequests.map(({ provider, model, tools }) => ({ provider, model, tools })), "withheld shadow leaves model and tools unchanged");
  } finally {
    await jev.close();
    await Promise.all([cwd, ...homes].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
