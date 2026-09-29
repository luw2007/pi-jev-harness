/**
 * Read-only mapping of the legacy `@omp-jev/harness` config files in `~/.omp/agent`:
 * `jev-harness.json` (schemaVersion 1, `capabilities.<name>.mode`), `jev-autorun.json` (`mode`,
 * `toolGroups`) and `acceptance-gate.json` (`mode`). Same precedence as the legacy loader:
 * jev-harness.json first, then the per-capability file. Legacy `dry-run` maps to `shadow`.
 * A present acceptance-gate.json without a valid mode means `off` (legacy semantics).
 * Files are only read, never created or rewritten. `toolGroups` is reported, never applied.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CapabilityMode = "off" | "shadow" | "on";

export interface LegacySetting {
  mode: CapabilityMode;
  /** File the value came from. */
  source: string;
}

export interface LegacyConfig {
  dir: string;
  acceptance?: LegacySetting;
  autorun?: LegacySetting;
  /** Legacy tool groups (jev-autorun.json); shown in `/jev status`, never applied. */
  toolGroups?: { names: string[]; source: string };
  /** Why a present file was ignored (e.g. an invalid jev-harness.json); shown in `/jev status`. */
  notes?: string[];
}

/** Legacy loader rules (core/config.ts validNew): capability names and their allowed modes. */
const MODE_SETS: Readonly<Record<string, readonly string[]>> = {
  planning: ["on", "off"],
  assessment: ["on", "off"],
  acceptance: ["dry-run", "on", "off"],
  continuation: ["dry-run", "on", "off"],
  compaction: ["on", "off"],
  toolContext: ["on", "shadow", "off"],
};
/** Removed capabilities the legacy loader still accepts and ignores. */
const REMOVED = new Set(["modelRouting", "capacity"]);

/** Same check as the legacy loader: the whole file is valid, or it is ignored entirely. */
export function validLegacyHarness(value: Record<string, unknown> | undefined): boolean {
  const caps = value?.capabilities;
  if (!value || value.schemaVersion !== 1 || !caps || typeof caps !== "object" || Array.isArray(caps)) return false;
  for (const [name, setting] of Object.entries(caps as Record<string, unknown>)) {
    if (REMOVED.has(name)) continue;
    const modes = MODE_SETS[name];
    if (!modes || !setting || typeof setting !== "object" || Array.isArray(setting)) return false;
    const mode = (setting as Record<string, unknown>).mode;
    if (typeof mode !== "string" || !modes.includes(mode)) return false;
  }
  return true;
}

export const LEGACY_FILES = {
  harness: "jev-harness.json",
  autorun: "jev-autorun.json",
  acceptance: "acceptance-gate.json",
} as const;

export function legacyConfigDir(home: string): string {
  return join(home, ".omp", "agent");
}

type Json = { state: "missing" } | { state: "invalid" } | { state: "object"; value: Record<string, unknown> };

/** Legacy mode word → capability mode; anything else is undefined. */
export function mapLegacyMode(value: unknown): CapabilityMode | undefined {
  if (value === "dry-run") return "shadow";
  return value === "on" || value === "off" ? value : undefined;
}

function capabilityMode(value: Record<string, unknown> | undefined, name: string): unknown {
  const caps = value?.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return undefined;
  const setting = (caps as Record<string, unknown>)[name];
  return setting && typeof setting === "object" && !Array.isArray(setting) ? (setting as Record<string, unknown>).mode : undefined;
}

export async function loadLegacyConfig(dir: string, read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<LegacyConfig> {
  const load = async (name: string): Promise<Json> => {
    let text: string;
    try {
      text = await read(join(dir, name));
    } catch {
      return { state: "missing" };
    }
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? { state: "object", value: value as Record<string, unknown> } : { state: "invalid" };
    } catch {
      return { state: "invalid" };
    }
  };
  const [harness, autorun, acceptance] = await Promise.all([load(LEGACY_FILES.harness), load(LEGACY_FILES.autorun), load(LEGACY_FILES.acceptance)]);
  const harnessValue = harness.state === "object" && validLegacyHarness(harness.value) ? harness.value : undefined;
  const at = (name: string) => join(dir, name);
  const out: LegacyConfig = { dir };
  if (harness.state !== "missing" && !harnessValue) out.notes = [`legacy ${at(LEGACY_FILES.harness)} invalid; ignored`];

  const acceptanceNew = mapLegacyMode(capabilityMode(harnessValue, "acceptance"));
  const acceptanceValue = acceptance.state === "object" ? acceptance.value : undefined;
  const acceptanceOld = mapLegacyMode(acceptanceValue?.mode ?? capabilityMode(acceptanceValue, "acceptance"));
  if (acceptanceNew) out.acceptance = { mode: acceptanceNew, source: at(LEGACY_FILES.harness) };
  else if (acceptanceOld) out.acceptance = { mode: acceptanceOld, source: at(LEGACY_FILES.acceptance) };
  else if (acceptance.state !== "missing") out.acceptance = { mode: "off", source: at(LEGACY_FILES.acceptance) };

  const autorunNew = mapLegacyMode(capabilityMode(harnessValue, "continuation"));
  const autorunValue = autorun.state === "object" ? autorun.value : undefined;
  const autorunOld = mapLegacyMode(autorunValue?.mode ?? capabilityMode(autorunValue, "continuation"));
  if (autorunNew) out.autorun = { mode: autorunNew, source: at(LEGACY_FILES.harness) };
  else if (autorunOld) out.autorun = { mode: autorunOld, source: at(LEGACY_FILES.autorun) };

  const groups = autorunValue?.toolGroups;
  if (groups && typeof groups === "object" && !Array.isArray(groups)) {
    const names = Object.keys(groups);
    if (names.length) out.toolGroups = { names, source: at(LEGACY_FILES.autorun) };
  }
  return out;
}
