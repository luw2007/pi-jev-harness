#!/usr/bin/env node
/**
 * Offline smoke: `node bench/smoke-offline.ts <out-dir> [--arms A,B] [--repeat 1]`.
 * Starts the scripted local OpenAI-compatible server, writes a temp models.json for it, runs
 * bench/run.ts (real `pi-jev run` entry, fake Jev) and then bench/report.ts. No real model or Jev.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startFakeLlm } from "./lib/fake-llm.ts";

const BENCH = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { arms: { type: "string", default: "A,B" }, repeat: { type: "string", default: "1" } } });
if (positionals.length !== 1) {
  process.stderr.write("usage: node bench/smoke-offline.ts <out-dir> [--arms A,B] [--repeat 1]\n");
  process.exit(1);
}
const out = resolve(positionals[0]!);

const run = (args: string[]) =>
  new Promise<number>((ok) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("close", (code) => ok(code ?? 1));
  });

const llm = await startFakeLlm();
const tmp = await mkdtemp(join(tmpdir(), "bench-smoke-offline-"));
let code = 1;
try {
  const modelsJson = join(tmp, "models.json");
  await writeFile(
    modelsJson,
    JSON.stringify({
      providers: {
        fakeprov: {
          baseUrl: llm.baseUrl,
          api: "openai-completions",
          apiKey: "fake-key",
          models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }],
        },
      },
    }),
  );
  code = await run([join(BENCH, "run.ts"), "--tasks", join(BENCH, "tasks", "smoke", "*.json"), "--arms", values.arms!, "--repeat", values.repeat!, "--concurrency", "1", "--out", out, "--provider", "fakeprov", "--model", "fake-model", "--models-json", modelsJson, "--thinking", "off", "--jev", "fake"]);
  process.stderr.write(`[smoke-offline] fake LLM requests: ${llm.requests()}\n`);
  if (code === 0) code = await run([join(BENCH, "report.ts"), out]);
} finally {
  await llm.close();
  await rm(tmp, { recursive: true, force: true });
}
process.exit(code);
