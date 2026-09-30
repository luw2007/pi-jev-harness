/**
 * OPT-IN live variant of the OMP host test (the default host test is omp-shadow-offline.test.ts,
 * which uses no real model). Runs only with PI_JEV_OMP_LIVE=1 and these variables:
 *   PI_JEV_OMP_LIVE_PROVIDER   provider name (must not be deepseek, must not be in the real
 *                              ~/.omp/agent/config.yml `disabledProviders`; the test refuses otherwise)
 *   PI_JEV_OMP_LIVE_MODEL      model id at that provider
 *   PI_JEV_OMP_LIVE_BASE_URL   the provider's OpenAI-compatible base URL
 *   PI_JEV_OMP_LIVE_KEY_ENV    name of the env variable holding that provider's key
 * The child gets a minimal env allowlist: PATH, HOME (temp), TMPDIR, the fake Jev key/URL and
 * only that one provider key (never DEEPSEEK_API_KEY, no other key). Model requests go through a
 * local recording proxy that forwards at most 6 and refuses the rest locally; `retry.modelFallback`
 * and retries are off via `--config`. HOME, config and telemetry are temp directories.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const LIVE = process.env.PI_JEV_OMP_LIVE === "1";
const PROVIDER = process.env.PI_JEV_OMP_LIVE_PROVIDER ?? "";
const MODEL_ID = process.env.PI_JEV_OMP_LIVE_MODEL ?? "";
const MODEL = `${PROVIDER}/${MODEL_ID}`;
const KEY_ENV = process.env.PI_JEV_OMP_LIVE_KEY_ENV ?? "";
const PROMPT = "Reply with exactly the single word OK and nothing else. Do not use any tools.";
const FAKE_KEY = "fake-typesafe-key-for-omp-host-test";
const EXTENSION = resolve(import.meta.dirname, "../../src/adapters/omp/index.ts");
const REAL_HOME = homedir();
const OMP = "/opt/homebrew/bin/omp";
const MAX_MODEL_REQUESTS = 6;

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return (server.address() as AddressInfo).port;
}

const close = (server: Server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });

/** Fake Jev: answers every Choice question with its first option and counts requests. */
async function startFakeJev() {
  const state = { requests: 0 };
  const server = createServer(async (request, response) => {
    state.requests++;
    try {
      const parsed = JSON.parse(await body(request)) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
      const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => {
        const options = Object.keys(question.criteria);
        const rest = 0.3 / (options.length - 1);
        return [id, { type: "choice", choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest])) }];
      }));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: parsed.model, answers }));
    } catch {
      response.writeHead(400).end();
    }
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/v1/systemone`, state, close: () => close(server) };
}

interface ModelCall {
  model: string;
  tools: string[];
}

/** Recording proxy in front of the real provider endpoint. */
async function startModelProxy(upstream: string) {
  const calls: ModelCall[] = [];
  /** Requests beyond `limit` are answered locally with a non-retryable 400 and never forwarded. */
  const budget = { limit: 0, forwarded: 0, refused: 0 };
  const base = new URL(upstream.endsWith("/") ? upstream : `${upstream}/`);
  const server = createServer(async (request, response) => {
    const text = await body(request);
    if (request.method === "POST") {
      try {
        const parsed = JSON.parse(text) as { model?: string; tools?: { function?: { name?: string }; name?: string }[] };
        calls.push({ model: String(parsed.model), tools: (parsed.tools ?? []).map((tool) => String(tool.function?.name ?? tool.name)).sort() });
      } catch {
        calls.push({ model: "<unparsed>", tools: [] });
      }
    }
    if (request.method === "POST") {
      if (budget.forwarded >= budget.limit) {
        budget.refused++;
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "host test model request budget exhausted", type: "invalid_request_error" } }));
        return;
      }
      budget.forwarded++;
    }
    const target = new URL(request.url!.replace(/^\/+/, ""), base);
    const headers = { ...request.headers, host: target.host, "content-length": String(Buffer.byteLength(text)) };
    const forward = httpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    forward.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    forward.end(text);
  });
  const port = await listen(server);
  return { baseUrl: `http://127.0.0.1:${port}/`, calls, budget, close: () => close(server) };
}

