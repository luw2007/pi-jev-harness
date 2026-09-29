/**
 * Shared CLI plumbing: injectable process boundary, run-directory resolution, and the command
 * error that maps to exit code 1. Nothing here spawns processes or writes files.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentSessionEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadedConfig } from "../adapters/pi/config.ts";
import { RUN_FILES } from "../harness/index.ts";

/** What `pi-jev run` hands the session factory. */
export interface RunSessionOptions {
  /** Existing workspace directory; Pi's cwd for discovery and built-in tool paths. */
  cwd: string;
  /** Environment for the pi-jev extension; carries `PI_JEV_RUN_ID` and `PI_JEV_RUNS_DIR`. */
  env: Readonly<Record<string, string | undefined>>;
  /** The pi-jev extension entry file (`<harnessRoot>/src/adapters/pi/index.ts`). */
  extensionPath: string;
}

/** The part of Pi's `AgentSession` that `run` uses; the real session satisfies it as is. */
export interface RunSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** Signals `run` turns into a session cancel (Ctrl-C, `kill`). */
export type RunSignal = "SIGINT" | "SIGTERM";

/** Process signal boundary of `run`; injectable so tests never send real signals. */
export interface RunSignals {
  /** Install SIGINT/SIGTERM handlers; returns their removal. `run` holds them only while the session runs. */
  subscribe(handler: (signal: RunSignal) => void): () => void;
  /** End the process at once (a second signal). */
  exit(code: number): void;
}

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Home directory; run products and the default config live under `<home>/.pi/agent`. */
  home: string;
  cwd: string;
  /** Adapter config file; defaults to `<home>/.pi/agent/pi-jev-harness/config.json`. */
  configPath?: string;
  /** Root of this package, used to recognise its own extension in Pi settings. */
  harnessRoot: string;
  out(text: string): void;
  err(text: string): void;
  /** Synchronous process spawn returning stdout; throws on failure. Only `doctor` calls it. */
  execFile(command: string, args: readonly string[]): string;
  /** Starts one Pi session with the pi-jev extension loaded. Only `run` calls it; absent means `run` is unavailable. */
  createSession?(options: RunSessionOptions): Promise<RunSession>;
  /** Signal handling for `run`; absent means signals keep Node's default behavior. */
  signals?: RunSignals;
  /** How long `run` waits for the session to settle after an abort (signal or `--max-time`); default 10 s. */
  abortGraceMs?: number;
  /**
   * Extension factory `doctor` registers against a recording fake API, given the config `doctor`
   * loaded. Default: this package's `createExtension` on that config, this environment, a private
   * claim registry, no network and no telemetry writes (in-process, offline).
   */
  loadExtension?(loaded: LoadedConfig): Promise<(pi: ExtensionAPI) => void>;
}

/** A command that could not run as asked (bad input, missing or malformed products): exit 1. */
export class CliError extends Error {}

export interface RunTarget {
  dir: string;
  receipts: string;
}

const RUN_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * Parent of the run directories, from the adapter's own config loader with the same home, config
 * path and environment: env `PI_JEV_RUNS_DIR` > config file `harness.runsDir` >
 * `<home>/.pi/agent/pi-jev-harness/runs` (an invalid file leaves the adapter off on defaults).
 * `run` passes the result back as `PI_JEV_RUNS_DIR`, so the extension, `report` and `replay`
 * all use one directory.
 */
export async function resolveRunsDir(deps: CliDeps): Promise<string> {
  const fromEnv = deps.env.PI_JEV_RUNS_DIR;
  if (fromEnv && !isAbsolute(fromEnv)) throw new CliError(`PI_JEV_RUNS_DIR 必须是绝对路径：${fromEnv}`);
  // PI_JEV_RUN_ID names one run, not the directory; an invalid value must not reset the directory.
  const env = { ...deps.env, PI_JEV_RUN_ID: undefined };
  return (await loadConfig({ home: deps.home, ...(deps.configPath ? { path: deps.configPath } : {}), env })).config.harness.runsDir;
}

/**
 * `<run-id|path>`: an existing directory is the run directory; an existing file is taken as a
 * file inside it (`receipts.jsonl` for replay, `run.json` for report); otherwise a safe run id
 * resolves to `<runsDir>/<run-id>/` (see `resolveRunsDir`).
 */
export async function resolveRunTarget(arg: string, deps: CliDeps): Promise<RunTarget> {
  const path = resolve(deps.cwd, arg);
  const info = await stat(path).catch(() => null);
  if (info?.isDirectory()) return { dir: path, receipts: join(path, RUN_FILES.receipts) };
  if (info?.isFile()) return { dir: dirname(path), receipts: path };
  if (RUN_ID.test(arg) && arg !== "." && arg !== "..") {
    const dir = join(await resolveRunsDir(deps), arg);
    return { dir, receipts: join(dir, RUN_FILES.receipts) };
  }
  throw new CliError(`找不到运行：${arg}`);
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
