/**
 * `pi-jev doctor`: read-only environment check. Never calls a provider or Jev, never prints the
 * value of `TYPESAFE_API_KEY` (only whether it is set). The tool-registration check runs this
 * package's extension factory in-process on the loaded config against a recording fake API and
 * emits one synthetic `session_start` (tools registered per session, such as `jev_recall`, appear
 * only then); its network is refused and its telemetry discarded. The only writes are probe files
 * created with `wx` in an existing directory and removed immediately.
 */
import { randomUUID } from "node:crypto";
import { access, constants, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig, readJevKey, type LoadedConfig } from "../adapters/pi/config.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CliError, resolveRunsDir, type CliDeps } from "./context.ts";

type Check = "ok" | "warn" | "fail";

/** Pi version this package is pinned to (`package.json` dependency); a different host is a warning. */
export const PINNED_PI_VERSION = "0.87.1";

/**
 * Tools and commands the docs name for the extension (technical §10, product §4.1). `jev_recall`
 * is registered only when `context.request` is not off (`CONDITIONAL_TOOLS`).
 */
export const EXPECTED_REGISTRATIONS = {
  tools: ["jev_route", "jev_acceptance_gate", "foreman_assess", "jev_recall"],
  commands: ["jev"],
} as const;

/** Expected tools that depend on config; true when the loaded config enables them. */
const CONDITIONAL_TOOLS: Record<string, (loaded: LoadedConfig) => boolean> = {
  jev_recall: (loaded) => loaded.config.context.request !== "off",
};

export interface RegistrationCheck {
  /** fail: the extension could not be loaded; warn: a name the config requires is not registered. */
  status: Check;
  tools: string[];
  commands: string[];
  /** Event names the extension subscribed to. */
  events: string[];
  /** `required` is false for a conditional tool the loaded config does not enable. */
  expected: { kind: "tool" | "command"; name: string; required: boolean; registered: boolean }[];
  reason?: string;
}

export interface ExtensionSource {
  /** Where Pi would pick the entry up. */
  origin: string;
  entry: string;
}

export interface DirProbe {
  path: string;
  /** Existing directory the probe file was written in (the path itself or its nearest ancestor). */
  probedAt: string | null;
  exists: boolean;
  writable: boolean;
  reason?: string;
}

export interface DoctorReport {
  node: { version: string };
  /** `matchesPinned` is null when no version could be read. */
  pi: { status: Check; version: string | null; pinned: string; matchesPinned: boolean | null; reason?: string };
  /** `notes`: non-fatal notes about a valid file (e.g. the ignored legacy `router.models` key). */
  config: { path: string; state: "missing" | "valid" | "invalid"; mode: string; reason?: string; notes?: string[] };
  extension: { status: Check; loads: ExtensionSource[]; unreadable: string[] };
  registration: RegistrationCheck;
  jevKey: { present: boolean };
  runsDir: DirProbe;
  telemetryDir: DirProbe;
}

const PACKAGE_NAME = "pi-jev-harness";

async function realOrResolved(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** An entry refers to this package when it resolves inside its root or names the package. */
async function isHarnessEntry(entry: string, base: string, root: string, home: string): Promise<boolean> {
  if (entry.includes(PACKAGE_NAME)) return true;
  if (/^(npm|git|https?):/.test(entry)) return false;
  const path = entry.startsWith("~/") ? join(home, entry.slice(2)) : isAbsolute(entry) ? entry : resolve(base, entry);
  const real = await realOrResolved(path);
  return real === root || real.startsWith(`${root}/`);
}

async function settingsEntries(file: string, unreadable: string[]): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable.push(file);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    unreadable.push(file);
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const { extensions, packages } = parsed as { extensions?: unknown; packages?: unknown };
  const out: string[] = [];
  if (Array.isArray(extensions)) for (const e of extensions) if (typeof e === "string" && !e.startsWith("!") && !e.startsWith("-")) out.push(e.replace(/^\+/, ""));
  if (Array.isArray(packages))
    for (const p of packages) {
      const source = typeof p === "string" ? p : p !== null && typeof p === "object" ? (p as { source?: unknown }).source : undefined;
      if (typeof source === "string") out.push(source);
    }
  return out;
}

/**
 * Where this package is loaded from: user/project extension directories and the `extensions` /
 * `packages` arrays of user and project settings. More than one load is a duplicate.
 */
