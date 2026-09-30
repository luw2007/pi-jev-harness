/**
 * Real OMP host, offline: the installed `omp` runs the OMP adapter against a local scripted
 * OpenAI-compatible model server and a local fake Jev. Zero real model requests; no real provider
 * config or credential is read. The provider name is invented (`localscripted`), so no provider the
 * user disabled is re-enabled.
 *
 * Runs: off, shadow (outbound allowed), shadow (outbound default = not allowed), shadow without
 * `--model`, and shadow with a Jev that never answers (the host run must not wait for it).
 *
 * HOME is a temp dir; the child gets a minimal env (no provider keys), so builtin providers such
 * as deepseek have no credentials and cannot be reached.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const PROVIDER = "localscripted";
const MODEL_ID = "scripted-1";
const MODEL = `${PROVIDER}/${MODEL_ID}`;
const PROMPT = "Reply with exactly the single word OK and nothing else. Do not use any tools. marker-7f3a";
const FAKE_KEY = "fake-typesafe-key-for-omp-offline-host-test";
const EXTENSION = resolve(import.meta.dirname, "../../src/adapters/omp/index.ts");
const OMP = "/opt/homebrew/bin/omp";

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

function startFakeJev() {
  const state = { requests: 0, hang: false };
  const server = createServer(async (request, response) => {
    state.requests++;
    const text = await body(request);
    if (state.hang) return; // never answers; the adapter must abort on its own
    try {
      const parsed = JSON.parse(text) as { model: string; questions: Record<string, { criteria: Record<string, string> }> };
      const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => {
        const options = Object.keys(question.criteria);
        const rest = 0.3 / Math.max(1, options.length - 1);
        return [id, { type: "choice", choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest])) }];
      }));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: parsed.model, answers }));
    } catch {
      response.writeHead(400).end();
    }
  });
  return listen(server).then((port) => ({ url: `http://127.0.0.1:${port}/v1/systemone`, state, close: () => close(server) }));
}

interface ModelCall { model: string; tools: string[]; stream: boolean }

/** Scripted OpenAI chat-completions server: always answers "OK", records model + tool names. */
function startScriptedModel() {
  const calls: ModelCall[] = [];
  const server = createServer(async (request, response) => {
    const text = await body(request);
    if (request.method !== "POST") { response.writeHead(404).end(); return; }
    const parsed = JSON.parse(text) as { model?: string; stream?: boolean; tools?: { function?: { name?: string } }[] };
    calls.push({ model: String(parsed.model), stream: parsed.stream === true, tools: (parsed.tools ?? []).map((tool) => String(tool.function?.name)).sort() });
    const base = { id: "chatcmpl-local", created: 0, model: parsed.model };
    const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    if (parsed.stream) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] });
      send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage,
      }));
    }
  });
  return listen(server).then((port) => ({ baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => close(server) }));
}

async function prepareHome(label: string, modelBaseUrl: string, harness: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `omp-jev-offline-${label}-`));
  const agentDir = join(home, ".omp", "agent");
  await mkdir(join(agentDir, "pi-jev-harness"), { recursive: true });
  await writeFile(join(agentDir, "models.yml"), [
    "providers:",
    `  ${PROVIDER}:`,
    `    baseUrl: ${modelBaseUrl}`,
    "    apiKey: local-not-a-secret",
    "    api: openai-completions",
    "    models:",
    `    - id: ${MODEL_ID}`,
    "      name: Scripted",
    "      reasoning: false",
    "      input: [text]",
    "      contextWindow: 128000",
    "      maxTokens: 4096",
    "",
  ].join("\n"));
  await writeFile(join(home, "overlay.yml"), "retry:\n  modelFallback: false\n  usageAwareFallback: false\n  maxRetries: 0\n");
  await writeFile(join(agentDir, "pi-jev-harness", "config.json"), JSON.stringify(harness));
  return home;
}

function runOmp(home: string, cwd: string, jevUrl: string, pin: boolean) {
  const args = ["-p", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-lsp",
    "--config", join(home, "overlay.yml"), ...(pin ? ["--model", MODEL] : []), "--extension", EXTENSION, PROMPT];
  // Minimal env: no provider keys at all.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), TYPESAFE_API_KEY: FAKE_KEY, PI_JEV_URL: jevUrl };
  const child = spawn(OMP, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const started = Date.now();
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  return new Promise<{ code: number | null; stderr: string; events: Record<string, unknown>[]; ms: number }>((done, fail) => {
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      done({ code, stderr, events, ms: Date.now() - started });
    });
  });
}

function assistantRows(events: Record<string, unknown>[]) {
  return events.filter((event) => event.type === "message_end" && (event.message as { role?: string }).role === "assistant")
    .map((event) => { const m = event.message as Record<string, unknown>; return { provider: String(m.provider), model: String(m.model), stopReason: String(m.stopReason) }; });
}

