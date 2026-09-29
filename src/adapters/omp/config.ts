/**
 * OMP adapter configuration: same file format and parser as the Pi adapter, independent path.
 * Everything defaults under `~/.omp/agent/pi-jev-harness/` (config.json, telemetry/, runs/,
 * context/). Unlike Pi, the file may say `mode: "on"` (parser opt-in). Reads only: a damaged file
 * is never rewritten and yields mode off with a reason.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { applyOmpContextOverrides, readLegacyContextFiles } from "./context-settings.ts";
import { loadConfig as loadPiFormat, type LoadConfigOptions, type LoadedConfig } from "./shared.ts";

export function ompHarnessDir(home: string): string {
  return join(home, ".omp", "agent", "pi-jev-harness");
}

export interface OmpConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Injected config path; defaults to `<home>/.omp/agent/pi-jev-harness/config.json`. */
  path?: string;
  /** Injected telemetry directory; overrides the file value and the default. */
  telemetryDir?: string;
  readText?: LoadConfigOptions["readText"];
  /** Reader of the legacy `jev-harness.json` / `jev-autorun.json` (read-only); default fs. */
  readLegacyText?: (path: string) => Promise<string>;
}

export async function loadOmpConfig(options: OmpConfigOptions = {}): Promise<LoadedConfig> {
  const home = options.home ?? homedir();
  const env = options.env ?? {};
  const loaded = await loadPiFormat({
    env: options.env ?? {},
    home,
    baseDir: ompHarnessDir(home),
    allowModeOn: true,
    allowApproval: true,
    ...(options.path ? { path: options.path } : {}),
    ...(options.readText ? { readText: options.readText } : {}),
    ...(options.telemetryDir ? { telemetryDir: options.telemetryDir } : {}),
  });
  // legacy OMP_JEV_* / OMP_TELEMETRY_* variables and legacy files (env > config > legacy > default).
  return applyOmpContextOverrides(loaded, env, await readLegacyContextFiles(home, env, options.readLegacyText), { telemetryDirInjected: options.telemetryDir !== undefined });
}