async function extensionLoads(deps: CliDeps): Promise<DoctorReport["extension"]> {
  const root = await realOrResolved(deps.harnessRoot);
  const agentDir = join(deps.home, ".pi", "agent");
  const projectDir = join(deps.cwd, ".pi");
  const loads: ExtensionSource[] = [];
  const unreadable: string[] = [];
  for (const dir of [join(agentDir, "extensions"), join(projectDir, "extensions")]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable.push(dir);
      continue;
    }
    for (const name of names.sort())
      if (await isHarnessEntry(name, dir, root, deps.home)) loads.push({ origin: dir, entry: name });
  }
  for (const [file, base] of [[join(agentDir, "settings.json"), agentDir], [join(projectDir, "settings.json"), projectDir]] as const)
    for (const entry of await settingsEntries(file, unreadable))
      if (await isHarnessEntry(entry, base, root, deps.home)) loads.push({ origin: file, entry });
  const status: Check = loads.length > 1 ? "fail" : unreadable.length > 0 ? "warn" : "ok";
  return { status, loads, unreadable };
}

/** Write and remove a probe file in `path`, or in its nearest existing ancestor when it is absent. */
async function probeDir(path: string): Promise<DirProbe> {
  let at = path;
  let exists = true;
  for (;;) {
    const info = await stat(at).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : error));
    if (info instanceof Error) return { path, probedAt: null, exists: false, writable: false, reason: info.code ?? info.message };
    if (info?.isDirectory()) break;
    if (info) return { path, probedAt: null, exists: false, writable: false, reason: `${at} is not a directory` };
    exists = false;
    const parent = dirname(at);
    if (parent === at) return { path, probedAt: null, exists, writable: false, reason: "no existing ancestor" };
    at = parent;
  }
  const probe = join(at, `.pi-jev-doctor-${randomUUID()}.tmp`);
  try {
    await access(at, constants.W_OK);
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    return { path, probedAt: at, exists, writable: true };
  } catch (error) {
    return { path, probedAt: at, exists, writable: false, reason: (error as NodeJS.ErrnoException).code ?? String(error) };
  } finally {
    await rm(probe, { force: true });
  }
}