/** The user's disabled providers, read-only from the real OMP config (`disabledProviders:` list). */
async function disabledProviders(): Promise<string[]> {
  const text = await readFile(join(REAL_HOME, ".omp", "agent", "config.yml"), "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^disabledProviders:\s*$/.test(line));
  if (at < 0) {
    const inline = /^disabledProviders:\s*\[(.*)\]\s*$/m.exec(text);
    return inline ? inline[1]!.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
  }
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (!item) break;
    out.push(item[1]!);
  }
  return out;
}

/** Validates the live settings; throws (refuses) on anything not allowed. */
async function liveProvider(): Promise<{ upstream: string; header: string }> {
  const upstream = process.env.PI_JEV_OMP_LIVE_BASE_URL ?? "";
  assert.ok(PROVIDER && MODEL_ID && upstream && KEY_ENV, "PI_JEV_OMP_LIVE_PROVIDER/_MODEL/_BASE_URL/_KEY_ENV are required");
  assert.ok(/^[A-Za-z0-9_-]+$/.test(PROVIDER) && /^[A-Z][A-Z0-9_]*$/.test(KEY_ENV));
  assert.ok(!/deepseek/i.test(`${PROVIDER} ${MODEL_ID} ${KEY_ENV}`), "deepseek is never allowed");
  const disabled = await disabledProviders();
  assert.ok(!disabled.includes(PROVIDER), `provider ${PROVIDER} is disabled by the user (disabledProviders); refusing`);
  assert.ok(process.env[KEY_ENV], `${KEY_ENV} is not set`);
  // OMP reads the key from the child's env through a key command; the value never lands on disk.
  return { upstream, header: [`    apiKey: '!printenv ${KEY_ENV}'`, "    api: openai-completions"].join("\n") };
}

async function prepareHome(mode: "off" | "shadow", proxyUrl: string, header: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `omp-jev-host-${mode}-`));
  const agentDir = join(home, ".omp", "agent");
  await mkdir(join(agentDir, "pi-jev-harness"), { recursive: true });
  await writeFile(join(agentDir, "models.yml"), [
    "providers:",
    `  ${PROVIDER}:`,
    `    baseUrl: ${proxyUrl}`,
    header,
    "    models:",
    `    - id: ${MODEL_ID}`,
    "      name: Test Model",
    "      reasoning: false",
    "      input: [text]",
    "      contextWindow: 1000000",
    "      maxTokens: 8192",
    "",
  ].join("\n"));
  await writeFile(join(home, "overlay.yml"), "retry:\n  modelFallback: false\n  usageAwareFallback: false\n  maxRetries: 0\n");
  const config = { mode, outbound: { taskIntent: true } };
  await writeFile(join(agentDir, "pi-jev-harness", "config.json"), JSON.stringify(config));
  return home;
}

interface RunResult {
  code: number | null;
  stderr: string;
  events: Record<string, unknown>[];
}

function runOmp(home: string, cwd: string, jevUrl: string): Promise<RunResult> {
  const args = ["-p", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-lsp",
    "--config", join(home, "overlay.yml"), "--model", MODEL, "--extension", EXTENSION, PROMPT];
  assert.ok(!args.some((arg) => /deepseek/i.test(arg)));
  // Minimal allowlist: only the chosen provider's key, nothing else inherited.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), TYPESAFE_API_KEY: FAKE_KEY, PI_JEV_URL: jevUrl, [KEY_ENV]: process.env[KEY_ENV] };
  assert.ok(!("DEEPSEEK_API_KEY" in env));
  const child = spawn(OMP, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr, events: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) });
    });
  });
}

/** Assistant messages as OMP reported them: provider, model, stop reason. */
function assistantRows(events: Record<string, unknown>[]) {
  return events.filter((event) => event.type === "message_end" && (event.message as { role?: string }).role === "assistant")
    .map((event) => {
      const message = event.message as Record<string, unknown>;
      return { provider: String(message.provider), model: String(message.model), stopReason: String(message.stopReason) };
    });
}