async function telemetry(home: string) {
  const dir = join(home, ".omp", "agent", "pi-jev-harness", "telemetry");
  const names = await readdir(dir).catch(() => [] as string[]);
  const text = (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("");
  return { text, events: text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; outcome: string; source?: string }) };
}

test("real omp offline: off / shadow / shadow-without-outbound / shadow-with-hanging-Jev", { timeout: 600_000 }, async () => {
  const userCfg = join(homedir(), ".omp", "agent", "config.yml");
  const userCfgMtime = statSync(userCfg).mtimeMs;
  const userHarnessDirExisted = existsSync(join(homedir(), ".omp", "agent", "pi-jev-harness"));
  const jev = await startFakeJev();
  const model = await startScriptedModel();
  const cwd = await mkdtemp(join(tmpdir(), "omp-jev-offline-cwd-"));
  const homes: string[] = [];
  const allowed = { outbound: { taskIntent: true } };
  const run = async (label: string, harness: Record<string, unknown>, pin = true) => {
    const home = await prepareHome(label, model.baseUrl, harness);
    homes.push(home);
    const before = jev.state.requests;
    const result = await runOmp(home, cwd, jev.url, pin);
    const calls = model.calls.splice(0);
    const tel = await telemetry(home);
    const out = { label, ...result, jevRequests: jev.state.requests - before, calls, rows: assistantRows(result.events), tel };
    console.log(`${label}: exit=${out.code} ms=${out.ms} jev=${out.jevRequests} rows=${JSON.stringify(out.rows)} calls=${JSON.stringify(calls)}`);
    console.log(`${label}: telemetry=${JSON.stringify(tel.events.map((e) => `${e.kind}:${e.outcome}:${e.source ?? ""}`))}`);
    return out;
  };
  try {
    const off = await run("off", { mode: "off", ...allowed });
    const shadow = await run("shadow", { mode: "shadow", ...allowed });
    const noOutbound = await run("shadow-no-outbound", { mode: "shadow" });
    // No --model: the only configured model is still used; no model routing (T104).
    const unpinned = await run("shadow-unpinned", { mode: "shadow", ...allowed }, false);
    jev.state.hang = true;
    const hanging = await run("shadow-hanging-jev", { mode: "shadow", ...allowed, jev: { timeoutMs: 60_000 }, budget: { waitMs: 60_000 } });

    for (const r of [off, shadow, noOutbound, unpinned, hanging]) {
      assert.equal(r.code, 0, `${r.label}: ${r.stderr}`);
      assert.ok(r.calls.length >= 1, `${r.label}: model was called`);
      assert.ok(r.calls.every((call) => call.model === MODEL_ID && !/deepseek/i.test(call.model)), r.label);
      assert.deepEqual(r.rows.map(({ provider, model: m }) => ({ provider, model: m })), off.rows.map(({ provider, model: m }) => ({ provider, model: m })), r.label);
      assert.deepEqual(r.calls.map((c) => c.tools), off.calls.map((c) => c.tools), `${r.label}: same tool set on the wire as off`);
      assert.ok(r.calls.every((c) => c.tools.includes("jev_plan")), `${r.label}: jev_plan is a top-level tool on the wire (loadMode essential)`);
      assert.ok(!r.tel.text.includes("marker-7f3a") && !r.tel.text.includes(FAKE_KEY), `${r.label}: telemetry privacy`);
    }
    assert.equal(off.jevRequests, 0, "off: zero Jev");
    assert.equal(off.tel.text, "", "off: no telemetry");
    assert.ok(shadow.jevRequests > 0, "shadow: Jev consulted");
    assert.equal(noOutbound.jevRequests, 0, "shadow without outbound.taskIntent: zero Jev");
    // T105 L3: the session_stop checkpoint records completion `unavailable` (not sent) next to the withheld route.
    assert.ok(noOutbound.tel.events.length > 0 && noOutbound.tel.events.every((e) => e.outcome === "withheld" || (e.kind === "completion" && e.outcome === "unavailable")));
    for (const r of [shadow, unpinned, hanging]) assert.ok(r.tel.events.every((e) => e.kind !== "route_model"), `${r.label}: no model routing (T104)`);
    assert.ok(hanging.jevRequests > 0, "hanging: Jev request was made");
    // A 60 s Jev hang must not hold the host: the run ends in about the time the off run took.
    assert.ok(hanging.ms < off.ms + 15_000, `hanging-Jev run took ${hanging.ms}ms vs off ${off.ms}ms`);
  } finally {
    await jev.close();
    await model.close();
    await Promise.all([cwd, ...homes].map((dir) => rm(dir, { recursive: true, force: true })));
  }
  assert.equal(statSync(userCfg).mtimeMs, userCfgMtime, "user ~/.omp/agent/config.yml untouched");
  assert.equal(existsSync(join(homedir(), ".omp", "agent", "pi-jev-harness")), userHarnessDirExisted, "user harness dir not created");
});