/** This package's extension on `loaded`, with no network and no telemetry writes. */
function offlineExtension(deps: CliDeps): (loaded: LoadedConfig) => Promise<(pi: ExtensionAPI) => void> {
  return async (loaded) => {
    const { createExtension } = await import("../adapters/pi/index.ts");
    const refuse = async (): Promise<Response> => {
      throw new Error("pi-jev doctor makes no network requests");
    };
    return createExtension(
      {
        env: deps.env,
        loadConfig: async () => loaded,
        fetch: refuse as typeof fetch,
        createTelemetry: () => ({ record: async () => false, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
      },
      {},
    );
  };
}

/** The only session event emitted: what `startSession` reads from its context. */
const SYNTHETIC_SESSION_START = { type: "session_start", reason: "startup" } as const;
const SYNTHETIC_CONTEXT = { sessionManager: { getBranch: () => [] } };

/**
 * Run the extension factory against a fake API that records `registerTool`, `registerCommand`
 * and `on`; every other member is a no-op. Then emit one `session_start` so per-session
 * registrations happen as in a real session. No task runs and no session is shut down, so nothing
 * is finalized or written.
 */
async function registrationCheck(deps: CliDeps, loaded: LoadedConfig): Promise<RegistrationCheck> {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const sessionStart: ((...args: unknown[]) => unknown)[] = [];
  const recorders: Record<string, (...args: unknown[]) => void> = {
    registerTool: (tool) => void tools.push(String((tool as { name?: unknown })?.name)),
    registerCommand: (name) => void commands.push(String(name)),
    on: (event, handler) => {
      if (!events.includes(String(event))) events.push(String(event));
      if (event === "session_start" && typeof handler === "function") sessionStart.push(handler as (...args: unknown[]) => unknown);
    },
  };
  const fake = new Proxy({}, { get: (_, prop) => (typeof prop === "string" && recorders[prop]) || (() => undefined) }) as ExtensionAPI;
  let reason: string | undefined;
  try {
    (await (deps.loadExtension ?? offlineExtension(deps))(loaded))(fake);
    for (const handler of sessionStart) await handler(SYNTHETIC_SESSION_START, SYNTHETIC_CONTEXT);
  } catch (error) {
    reason = error instanceof Error ? error.message.split("\n")[0]! : String(error);
  }
  const required = (name: string) => CONDITIONAL_TOOLS[name]?.(loaded) ?? true;
  const expected = [
    ...EXPECTED_REGISTRATIONS.tools.map((name) => ({ kind: "tool" as const, name, required: required(name), registered: tools.includes(name) })),
    ...EXPECTED_REGISTRATIONS.commands.map((name) => ({ kind: "command" as const, name, required: true, registered: commands.includes(name) })),
  ];
  const status: Check = reason !== undefined ? "fail" : expected.every((e) => e.registered || !e.required) ? "ok" : "warn";
  return { status, tools, commands, events, expected, ...(reason !== undefined ? { reason } : {}) };
}

function piCheck(deps: CliDeps): DoctorReport["pi"] {
  let output: string;
  try {
    output = deps.execFile("pi", ["--version"]).trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    return { status: "fail", version: null, pinned: PINNED_PI_VERSION, matchesPinned: null, reason };
  }
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0] ?? null;
  const matchesPinned = version === null ? null : version === PINNED_PI_VERSION;
  return { status: matchesPinned ? "ok" : "warn", version: version ?? output, pinned: PINNED_PI_VERSION, matchesPinned };
}

export async function doctor(deps: CliDeps): Promise<DoctorReport> {
  const pi = piCheck(deps);
  const loaded = await loadConfig({ home: deps.home, ...(deps.configPath ? { path: deps.configPath } : {}), env: deps.env });
  const state = loaded.source === "file" ? "valid" : loaded.source === "invalid" ? "invalid" : "missing";
  return {
    node: { version: process.version },
    pi,
    config: { path: loaded.path, state, mode: loaded.config.mode, ...(loaded.reason ? { reason: loaded.reason } : {}), ...(loaded.notes ? { notes: loaded.notes } : {}) },
    extension: await extensionLoads(deps),
    registration: await registrationCheck(deps, loaded),
    jevKey: { present: readJevKey(deps.env) !== undefined },
    // Same resolver as `run`/`report`: PI_JEV_RUNS_DIR > harness.runsDir > default.
    runsDir: await resolveRunsDir(deps).then(probeDir, (error: unknown) => {
      if (!(error instanceof CliError)) throw error;
      return { path: deps.env.PI_JEV_RUNS_DIR ?? "", probedAt: null, exists: false, writable: false, reason: error.message };
    }),
    telemetryDir: await probeDir(loaded.config.telemetryDir),
  };
}

const CONFIG_LABELS = { missing: "缺失（使用默认值，mode off）", valid: "有效", invalid: "损坏" } as const;

function dirLine(label: string, d: DirProbe): string {
  if (d.writable) return `${label}：可写（${d.path}${d.exists ? "" : `，尚不存在，已在 ${d.probedAt} 探测`}）`;
  return `${label}：不可写（${d.path}${d.reason ? `：${d.reason}` : ""}）`;
}

function piLine(p: DoctorReport["pi"]): string {
  if (p.version === null) return `Pi：不可用（${p.reason ?? "未知原因"}）`;
  if (p.matchesPinned === null) return `Pi：${p.version}（警告：无法识别版本号，固定版本 ${p.pinned}）`;
  return p.matchesPinned ? `Pi：${p.version}（与固定版本一致）` : `Pi：${p.version}（警告：与固定版本 ${p.pinned} 不一致）`;
}

function registrationLines(r: RegistrationCheck): string[] {
  if (r.reason !== undefined) return [`工具注册：扩展无法加载（${r.reason}）`];
  const shown = (e: RegistrationCheck["expected"][number]) => (e.kind === "command" ? `/${e.name}` : e.name);
  const extra = [...r.tools.filter((t) => !(EXPECTED_REGISTRATIONS.tools as readonly string[]).includes(t)),
    ...r.commands.filter((c) => !(EXPECTED_REGISTRATIONS.commands as readonly string[]).includes(c)).map((c) => `/${c}`)];
  return [
    `工具注册：扩展注册了 ${r.tools.length} 个工具、${r.commands.length} 个命令、${r.events.length} 个事件${r.status === "ok" ? "" : "（部分预期项未注册）"}`,
    ...r.expected.map((e) => `  - ${shown(e)}：${e.registered ? "已注册" : e.required ? "未注册" : "按配置未启用"}`),
    ...(extra.length > 0 ? [`  - 预期外：${extra.join("、")}`] : []),
  ];
}

export function renderDoctor(r: DoctorReport): string {
  const ext = r.extension;
  const extLine =
    ext.loads.length === 0
      ? "扩展：未在扩展目录或设置中发现本扩展（可用 pi --extension 加载）"
      : ext.loads.length === 1
        ? `扩展：加载一次（${ext.loads[0]!.origin}：${ext.loads[0]!.entry}）`
        : `扩展：重复加载 ${ext.loads.length} 次\n${ext.loads.map((l) => `  - ${l.origin}：${l.entry}`).join("\n")}`;
  const lines = [
    `Node：${r.node.version}`,
    piLine(r.pi),
    `配置：${CONFIG_LABELS[r.config.state]}（${r.config.path}）${r.config.reason ? `：${r.config.reason}` : ""}；生效 mode ${r.config.mode}`,
    ...(r.config.notes ?? []).map((note) => `配置提示：${note}`),
    extLine,
    ...(ext.unreadable.length > 0 ? [`扩展检查无法读取：${ext.unreadable.join("、")}`] : []),
    ...registrationLines(r.registration),
    `TYPESAFE_API_KEY：${r.jevKey.present ? "已设置" : "未设置"}`,
    dirLine("运行产物目录", r.runsDir),
    dirLine("telemetry 目录", r.telemetryDir),
    "未调用任何 provider 或 Jev。",
  ];
  return `${lines.join("\n")}\n`;
}