async function telemetry(home: string): Promise<string> {
  const dir = join(home, ".omp", "agent", "pi-jev-harness", "telemetry");
  const names = await readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("");
}

test("LIVE real omp: off sends no Jev request; shadow consults Jev without changing provider/model or tools", { timeout: 600_000, skip: LIVE ? false : "set PI_JEV_OMP_LIVE=1 (see header) to run against a real provider" }, async () => {
  const { upstream, header } = await liveProvider();
  const jev = await startFakeJev();
  const proxy = await startModelProxy(upstream);
  const cwd = await mkdtemp(join(tmpdir(), "omp-jev-host-cwd-"));
  const homes: string[] = [];
  try {
    const offHome = await prepareHome("off", proxy.baseUrl, header);
    homes.push(offHome);
    proxy.budget.limit = MAX_MODEL_REQUESTS / 2;
    const off = await runOmp(offHome, cwd, jev.url);
    const offJev = jev.state.requests;
    const offCalls = proxy.calls.splice(0);

    const shadowHome = await prepareHome("shadow", proxy.baseUrl, header);
    homes.push(shadowHome);
    proxy.budget.limit = MAX_MODEL_REQUESTS;
    const shadow = await runOmp(shadowHome, cwd, jev.url);
    const shadowJev = jev.state.requests - offJev;
    const shadowCalls = proxy.calls.splice(0);

    const offRows = assistantRows(off.events);
    const shadowRows = assistantRows(shadow.events);
    const offTelemetry = await telemetry(offHome);
    const shadowTelemetry = await telemetry(shadowHome);
    const shadowKinds = shadowTelemetry.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; outcome: string; source?: string });

    console.log(`off:    exit=${off.code} fakeJevRequests=${offJev} assistant=${JSON.stringify(offRows)}`);
    console.log(`        modelRequests=${JSON.stringify(offCalls)}`);
    console.log(`shadow: exit=${shadow.code} fakeJevRequests=${shadowJev} assistant=${JSON.stringify(shadowRows)}`);
    console.log(`        modelRequests=${JSON.stringify(shadowCalls)}`);
    console.log(`shadow telemetry: ${JSON.stringify(shadowKinds.map((event) => `${event.kind}:${event.outcome}:${event.source ?? ""}`))}`);
    console.log(`model requests forwarded to the real endpoint: ${proxy.budget.forwarded} (refused locally over budget: ${proxy.budget.refused})`);
    console.log(`off telemetry bytes: ${offTelemetry.length}`);

    assert.ok(proxy.budget.forwarded <= MAX_MODEL_REQUESTS, "model request budget");
    assert.equal(proxy.budget.refused, 0, "no run exceeded its model request budget");
    for (const call of [...offCalls, ...shadowCalls]) assert.ok(!/deepseek/i.test(call.model));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(shadow.code, 0, shadow.stderr);
    assert.equal(offJev, 0, "off must not contact Jev");
    assert.ok(shadowJev > 0, "shadow must consult Jev");
    assert.ok(offCalls.length >= 1 && offRows.length >= 1);
    // Same provider/model as reported by OMP, and same model id + tool set on the wire.
    assert.deepEqual(shadowRows.map(({ provider, model }) => ({ provider, model })), offRows.map(({ provider, model }) => ({ provider, model })));
    assert.equal(offRows[0]!.provider, PROVIDER);
    assert.equal(offRows[0]!.model, MODEL_ID);
    assert.deepEqual(shadowCalls, offCalls, "every model request: same model id and tool set");
    assert.ok(offCalls.every((call) => call.model === MODEL_ID));
    assert.equal(offTelemetry, "", "off writes no telemetry");
    assert.ok(shadowKinds.some((event) => event.kind === "route_tools"));
    assert.ok(shadowKinds.every((event) => event.kind !== "route_model"), "no model routing (T104)");
    assert.ok(!shadowTelemetry.includes(PROMPT) && !shadowTelemetry.includes(FAKE_KEY), "no task text or key in telemetry");
  } finally {
    await jev.close();
    await proxy.close();
    await Promise.all([cwd, ...homes].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
