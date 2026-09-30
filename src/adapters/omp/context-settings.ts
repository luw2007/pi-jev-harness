/**
 * OMP context settings (T105 L4): C7 request reduction, C8 compaction, proactive compaction, and
 * compatibility with the legacy `@omp-jev/harness` variables and files.
 *
 * Precedence per field: env > new config (`~/.omp/agent/pi-jev-harness/config.json`) > legacy file
 * (`~/.omp/agent/jev-harness.json`, `~/.omp/agent/jev-autorun.json`, read-only) > default.
 *
 * Legacy variables (jev-compaction/hook.ts `settingsFromEnv`, telemetry/writer.js):
 * - `OMP_JEV_CONTEXT`: "0" → context.request off; any other non-empty value → on (applies only in
 *   a session in mode on). Unset: new config, then legacy `capabilities.compaction.mode`.
 * - `OMP_JEV_KEEP_THRESHOLD`, `OMP_JEV_PRESERVE_RECENT`, `OMP_JEV_MIN_REDUCTION`,
 *   `OMP_JEV_CACHE_CEILING`, `OMP_JEV_MIN_CHARS`: fast-jev tunables.
 * - `OMP_JEV_SPILL`: "0" disables archiving; request reduction then never replaces (C7 needs the
 *   archive first) and only records would-reduce.
 * - `OMP_JEV_SPILL_DIR`: archive root (replaces `context.storeDir`).
 * - `OMP_JEV_TIMEOUT_MS`, `OMP_JEV_BASE_URL`, `OMP_JEV_MODEL`: Jev client overrides.
 *   `OMP_JEV_PROVIDER`: only `typesafe` is served here (provider chains are C9); others are noted.
 * - `OMP_JEV_ALLOW_DROPPING_CALLS=1`: C8 may drop a low-scoring call record, not only its result.
 *   C7 always keeps call records (reducer rule), so it applies to C8 only.
 * - `OMP_TELEMETRY=0`: no telemetry is written (legacy kill switch).
 * - `OMP_TELEMETRY_PATH`: telemetry goes to that file's directory (file name `events.jsonl`,
 *   this adapter's schema); `OMP_TELEMETRY_MAX_BYTES`: rotation size (≥ 4096, legacy rule).
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ContextRequestMode, LoadedConfig } from "./shared.ts";

export type SettingSource = "env" | "config" | "legacy" | "default";

export interface OmpContextSettings {
  /** C8: fast-jev verbatim compaction at `session_before_compact`. */
  compaction: ContextRequestMode;
  proactive: {
    mode: ContextRequestMode;
    softPercent: number;
    hardPercent: number;
    /** At/above hardPercent compact without asking Jev (legacy jev-autorun behaviour). */
    hardCompact: boolean;
  };
  keepThreshold: number;
  preserveRecent: number;
  minReduction: number;
  /** False: nothing is archived, so request reduction only records. */
  spill: boolean;
  /** Skip request reduction when the latest usage is at least this share cache reads; undefined = no guard. */
  cacheCeiling: number | undefined;
  model: string | undefined;
  /** C8: a low score may drop the tool call record too (legacy `OMP_JEV_ALLOW_DROPPING_CALLS=1`). Default false. */
  allowDroppingCalls: boolean;
  notes: string[];
  sources: Record<string, SettingSource>;
}

export const OMP_CONTEXT_DEFAULTS = {
  keepThreshold: 0.2,
  preserveRecent: 0,
  minReduction: 0.25,
  softPercent: 70,
  hardPercent: 90,
} as const;

/** Resolved settings of a loaded config; defaults when the adapter never resolved them. */
export function ompContextSettings(loaded: LoadedConfig): OmpContextSettings {
  const resolved = (loaded as { ompContext?: OmpContextSettings }).ompContext;
  return resolved ?? {
    compaction: "off",
    proactive: { mode: "off", softPercent: OMP_CONTEXT_DEFAULTS.softPercent, hardPercent: OMP_CONTEXT_DEFAULTS.hardPercent, hardCompact: true },
    keepThreshold: OMP_CONTEXT_DEFAULTS.keepThreshold,
    preserveRecent: OMP_CONTEXT_DEFAULTS.preserveRecent,
    minReduction: OMP_CONTEXT_DEFAULTS.minReduction,
    spill: true,
    cacheCeiling: undefined,
    model: undefined,
    allowDroppingCalls: false,
    notes: [],
    sources: {},
  };
}

export interface LegacyContextFiles {
  /** `jev-harness.json` (schemaVersion 1, `capabilities.compaction.mode`). */
  harness?: unknown;
  /** `jev-autorun.json` (`mode`, `softContextPercent`, `hardContextPercent`). */
  autorun?: unknown;
}

