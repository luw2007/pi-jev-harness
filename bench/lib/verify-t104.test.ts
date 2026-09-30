/** Verifier checks for T104: bench has no model-routing arm; deepseek refusal still covers config and env. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkArm, checkModel } from "./arms.ts";
import type { BenchArm } from "./types.ts";

const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));

test("T104 arms.json: exactly A, AA, B, C, D, E; no arm M; no router.models anywhere", async () => {
  const raw = await readFile(join(BENCH, "arms.json"), "utf8");
  const { arms } = JSON.parse(raw) as { arms: BenchArm[] };
  assert.deepEqual(arms.map((a) => a.id), ["A", "AA", "B", "C", "D", "E"]);
  for (const arm of arms) {
    const router = (arm.config as { router?: Record<string, unknown> }).router;
    assert.ok(!router || !("models" in router), `${arm.id} still has router.models`);
    assert.equal(await checkArm(arm), null, arm.id);
  }
  assert.doesNotMatch(raw, /"models"|\bM\b.*模型路由/);
});

test("T104 deepseek refusal: anywhere in arm config, any case, and in arm env", async () => {
  const cases: BenchArm[] = [
    { id: "X", label: "x", config: { mode: "shadow", jev: { url: "https://DeepSeek.example/v1" } } },
    { id: "X", label: "x", config: { mode: "shadow", router: { models: { allow: ["relay/deepseek-v4"] } } } },
    { id: "X", label: "x", config: { mode: "shadow" }, env: { SOME_VAR: "DEEPSEEK" } },
    { id: "X", label: "x", config: { mode: "shadow" }, env: { DEEPSEEK_API_KEY: "k" } },
  ];
  for (const arm of cases) assert.match((await checkArm(arm)) ?? "", /deepseek/i, JSON.stringify(arm));
  assert.match(checkModel("relay", "DeepSeek-V4") ?? "", /deepseek/i);
  assert.match(checkModel("deepseek", "x") ?? "", /deepseek/i);
});
