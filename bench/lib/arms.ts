/**
 * Arm and model guards run before anything is written or started. Each arm config is parsed by
 * the product's own `loadConfig` (read-only import); a config the adapter would reject (and then
 * silently run as off) aborts the bench instead.
 */
import { loadConfig } from "../../src/adapters/pi/config.ts";
import type { BenchArm } from "./types.ts";

export const DEEPSEEK = /deepseek/i;

/** Returns an error message, or null when the arm config is accepted as-is by the adapter. */
export async function checkArm(arm: BenchArm): Promise<string | null> {
  if (arm.unsupported) return `arm ${arm.id} is not runnable: ${arm.unsupported}`;
  if (DEEPSEEK.test(JSON.stringify(arm.config)) || DEEPSEEK.test(JSON.stringify(arm.env ?? {}))) return `arm ${arm.id}: deepseek is not allowed in arm config/env`;
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

export function checkModel(provider: string, model: string): string | null {
  return DEEPSEEK.test(`${provider} ${model}`) ? "deepseek models are not allowed" : null;
}