export function legacyContextPaths(home: string, env: Readonly<Record<string, string | undefined>>): { harness: string; autorun: string } {
  const dir = join(home, ".omp", "agent");
  return {
    harness: env.JEV_HARNESS_CONFIG || join(dir, "jev-harness.json"),
    autorun: env.JEV_AUTORUN_CONFIG || join(dir, "jev-autorun.json"),
  };
}

/** Reads the legacy files; missing, unreadable or unparsable → absent. Never writes. */
export async function readLegacyContextFiles(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<LegacyContextFiles> {
  const paths = legacyContextPaths(home, env);
  const load = async (path: string) => {
    try {
      return JSON.parse(await read(path)) as unknown;
    } catch {
      return undefined;
    }
  };
  return { harness: await load(paths.harness), autorun: await load(paths.autorun) };
}

type Data = Record<string, unknown>;
const isObject = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);

/** Legacy `capabilities.compaction.mode` ("on" | "off"), only from a valid schemaVersion 1 file. */
function legacyCompaction(files: LegacyContextFiles): "on" | "off" | undefined {
  const file = files.harness;
  if (!isObject(file) || file.schemaVersion !== 1 || !isObject(file.capabilities)) return undefined;
  const setting = file.capabilities.compaction;
  const mode = isObject(setting) ? setting.mode : undefined;
  return mode === "on" || mode === "off" ? mode : undefined;
}

/** Legacy jev-autorun: dry-run → shadow; invalid thresholds make the whole file ignored (legacy: autorun off). */
function legacyAutorun(files: LegacyContextFiles): { mode?: ContextRequestMode; soft?: number; hard?: number } | undefined {
  const file = files.autorun;
  if (!isObject(file)) return undefined;
  const mode = file.mode === "dry-run" ? "shadow" : file.mode === "on" || file.mode === "off" ? file.mode : undefined;
  if (file.mode !== undefined && mode === undefined) return undefined;
  const soft = file.softContextPercent, hard = file.hardContextPercent;
  const s = typeof soft === "number" ? soft : 70, h = typeof hard === "number" ? hard : 90;
  if ((soft !== undefined && typeof soft !== "number") || (hard !== undefined && typeof hard !== "number") || !(s > 0 && s < h && h <= 100)) return undefined;
  return { ...(mode ? { mode } : {}), ...(soft !== undefined ? { soft: s } : {}), ...(hard !== undefined ? { hard: h } : {}) };
}

function envNumber(env: Readonly<Record<string, string | undefined>>, name: string, check: (n: number) => boolean): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && check(n) ? n : undefined;
}

const unit = (n: number) => n >= 0 && n <= 1;

/**
 * Applies env and legacy files to a loaded OMP config and attaches the resolved OMP context
 * settings (`ompContextSettings`). An invalid config stays as it is (the adapter is off anyway).
 */
