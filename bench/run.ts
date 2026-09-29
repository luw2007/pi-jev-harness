#!/usr/bin/env node
/**
 * Paired bench driver (technical §13.2 / M5).
 *
 *   node bench/run.ts --tasks <glob> --arms A,B --repeat 3 --concurrency 1 --out <dir> \
 *     --provider <pi provider> --model <model id> --models-json <path> [--thinking low] [--seed 1] [--jev fake|real] [--pi-retry on|off]
 *
 * Pair groups are (task, rep); within a group every arm runs back to back in a seeded random
 * order, so arms of one task share a time window. Groups are shuffled with the same seed and run
 * K at a time. Results go to `<out>/results.jsonl` (one line per run) and `<out>/meta.json`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkArm, checkModel } from "./lib/arms.ts";
import { runOne, type ModelSetup, type RunContext } from "./lib/runner.ts";
import { shuffle } from "./lib/stats.ts";
import { CATEGORIES, type BenchArm, type BenchMeta, type BenchTask } from "./lib/types.ts";

const BENCH = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = dirname(BENCH);

function fail(message: string): never {
  process.stderr.write(`bench/run: ${message}\n`);
  process.exit(1);
}

function validateTask(t: BenchTask, file: string): BenchTask {
  const ok =
    typeof t.id === "string" &&
    (CATEGORIES as readonly string[]).includes(t.category) &&
    typeof t.prompt === "string" &&
    Array.isArray(t.acceptance) &&
    t.acceptance.length > 0 &&
    t.acceptance.every((a) => typeof a === "string") &&
    typeof t.timeoutSec === "number" &&
    t.timeoutSec > 0 &&
    t.repo !== null &&
    typeof t.repo === "object" &&
    ("fixture" in t.repo ? typeof t.repo.fixture === "string" : typeof t.repo.git === "string" && /^[0-9a-f]{7,40}$/.test(t.repo.commit));
  if (!ok) fail(`invalid task file ${file}`);
  const taskDir = dirname(file);
  // A relative repo.git path is relative to the task file, not to the bench's cwd.
  const repo = "git" in t.repo && !isAbsolute(t.repo.git) && !/^[a-z][a-z0-9+.-]*:/i.test(t.repo.git) ? { ...t.repo, git: resolve(taskDir, t.repo.git) } : t.repo;
  return { ...t, repo, taskDir };
}

/**
 * Copy one provider block. A `!command` apiKey is resolved once here with the real environment; a
 * `$NAME` apiKey passes only that variable. No other secret reaches the run or acceptance env.
 */
