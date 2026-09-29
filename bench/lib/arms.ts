/**
 * Arm and model guards run before anything is written or started. Each arm config is parsed by
 * the product's own `loadConfig` (read-only import); a config the adapter would reject (and then
 * silently run as off) aborts the bench instead.
 */
import { loadConfig } from "../../src/adapters/pi/config.ts";
import type { BenchArm } from "./types.ts";

/**
 * Optional model denylist: `BENCH_DENY_MODELS` is a comma-separated list of case-insensitive
 * substrings. Empty by default. A match in the model/provider, arm config or arm env aborts the bench.
 */
export function denyList(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return (env.BENCH_DENY_MODELS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function denied(text: string, deny: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  return deny.find((entry) => lower.includes(entry));
}

/** Returns an error message, or null when the arm config is accepted as-is by the adapter. */
export async function checkArm(arm: BenchArm, deny: readonly string[] = denyList()): Promise<string | null> {
  if (arm.unsupported) return `arm ${arm.id} is not runnable: ${arm.unsupported}`;
  const hit = denied(`${JSON.stringify(arm.config)} ${JSON.stringify(arm.env ?? {})}`, deny);
  if (hit !== undefined) return `arm ${arm.id}: "${hit}" (BENCH_DENY_MODELS) is not allowed in arm config/env`;
  const loaded = await loadConfig({
    home: "/nonexistent-bench-home",
    path: "/nonexistent-bench-home/config.json",
    // Validate with the env the run will see (arm env can set PI_JEV_* overrides).
    env: { ...(arm.env ?? {}) },
    readText: async () => JSON.stringify(arm.config),
  });
  if (loaded.source !== "file") return `arm ${arm.id}: config rejected by pi-jev loadConfig (${loaded.reason ?? loaded.source}); it would run as off`;
  const wanted = (arm.config as { mode?: unknown }).mode ?? "off";
  if (loaded.config.mode !== wanted) return `arm ${arm.id}: config mode ${String(wanted)} loaded as ${loaded.config.mode}`;
  return null;
}

export function checkModel(provider: string, model: string, deny: readonly string[] = denyList()): string | null {
  const hit = denied(`${provider} ${model}`, deny);
  return hit === undefined ? null : `models matching "${hit}" (BENCH_DENY_MODELS) are not allowed`;
}