export function applyOmpContextOverrides(
  loaded: LoadedConfig,
  env: Readonly<Record<string, string | undefined>>,
  legacy: LegacyContextFiles,
  options: { telemetryDirInjected?: boolean } = {},
): LoadedConfig {
  if (loaded.source === "invalid") return loaded;
  const sources: Record<string, SettingSource> = {};
  const notes: string[] = [];
  const file = loaded.config.context.omp ?? {};
  const fastJev = file.fastJev ?? {};
  const pick = <T>(name: string, candidates: Array<[SettingSource, T | undefined]>, fallback: T): T => {
    for (const [source, value] of candidates) {
      if (value !== undefined) {
        sources[name] = source;
        return value;
      }
    }
    sources[name] = "default";
    return fallback;
  };
  const config = { ...loaded.config, jev: { ...loaded.config.jev }, context: { ...loaded.config.context, limits: { ...loaded.config.context.limits } } };

  const envContext = env.OMP_JEV_CONTEXT ? (env.OMP_JEV_CONTEXT === "0" ? "off" : "on") : undefined;
  const legacyMode = legacyCompaction(legacy);
  config.context.request = pick<ContextRequestMode>("request", [
    ["env", envContext],
    ["config", file.requestSet && loaded.source === "file" ? loaded.config.context.request : undefined],
    ["legacy", legacyMode],
  ], loaded.config.context.request);
  const compaction = pick<ContextRequestMode>("compaction", [["config", file.compaction], ["legacy", legacyMode]], "off");

  const autorun = legacyAutorun(legacy);
  const proactive = {
    mode: pick<ContextRequestMode>("proactive.mode", [["config", file.proactive?.mode], ["legacy", autorun?.mode]], "off"),
    softPercent: pick("proactive.softPercent", [["config", file.proactive?.softPercent], ["legacy", autorun?.soft]], OMP_CONTEXT_DEFAULTS.softPercent),
    hardPercent: pick("proactive.hardPercent", [["config", file.proactive?.hardPercent], ["legacy", autorun?.hard]], OMP_CONTEXT_DEFAULTS.hardPercent),
    hardCompact: pick("proactive.hardCompact", [["config", file.proactive?.hardCompact]], true),
  };
  if (!(proactive.softPercent < proactive.hardPercent)) {
    notes.push("proactive thresholds from mixed sources conflict (soft ≥ hard); proactive compaction off");
    proactive.mode = "off";
  }

  const spillEnv = env.OMP_JEV_SPILL ? env.OMP_JEV_SPILL !== "0" : undefined;
  const spillDirEnv = env.OMP_JEV_SPILL_DIR?.trim();
  const spillDir = pick<string | undefined>("storeDir", [
    ["env", spillDirEnv && isAbsolute(spillDirEnv) ? spillDirEnv : undefined],
    ["config", fastJev.spillDir],
  ], undefined);
  if (spillDirEnv && !isAbsolute(spillDirEnv)) notes.push("OMP_JEV_SPILL_DIR ignored: not an absolute path");
  if (spillDir) config.context.storeDir = spillDir;

  const minChars = envNumber(env, "OMP_JEV_MIN_CHARS", (n) => Number.isInteger(n) && n >= 0);
  if (minChars !== undefined) {
    config.context.limits.minChars = minChars;
    sources["limits.minChars"] = "env";
  }
  const timeout = envNumber(env, "OMP_JEV_TIMEOUT_MS", (n) => Number.isInteger(n) && n >= 1);
  if (timeout !== undefined) {
    config.jev.timeoutMs = timeout;
    sources["jev.timeoutMs"] = "env";
  }
  const baseUrl = env.OMP_JEV_BASE_URL?.trim();
  if (baseUrl) {
    // PI_JEV_URL (the adapter's own variable) keeps priority over the legacy one.
    if (!/^https?:\/\//.test(baseUrl)) notes.push("OMP_JEV_BASE_URL ignored: not an http(s) URL");
    else if (!env.PI_JEV_URL) {
      config.jev.url = baseUrl;
      sources["jev.url"] = "env";
    }
  }
  const provider = env.OMP_JEV_PROVIDER?.trim().toLowerCase();
  if (provider && provider !== "typesafe") notes.push(`OMP_JEV_PROVIDER=${provider} not served by the OMP context path (typesafe only); ignored`);

  const settings: OmpContextSettings = {
    compaction,
    proactive,
    keepThreshold: pick("keepThreshold", [["env", envNumber(env, "OMP_JEV_KEEP_THRESHOLD", unit)], ["config", fastJev.keepThreshold]], OMP_CONTEXT_DEFAULTS.keepThreshold),
    preserveRecent: pick("preserveRecent", [["env", envNumber(env, "OMP_JEV_PRESERVE_RECENT", (n) => Number.isInteger(n) && n >= 0)], ["config", fastJev.preserveRecent]], OMP_CONTEXT_DEFAULTS.preserveRecent),
    minReduction: pick("minReduction", [["env", envNumber(env, "OMP_JEV_MIN_REDUCTION", unit)], ["config", fastJev.minReduction]], OMP_CONTEXT_DEFAULTS.minReduction),
    spill: pick("spill", [["env", spillEnv], ["config", fastJev.spill]], true),
    cacheCeiling: pick<number | undefined>("cacheCeiling", [["env", envNumber(env, "OMP_JEV_CACHE_CEILING", unit)], ["config", fastJev.cacheCeiling]], undefined),
    model: pick<string | undefined>("model", [["env", env.OMP_JEV_MODEL?.trim() || undefined], ["config", fastJev.model]], undefined),
    // Legacy: exactly "1" enables it.
    allowDroppingCalls: pick("allowDroppingCalls", [["env", env.OMP_JEV_ALLOW_DROPPING_CALLS === "1" ? true : undefined]], false),
    notes,
    sources,
  };

  if (!options.telemetryDirInjected) {
    const path = env.OMP_TELEMETRY_PATH?.trim();
    if (path && isAbsolute(path)) {
      config.telemetryDir = dirname(path);
      sources.telemetryDir = "env";
    } else if (path) notes.push("OMP_TELEMETRY_PATH ignored: not an absolute path");
  }
  return { ...loaded, config, ompContext: settings } as LoadedConfig;
}

/** Legacy kill switch: `OMP_TELEMETRY=0` writes no telemetry at all. */
export function ompTelemetryEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.OMP_TELEMETRY !== "0";
}

/** `OMP_TELEMETRY_MAX_BYTES` (legacy rule: finite and ≥ 4096, else the default). */
export function ompTelemetryMaxBytes(env: Readonly<Record<string, string | undefined>>): number | undefined {
  return envNumber(env, "OMP_TELEMETRY_MAX_BYTES", (n) => n >= 4096) !== undefined ? Math.floor(Number(env.OMP_TELEMETRY_MAX_BYTES)) : undefined;
}