function modelSetup(modelsJson: string, provider: string, model: string, thinking: string, retry: boolean): ModelSetup {
  const all = JSON.parse(readFileSync(modelsJson, "utf8")) as { providers?: Record<string, Record<string, unknown>> };
  const block = all.providers?.[provider];
  if (!block) fail(`provider ${provider} not found in ${modelsJson}`);
  const models = (block.models as { id: string; cost?: Record<string, unknown> }[] | undefined) ?? [];
  if (!models.some((m) => m.id === model)) fail(`model ${model} not listed under provider ${provider}`);
  const env: Record<string, string> = {};
  const providerBlock: Record<string, unknown> = { ...block, models: models.filter((m) => m.id === model) };
  const key = block.apiKey;
  if (typeof key === "string" && key.startsWith("!")) {
    env.BENCH_MODEL_API_KEY = execFileSync("/bin/sh", ["-c", key.slice(1)], { encoding: "utf8" }).trim();
    providerBlock.apiKey = "$BENCH_MODEL_API_KEY";
  } else if (typeof key === "string") {
    const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(key);
    if (ref && process.env[ref[1]!] !== undefined) env[ref[1]!] = process.env[ref[1]!]!;
  }
  const cost = models.find((m) => m.id === model)?.cost;
  const priced = cost !== undefined && Object.values(cost).some((v) => typeof v === "number" && v > 0);
  return { provider, model, providerBlock, thinking, retry, priced, env };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tasks: { type: "string" },
      arms: { type: "string", default: "A,B" },
      "arms-file": { type: "string", default: join(BENCH, "arms.json") },
      repeat: { type: "string", default: "3" },
      concurrency: { type: "string", default: "1" },
      out: { type: "string" },
      seed: { type: "string", default: "1" },
      provider: { type: "string" },
      model: { type: "string" },
      "models-json": { type: "string" },
      thinking: { type: "string", default: "low" },
      jev: { type: "string", default: "fake" },
      "pi-retry": { type: "string", default: "on" },
    },
  });
  if (!values.tasks || !values.out || !values.provider || !values.model || !values["models-json"])
    fail("required: --tasks <glob> --out <dir> --provider <name> --model <id> --models-json <path>");
  const repeat = Number(values.repeat);
  const concurrency = Number(values.concurrency);
  const seed = Number(values.seed);
  if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");
  if (!Number.isInteger(seed)) fail("--seed must be an integer");
  if (values["pi-retry"] !== "on" && values["pi-retry"] !== "off") fail("--pi-retry must be on or off");
  if (values.jev !== "fake" && values.jev !== "real") fail("--jev must be fake or real");

  const modelError = checkModel(values.provider!, values.model!);
  if (modelError) fail(modelError);
  const armFile = JSON.parse(await readFile(values["arms-file"]!, "utf8")) as { arms: BenchArm[] };
  const arms = values.arms!.split(",").map((id) => {
    const arm = armFile.arms.find((a) => a.id === id.trim());
    if (!arm) fail(`unknown arm ${id}`);
    return arm;
  });
  for (const arm of arms) {
    const error = await checkArm(arm);
    if (error) fail(error);
  }
  if (arms.filter((a) => a.baseline).length !== 1) fail("select exactly one baseline arm (A)");

  const files: string[] = [];
  for await (const f of glob(values.tasks!)) files.push(resolve(f));
  files.sort();
  if (files.length === 0) fail(`no task files match ${values.tasks}`);
  const tasks = await Promise.all(files.map(async (f) => validateTask(JSON.parse(await readFile(f, "utf8")), f)));
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) fail("duplicate task ids");

  for (const t of tasks) {
    const src = "fixture" in t.repo ? join(BENCH, "fixtures", t.repo.fixture) : t.repo.git;
    const isUrl = "git" in t.repo && /^[a-z][a-z0-9+.-]*:/i.test(t.repo.git);
    if (!isUrl && !existsSync(src)) fail(`task ${t.id}: repo source not found: ${src}`);
  }
  const model = modelSetup(values["models-json"]!, values.provider!, values.model!, values.thinking!, values["pi-retry"] === "on");
  const out = resolve(values.out!);
  await mkdir(out, { recursive: true });
  const meta: BenchMeta = {
    startedAt: new Date().toISOString(),
    seed,
    repeat,
    concurrency,
    model: values.model!.startsWith(`${values.provider}/`) ? values.model! : `${values.provider}/${values.model}`,
    jev: values.jev,
    piRetry: values["pi-retry"] === "on",
    costAvailable: model.priced,
    arms,
    tasks: tasks.map((t) => ({ id: t.id, category: t.category })),
  };
  await writeFile(join(out, "meta.json"), JSON.stringify(meta, null, 2));
  const ctx: RunContext = {
    harnessRoot: HARNESS_ROOT,
    fixturesDir: join(BENCH, "fixtures"),
    outDir: out,
    model,
    jev: values.jev,
    baseEnv: process.env,
  };

  const groups = shuffle(
    tasks.flatMap((task) => Array.from({ length: repeat }, (_, i) => ({ task, rep: i + 1 }))),
    seed,
  );
  let next = 0;
  const failures: string[] = [];
  const worker = async () => {
    while (next < groups.length) {
      const g = groups[next++]!;
      const order = shuffle(arms, seed + g.rep * 7919 + next);
      for (const [i, arm] of order.entries()) {
        process.stderr.write(`[bench] ${g.task.id} rep ${g.rep} arm ${arm.id} ...\n`);
        try {
          const rec = await runOne(ctx, g.task, arm, g.rep, i);
          process.stderr.write(`[bench] ${g.task.id} rep ${g.rep} arm ${arm.id}: outcome=${rec.outcome} acceptance=${rec.acceptance.exit} ${rec.durationMs}ms\n`);
          await appendFile(join(out, "results.jsonl"), `${JSON.stringify(rec)}\n`);
        } catch (error) {
          // A bench-side failure (not a task outcome): keep going so every in-flight run finishes its cleanup.
          failures.push(`${g.task.id} rep ${g.rep} arm ${arm.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  for (const s of settled) if (s.status === "rejected") failures.push(String(s.reason));
  if (failures.length > 0) {
    await writeFile(join(out, "bench-errors.txt"), `${failures.join("\n")}\n`);
    fail(`${failures.length} run(s) failed inside the bench (not task outcomes):\n${failures.join("\n")}`);
  }
  process.stderr.write(`[bench] done: ${join(out, "results.jsonl")}\n`);
}

await main();
