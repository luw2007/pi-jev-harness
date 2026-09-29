/**
 * Coexistence with the legacy `@omp-jev/harness` plugin (安全). Both claim the `/jev` command
 * and the `jev_acceptance_gate` tool, and OMP lets the later loader silently win, so running both
 * would make either one's decisions unreliable. On any sign of the legacy plugin this adapter is
 * forced off, registers none of the shared names, and reports `adapter:legacy_conflict`.
 *
 * Two checks, because OMP runtime actions (`getAllTools`, `getCommands`) throw during extension
 * load:
 * - load time (`register()`): the plugins lock (read-only). Decides whether same-named tools and
 *   commands are registered at all.
 *   A `/jev` already registered by an earlier-loaded extension (when the host can list commands at
 *   load) counts too.
 * - `session_start`: a non-own `jev_acceptance_gate` tool (source path outside this package, both
 *   sides realpath'd so `omp plugin link` symlinks match) or a `/jev` command that is not ours.
 *   Forces the session off.
 *
 * OMP 18.3.5 `getCommands()` is built from a Map keyed by name (later loader wins, no path, no
 * handler), so `/jev` ownership is told by its description: ours carries `OWN_COMMAND_DESCRIPTION`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostToolInfo } from "../core/port.ts";

export const LEGACY_PLUGIN = "@omp-jev/harness";
/** Names both plugins register; never registered while a conflict is known. */
export const LEGACY_TOOL = "jev_acceptance_gate";
/**
 * Every tool name the legacy plugin registers (acceptance, assessment, planning capabilities)
 * plus `jev_recall`; none is registered by this adapter while a load-time conflict is known.
 */
export const LEGACY_TOOLS: ReadonlySet<string> = new Set([LEGACY_TOOL, "foreman_assess", "jev_route", "jev_recall"]);
export const LEGACY_COMMAND = "jev";

/** This package's root; a tool whose source path lies under it is ours. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Description of this adapter's `/jev`; the only ownership mark OMP's command list exposes. */
export const OWN_COMMAND_DESCRIPTION = "Jev harness status and mode (off | shadow) [pi-jev-harness]";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** OMP `normalizeProfileName`: "", whitespace and "default" → default profile (undefined); invalid → throws. */
function normalizeProfileName(profile: string | undefined): string | undefined {
  const normalized = profile?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (normalized === "." || normalized === ".." || normalized.endsWith(".") || !PROFILE_NAME_RE.test(normalized) || WINDOWS_RESERVED_BASENAME_RE.test(normalized))
    throw new Error(`Invalid OMP profile "${profile}"`);
  return normalized;
}

/** OMP's `*FromEnvSafe`: an invalid name selects the default profile. */
function safeProfile(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * OMP's plugins lock path, ported from OMP 18.3.5 `getPluginsLockfile()` (packages/utils/src/dirs.ts:
 * module-load `activeProfile`, `resolveActiveAgentDirOverride`, `DirResolver`, `rootSubdir("plugins", "data")`):
 * - profile: `OMP_PROFILE`, or `PI_PROFILE` only when `OMP_PROFILE` is unset; normalized, invalid → default;
 * - config root `<home>/<PI_CONFIG_DIR || ".omp">[/profiles/<name>]`;
 * - default profile honors `PI_CODING_AGENT_DIR` unless it equals the `PI_PROFILE` agent dir; any
 *   agent dir other than `<root>/agent` disables XDG;
 * - linux/darwin: an existing `$XDG_DATA_HOME/omp[/profiles/<name>]` replaces the data root.
 */
export function ompPluginsLockPath(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const profile = safeProfile(() => normalizeProfileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE));
  const base = join(home, env.PI_CONFIG_DIR || ".omp");
  const profileRoot = (name: string) => join(base, "profiles", name);
  const configRoot = profile ? profileRoot(profile) : base;
  let agentOverride: string | undefined;
  if (!profile) {
    const piProfile = safeProfile(() => normalizeProfileName(env.PI_PROFILE));
    const agentEnv = env.PI_CODING_AGENT_DIR;
    agentOverride = piProfile !== undefined && agentEnv === join(profileRoot(piProfile), "agent") ? undefined : agentEnv;
  }
  const defaultAgent = join(configRoot, "agent");
  const agentDir = agentOverride ? resolve(agentOverride) : defaultAgent;
  let dataRoot = configRoot;
  const xdg = env.XDG_DATA_HOME;
  if ((platform === "linux" || platform === "darwin") && agentDir === defaultAgent && xdg) {
    const app = join(xdg, "omp");
    const candidate = profile ? join(app, "profiles", profile) : app;
    try {
      if (exists(candidate)) dataRoot = candidate;
    } catch {
      // OMP ignores a failed existence check.
    }
  }
  return join(dataRoot, "plugins", "omp-plugins.lock.json");
}

/** Reason when the lock lists the legacy plugin as enabled; unreadable/missing lock → none. */
export function lockConflict(readLock: () => string | undefined): string | undefined {
  let text: string | undefined;
  try {
    text = readLock();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const entry = (JSON.parse(text) as { plugins?: Record<string, { enabled?: unknown }> })?.plugins?.[LEGACY_PLUGIN];
    return entry && entry.enabled !== false ? `${LEGACY_PLUGIN} enabled in plugins lock` : undefined;
  } catch {
    return undefined;
  }
}

/** `readLock` for a path: missing file → undefined. */
export function readLockFile(path: string | undefined): () => string | undefined {
  return () => {
    if (!path) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Both sides realpath'd: `omp plugin link` reports the entry through a symlink. */
export function isOwnPath(path: string | undefined, root: string = PACKAGE_ROOT): boolean {
  if (typeof path !== "string" || !path.startsWith(sep)) return false;
  const file = real(path), dir = real(root);
  return file === dir || file.startsWith(dir + sep);
}

/** Reason when the host already has a legacy tool or `/jev` this adapter does not own. */
export function runtimeConflict(
  tools: readonly HostToolInfo[] | undefined,
  commands: ReadonlyArray<{ name: string; description?: string }> | undefined,
  ownCommand: boolean,
  root: string = PACKAGE_ROOT,
): string | undefined {
  const tool = tools?.find((row) => row.name === LEGACY_TOOL);
  if (tool && !isOwnPath(tool.sourceInfo?.path, root)) return `non-own ${LEGACY_TOOL} tool registered (${tool.sourceInfo?.path ?? "unknown source"})`;
  // One row per name (later loader wins): not ours unless we registered it and it still carries our mark.
  const jev = commands?.find((row) => row.name === LEGACY_COMMAND);
  if (jev && !(ownCommand && jev.description === OWN_COMMAND_DESCRIPTION)) return `non-own /${LEGACY_COMMAND} command registered`;
  return undefined;
}
