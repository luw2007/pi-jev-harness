/**
 * Adapter configuration (host-neutral; re-exported by the Pi adapter). Reads only; never writes, so a damaged file is never replaced by defaults.
 * The Jev key comes from the environment alone and is never part of the config object.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DEFAULT_MAX_CONTINUATIONS } from "../../harness/index.ts";
import { TYPESAFE_PROFILE, parseJevChainConfig, type JevChainConfig } from "../../jev/index.ts";

/**
 * Left edge of a credential token: not glued to a letter or digit (so `task-...` never reads as
 * `sk-...`), except right after a JSON string escape such as `\n`, where the key is glued to the
 * escape letter (`"...:\nsk-proj-..."` from JSON.stringify of a provider body). `_` does not block.
 */
const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrtbf]))`;
const token = (body: string, flags = "") => new RegExp(START + body, flags);

/**
 * Credential shapes checked before any task intent leaves the machine (outbound.taskIntent=true)
 * and scrubbed from stored text. A hit withholds the Jev request; the matched text is never
 * recorded. Every pattern matches the whole secret value, so replacing the match removes it. The
 * current `TYPESAFE_API_KEY` value is checked separately by exact substring.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Common API key prefixes, any case: OpenAI-style `sk-`, GitHub `ghp_`, Slack `xox?-`, AWS `AKIA`
  // (the AWS body stays uppercase by contract).
  token(String.raw`sk-[A-Za-z0-9_-]{8,}`, "i"),
  token(String.raw`ghp_[A-Za-z0-9]{8,}`, "i"),
  token(String.raw`xox[a-z]-[A-Za-z0-9-]{8,}`, "i"),
  token(String.raw`[Aa][Kk][Ii][Aa][0-9A-Z]{12,}`),
  // PEM private keys of any type, banner through END (or to the end of a truncated text).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*)/,
  // Secret assignments such as `password=...` or `token = "..."`; the whole value is matched
  // (quotes may be JSON-escaped: `token=\"...\"`).
  token(String.raw`(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*=\s*(?:\\?"[^"\n]*"?|\\?'[^'\n]*'?|[^\s"',;}&]+)`, "i"),
  // Colon/JSON/YAML forms (`"token": "..."`, `password: x`). The value is 8+ characters with a
  // non-letter, or 16+ letters: short bare words (`true`, `none`, `placeholder`) are not secrets.
  token(
    String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\\?["']?\s*[:=]\s*\\?["']?(?:(?![A-Za-z]+(?:\\?["'\s,;}]|$))[^\s"',;}]{8,}|[A-Za-z]{16,})`,
    "i",
  ),
  // HTTP bearer credentials.
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  // JWT: three base64url segments, header starts with `eyJ`.
  token(String.raw`eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}`),
  // Cloud/hosting prefixes: Google `AIza` (fixed case), GitLab `glpat-`, GitHub fine-grained
  // `github_pat_` (Slack `xoxb-`/`xoxp-` are covered by the `xox?-` pattern above).
  token(String.raw`AIza[0-9A-Za-z_-]{30,}`),
  token(String.raw`glpat-[A-Za-z0-9_-]{16,}`, "i"),
  token(String.raw`github_pat_[A-Za-z0-9_]{20,}`, "i"),
];

/**
 * A legacy `router.models` subtree (T051: model routing removed; model selection is magpie's) is
 * ignored unread; the file stays valid and this note is reported once in status/doctor.
 */
export const MODEL_ROUTING_IGNORED_NOTE = "router.models 配置已忽略（模型路由由 magpie 负责）";

/**
 * Modes this adapter supports. Under Pi `on` is per session only (`/jev mode on`); the config
 * file refuses `mode: "on"` unless the host opts in (`LoadConfigOptions.allowModeOn`, OMP only). In `on` a capability changes behavior only when it is enabled in config
 * and its gate is validated (today: `harness.enforce` kinds, `harness.continuation` and
 * `router.tools: "on"`); every other capability behaves exactly as in shadow. Model routing is not
 * handled here at all (T051): model selection is magpie's.
 */
export type AdapterMode = "off" | "shadow" | "on";

/**
 * Per-feature router mode. `on` in the file is allowed but takes effect only while the session
 * mode is `on`; in a shadow session it observes like `shadow`.
 */
export type RouterFeatureMode = "off" | "shadow" | "on";
export const ROUTER_FEATURE_MODES: readonly RouterFeatureMode[] = ["off", "shadow", "on"];

export interface ToolRoutingConfig {
  topK: number;
  confidenceFloor: number;
  probabilityFloor: number;
  relevanceWindow: number;
  maxCostUnits: number;
  maxBundleTools: number;
  maxBundleSchemaBytes: number;
}

/**
 * Action kinds whose review may be enforced. `edit` is refused: Pi's edit falls back to fuzzy
 * matching that the harness's exact check rejects, so enforcing it would block edits Pi applies correctly.
 */
export const ENFORCEABLE_KINDS = ["create", "overwrite"] as const;
export type EnforceableKind = (typeof ENFORCEABLE_KINDS)[number];

/**
 * Run-directory injection (the contract `pi-jev run` relies on). Precedence, highest first:
 * - runsDir: `LoadConfigOptions.runsDir` > env `PI_JEV_RUNS_DIR` > file `harness.runsDir` >
 *   default `~/.pi/agent/pi-jev-harness/runs`. The env value must be an absolute path.
 * - runId: `LoadConfigOptions.runId` > env `PI_JEV_RUN_ID` > generated `run_<id>`. The value must be
 *   one path segment matching `RUN_ID_PATTERN`. It names the first task's run directory in the
 *   session; later tasks in the same session get `<runId>-2`, `<runId>-3`, ... so no run
 *   directory is ever reused. An existing `run.json` there is never overwritten.
 * Both env values are read from the injected `env` of `loadConfig`, never from `process.env` here.
 * An invalid env value makes the config invalid (adapter off) with the reason in `/jev status`.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Bounded continuation at `agent_before_settle` (technical §7.3). Disabled (default) or outside
 * mode `on`, the decision is still computed and recorded but never returned to Pi.
 */
export interface ContinuationConfig {
  enabled: boolean;
  /** Automatic continuations per user task; an integer from 0 to `DEFAULT_MAX_CONTINUATIONS` (2). */
  max: number;
}

export interface HarnessConfig {
  /** Kinds whose `tool_call` awaits review and blocks on failure; empty (default) means shadow only. */
  enforce: EnforceableKind[];
  continuation: ContinuationConfig;
  /** Parent of the per-task run directories (`<runsDir>/<run-id>/`). */
  runsDir: string;
  /** Exact run id for the session's first task (from `PI_JEV_RUN_ID` or injected); generated when absent. */
  runId?: string;
}

/**
 * Request-level context reduction (technical §8, §9.2; product §7.4). Independent of router and
 * harness keys. `request` and `summaryReplacement` are two separate switches: turning the first
 * off says nothing about the second. Summary replacement is not implemented, so `"off"` (the
 * native Pi compaction path) is the only accepted value; anything else makes the config invalid.
 */
export type ContextRequestMode = "off" | "shadow" | "on";

export interface ContextLimitsConfig {
  /** Per archived payload, UTF-8 bytes (spill.ts default 8 MiB). */
  maxPayloadBytes?: number;
  /** Per session archive total, UTF-8 bytes (spill.ts default 64 MiB). */
  maxSessionBytes?: number;
  /** Newest assistant turns never reduced (mapping.ts default 3). */
  recentTurns?: number;
  /** Below this many text characters a request is left alone (default 0). */
  minChars?: number;
}

export interface ContextConfig {
  /** off (default) | shadow (compute and record only) | on (apply; only when the session mode is on). */
  request: ContextRequestMode;
  summaryReplacement: "off";
  limits: ContextLimitsConfig;
  /** Archive root; per-session directories live below it. Absolute. */
  storeDir: string;
  /** OMP-only keys (T105 L4); accepted only with the OMP opt-in, absent under Pi. */
  omp?: OmpContextFileConfig;
}

/**
 * OMP-only `context` keys (T105 L4): C8 compaction, proactive compaction at agent_end, and the
 * fast-jev tunables of the legacy `OMP_JEV_*` variables. Every field is optional here; the OMP
 * adapter resolves env > this file > legacy file > default (`../omp/context-settings.ts`).
 */
export interface OmpContextFileConfig {
  /** True when the file itself set `context.request` (legacy files fill it only when false). */
  requestSet?: boolean;
  compaction?: ContextRequestMode;
  proactive?: { mode?: ContextRequestMode; softPercent?: number; hardPercent?: number; hardCompact?: boolean };
  fastJev?: {
    keepThreshold?: number;
    preserveRecent?: number;
    minReduction?: number;
    spill?: boolean;
    spillDir?: string;
    cacheCeiling?: number;
    model?: string;
  };
}

export interface AdapterConfig {
  mode: AdapterMode;
  /** Tool router mode; only `tools: "on"` in a session in mode `on` changes the host. */
  router: { tools: RouterFeatureMode };
  /** Data allowed to leave the machine. Task intent (the prompt) is sent to Jev only when `taskIntent` is true. */
  outbound: { taskIntent: boolean };
  /** `chain` (from `jev.providers`/`jev.capabilities`) is optional; absent means the single-url chain. */
  jev: { url: string; timeoutMs: number; chain?: JevChainConfig };
  /** Per task: physical Jev requests and total wait before the shadow decision is recorded as unavailable. */
  budget: {
    maxRequestsPerTask: number;
    waitMs: number;
    /** OMP only (T105 L4): Jev requests per C8 compaction, separate from the task budget. Absent = uncapped (legacy). */
    compactRequests?: number;
    /** OMP only: total wait of one C8 compaction in ms. Absent = the OMP default. */
    compactWaitMs?: number;
  };
  tools: ToolRoutingConfig;
  telemetryDir: string;
  /** Action envelopes, review, completion, continuation and run products; active in shadow and on. */
  harness: HarnessConfig;
  /** Request-level context reduction and the separate summary-replacement switch. */
  context: ContextConfig;
  /** Human approval of risky tool calls (OMP only, T105 C3); Pi refuses the key. */
  approval: ApprovalConfig;
  /**
   * OMP effort suggestion (T105 C12): off (no request) | shadow (default, record only) | on
   * (setThinkingLevel before the turn). Capped by the session mode: session off → effort off;
   * session shadow → effort at most shadow; only session on lets `on` act. Pi ignores it.
   */
  effort: RouterFeatureMode;
}

/**
 * Human approval (T105 C3, legacy `jev-autorun` parity). Off by default. `denyTools` always ask the
 * human; `allowTools` never do; any other tool asks when Jev judges it irreversible with
 * probability ≥ `riskThreshold` (or Jev gives no answer). Without a UI (print/RPC), `noUi` decides.
 * `silentSteer` is the separate switch for the "5 silent tool calls" steer reminder.
 */
export interface ApprovalConfig {
  enabled: boolean;
  noUi: "deny" | "allow";
  allowTools: string[];
  denyTools: string[];
  riskThreshold: number;
  silentSteer: boolean;
  /** Human answer wait; capped at 25 s (below OMP's 30 s tool_call timeout). A timeout applies `noUi`. */
  confirmTimeoutMs: number;
}

export const DEFAULT_APPROVAL: Readonly<ApprovalConfig> = Object.freeze({
  enabled: false,
  noUi: "deny",
  allowTools: ["read", "grep", "glob"],
  denyTools: ["bash", "write", "edit", "eval", "task", "hub"],
  riskThreshold: 0.2,
  silentSteer: false,
  confirmTimeoutMs: 25_000,
});

export type ConfigSource = "default" | "file" | "invalid";

export interface LoadedConfig {
  config: AdapterConfig;
  source: ConfigSource;
  path: string;
  /** Why the file was rejected; present only when `source` is "invalid". */
  reason?: string;
  /** Non-fatal notes about a valid file (today only `MODEL_ROUTING_IGNORED_NOTE`); present only when non-empty. */
  notes?: string[];
  /** Present (true) only when a valid file sets `harness.continuation.enabled` explicitly (OMP legacy precedence). */
  explicitContinuationEnabled?: true;
}

export interface ConfigLocation {
  /** Injected home directory; defaults to `os.homedir()`. */
  home?: string;
  /** Injected config path; defaults to `<home>/.pi/agent/pi-jev-harness/config.json`. */
  path?: string;
  /** Injected telemetry directory; overrides the file value and the default. */
  telemetryDir?: string;
  /** Injected run-products directory; overrides `PI_JEV_RUNS_DIR`, the file value and the default. */
  runsDir?: string;
  /** Injected run id; overrides `PI_JEV_RUN_ID`. */
  runId?: string;
  /**
   * Host harness directory for the defaults of `telemetryDir`, `harness.runsDir` and
   * `context.storeDir` (and of `path`). Default `<home>/.pi/agent/pi-jev-harness`; the OMP adapter
   * passes `<home>/.omp/agent/pi-jev-harness`.
   */
  baseDir?: string;
}

export function harnessDir(home: string): string {
  return join(home, ".pi", "agent", "pi-jev-harness");
}

export function defaultConfig(home: string, env: Readonly<Record<string, string | undefined>> = {}, baseDir: string = harnessDir(home)): AdapterConfig {
  return {
    mode: "off",
    router: { tools: "shadow" },
    outbound: { taskIntent: false },
    jev: { url: jevUrl(env) ?? TYPESAFE_PROFILE.url, timeoutMs: 15_000 },
    budget: { maxRequestsPerTask: 2, waitMs: 20_000 },
    tools: {
      topK: 4,
      confidenceFloor: 0.3,
      probabilityFloor: 0.05,
      relevanceWindow: 0.2,
      maxCostUnits: 10,
      maxBundleTools: 16,
      maxBundleSchemaBytes: 65_536,
    },
    telemetryDir: join(baseDir, "telemetry"),
    harness: { enforce: [], continuation: { enabled: false, max: DEFAULT_MAX_CONTINUATIONS }, runsDir: join(baseDir, "runs") },
    context: { request: "off", summaryReplacement: "off", limits: {}, storeDir: join(baseDir, "context") },
    approval: { ...DEFAULT_APPROVAL, allowTools: [...DEFAULT_APPROVAL.allowTools], denyTools: [...DEFAULT_APPROVAL.denyTools] },
    effort: "shadow",
  };
}

/** Jev API key; only from `TYPESAFE_API_KEY`. Never stored in config, telemetry or status. */
export function readJevKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const key = env.TYPESAFE_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * True when `text` contains a credential shape or any current Jev key. Never returns the match.
 * With a provider chain pass `[readJevKey(env), ...chainSecrets(resolved)]` so every chain key is scanned.
 */
export function containsCredential(text: string, jevKeys: string | readonly (string | undefined)[] | undefined): boolean {
  const keys = typeof jevKeys === "string" ? [jevKeys] : (jevKeys ?? []);
  if (keys.some((key) => key && text.includes(key))) return true;
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** `PI_JEV_URL` override (tests point it at a local fake service). */
function jevUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env.PI_JEV_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type Data = Record<string, unknown>;
const isObject = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);

class ConfigError extends Error {}

function object(value: unknown, where: string, keys: readonly string[]): Data {
  if (!isObject(value)) throw new ConfigError(`${where} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new ConfigError(`${where} has unknown field ${unknown[0]}`);
  return value;
}

function bool(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be a boolean`);
  return value;
}

function number(value: unknown, where: string, fallback: number, check: (n: number) => boolean): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !check(value)) throw new ConfigError(`${where} is out of range`);
  return value;
}

/**
 * Router feature mode. Legacy booleans from earlier configs are still accepted:
 * `true` means `"shadow"` and `false` means `"off"` (they never meant "apply").
 */
function featureMode(value: unknown, where: string, fallback: RouterFeatureMode): RouterFeatureMode {
  if (value === undefined) return fallback;
  if (value === true) return "shadow";
  if (value === false) return "off";
  if (typeof value !== "string" || !(ROUTER_FEATURE_MODES as readonly string[]).includes(value)) throw new ConfigError(`${where} must be off, shadow or on`);
  return value as RouterFeatureMode;
}

const positiveInt = (n: number) => Number.isInteger(n) && n >= 1;
const unit = (n: number) => n >= 0 && n <= 1;

function parseHarness(value: unknown, base: HarnessConfig): HarnessConfig {
  const harness = object(value ?? {}, "harness", ["enforce", "runsDir", "continuation"]);
  const enforce = harness.enforce ?? [];
  if (!Array.isArray(enforce) || enforce.some((kind) => typeof kind !== "string")) throw new ConfigError("harness.enforce must be a list of action kinds");
  if (enforce.includes("edit"))
    throw new ConfigError("harness.enforce must not include edit: Pi's edit fuzzy-matches text the harness check rejects");
  const unknown = enforce.find((kind) => !(ENFORCEABLE_KINDS as readonly string[]).includes(kind));
  if (unknown !== undefined) throw new ConfigError(`harness.enforce has unsupported kind ${unknown}; allowed: ${ENFORCEABLE_KINDS.join(", ")}`);
  if (harness.runsDir !== undefined && (typeof harness.runsDir !== "string" || !isAbsolute(harness.runsDir)))
    throw new ConfigError("harness.runsDir must be an absolute path");
  const continuation = object(harness.continuation ?? {}, "harness.continuation", ["enabled", "max"]);
  return {
    enforce: [...new Set(enforce as EnforceableKind[])],
    continuation: {
      enabled: bool(continuation.enabled, "harness.continuation.enabled", base.continuation.enabled),
      max: number(continuation.max, "harness.continuation.max", base.continuation.max, (n) => Number.isInteger(n) && n >= 0 && n <= DEFAULT_MAX_CONTINUATIONS),
    },
    runsDir: (harness.runsDir as string | undefined) ?? base.runsDir,
  };
}

const featureModes = ["off", "shadow", "on"] as const;

function contextMode(value: unknown, where: string): ContextRequestMode | undefined {
  if (value === undefined) return undefined;
  if (!(featureModes as readonly unknown[]).includes(value)) throw new ConfigError(`${where} must be off, shadow or on`);
  return value as ContextRequestMode;
}

/** OMP-only context keys; each field stays absent unless the file sets it. */
function parseOmpContext(context: Data): OmpContextFileConfig {
  const out: OmpContextFileConfig = { requestSet: context.request !== undefined };
  const compaction = contextMode(context.compaction, "context.compaction");
  if (compaction) out.compaction = compaction;
  const opt = (data: Data, key: string, where: string, check: (n: number) => boolean): Record<string, number> =>
    data[key] === undefined ? {} : { [key]: number(data[key], `${where}.${key}`, 0, check) };
  if (context.proactive !== undefined) {
    const p = object(context.proactive, "context.proactive", ["mode", "softPercent", "hardPercent", "hardCompact"]);
    const mode = contextMode(p.mode, "context.proactive.mode");
    const percent = (n: number) => n > 0 && n <= 100;
    out.proactive = {
      ...(mode ? { mode } : {}),
      ...opt(p, "softPercent", "context.proactive", percent),
      ...opt(p, "hardPercent", "context.proactive", percent),
      ...(p.hardCompact !== undefined ? { hardCompact: bool(p.hardCompact, "context.proactive.hardCompact", true) } : {}),
    };
    const soft = out.proactive.softPercent ?? 70, hard = out.proactive.hardPercent ?? 90;
    if (!(soft < hard)) throw new ConfigError("context.proactive.softPercent must be below hardPercent");
  }
  if (context.fastJev !== undefined) {
    const f = object(context.fastJev, "context.fastJev", ["keepThreshold", "preserveRecent", "minReduction", "spill", "spillDir", "cacheCeiling", "model"]);
    if (f.spillDir !== undefined && (typeof f.spillDir !== "string" || !isAbsolute(f.spillDir))) throw new ConfigError("context.fastJev.spillDir must be an absolute path");
    if (f.model !== undefined && (typeof f.model !== "string" || f.model.length === 0)) throw new ConfigError("context.fastJev.model must be a non-empty string");
    out.fastJev = {
      ...opt(f, "keepThreshold", "context.fastJev", unit),
      ...opt(f, "preserveRecent", "context.fastJev", (n) => Number.isInteger(n) && n >= 0),
      ...opt(f, "minReduction", "context.fastJev", unit),
      ...opt(f, "cacheCeiling", "context.fastJev", unit),
      ...(f.spill !== undefined ? { spill: bool(f.spill, "context.fastJev.spill", true) } : {}),
      ...(f.spillDir !== undefined ? { spillDir: f.spillDir as string } : {}),
      ...(f.model !== undefined ? { model: f.model as string } : {}),
    };
  }
  return out;
}

function parseContext(value: unknown, base: ContextConfig, omp = false): ContextConfig {
  const context = object(value ?? {}, "context", ["request", "summaryReplacement", "limits", "storeDir", ...(omp ? ["compaction", "proactive", "fastJev"] : [])]);
  let request = base.request;
  if (context.request !== undefined) {
    if (context.request !== "off" && context.request !== "shadow" && context.request !== "on")
      throw new ConfigError("context.request must be off, shadow or on");
    request = context.request;
  }
  if (context.summaryReplacement !== undefined && context.summaryReplacement !== "off")
    throw new ConfigError("context.summaryReplacement must be off: persistent summary replacement has not passed its preservation gate");
  if (context.storeDir !== undefined && (typeof context.storeDir !== "string" || !isAbsolute(context.storeDir)))
    throw new ConfigError("context.storeDir must be an absolute path");
  const limits = object(context.limits ?? {}, "context.limits", ["maxPayloadBytes", "maxSessionBytes", "recentTurns", "minChars"]);
  const optional = (key: string, check: (n: number) => boolean): Record<string, number> => {
    const n = limits[key];
    return n === undefined ? {} : { [key]: number(n, `context.limits.${key}`, 0, check) };
  };
  return {
    request,
    summaryReplacement: "off",
    limits: {
      ...optional("maxPayloadBytes", positiveInt),
      ...optional("maxSessionBytes", positiveInt),
      ...optional("recentTurns", (n) => Number.isInteger(n) && n >= 0),
      ...optional("minChars", (n) => Number.isInteger(n) && n >= 0),
    },
    storeDir: (context.storeDir as string | undefined) ?? base.storeDir,
    ...(omp ? { omp: parseOmpContext(context) } : {}),
  };
}

function toolList(value: unknown, where: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && name.length > 0)) throw new ConfigError(`${where} must be a list of tool names`);
  return [...new Set(value as string[])];
}

function parseApproval(value: unknown, base: ApprovalConfig): ApprovalConfig {
  const approval = object(value ?? {}, "approval", ["enabled", "noUi", "allowTools", "denyTools", "riskThreshold", "silentSteer", "confirmTimeoutMs"]);
  if (approval.noUi !== undefined && approval.noUi !== "deny" && approval.noUi !== "allow") throw new ConfigError("approval.noUi must be deny or allow");
  return {
    enabled: bool(approval.enabled, "approval.enabled", base.enabled),
    noUi: (approval.noUi as ApprovalConfig["noUi"] | undefined) ?? base.noUi,
    allowTools: toolList(approval.allowTools, "approval.allowTools", base.allowTools),
    denyTools: toolList(approval.denyTools, "approval.denyTools", base.denyTools),
    riskThreshold: number(approval.riskThreshold, "approval.riskThreshold", base.riskThreshold, unit),
    silentSteer: bool(approval.silentSteer, "approval.silentSteer", base.silentSteer),
    confirmTimeoutMs: number(approval.confirmTimeoutMs, "approval.confirmTimeoutMs", base.confirmTimeoutMs, positiveInt),
  };
}

function parseConfig(raw: unknown, base: AdapterConfig, allowModeOn: boolean, allowApproval: boolean): AdapterConfig {
  const top = object(raw, "config", ["mode", "router", "outbound", "jev", "budget", "tools", "telemetryDir", "harness", "context", "effort", ...(allowApproval ? ["approval"] : [])]);
  let mode: AdapterMode = base.mode;
  if (top.mode !== undefined) {
    if (top.mode === "on" && !allowModeOn) throw new ConfigError("mode on has not passed its enablement gate");
    if (top.mode !== "off" && top.mode !== "shadow" && top.mode !== "on") throw new ConfigError("mode must be off or shadow");
    mode = top.mode;
  }
  const router = object(top.router ?? {}, "router", ["tools", "models"]);
  const outbound = object(top.outbound ?? {}, "outbound", ["taskIntent"]);
  const jev = object(top.jev ?? {}, "jev", ["url", "timeoutMs", "providers", "capabilities"]);
  const budget = object(top.budget ?? {}, "budget", ["maxRequestsPerTask", "waitMs", ...(allowModeOn ? ["compactRequests", "compactWaitMs"] : [])]);
  const tools = object(top.tools ?? {}, "tools", Object.keys(base.tools));
  let url = base.jev.url;
  if (jev.url !== undefined) {
    if (typeof jev.url !== "string" || !/^https?:\/\//.test(jev.url)) throw new ConfigError("jev.url must be an http(s) URL");
    url = jev.url;
  }
  if (top.telemetryDir !== undefined && (typeof top.telemetryDir !== "string" || top.telemetryDir.length === 0))
    throw new ConfigError("telemetryDir must be a non-empty string");
  const t = base.tools;
  return {
    mode,
    router: {
      tools: featureMode(router.tools, "router.tools", base.router.tools),
    },
    outbound: { taskIntent: bool(outbound.taskIntent, "outbound.taskIntent", base.outbound.taskIntent) },
    jev: { url, timeoutMs: number(jev.timeoutMs, "jev.timeoutMs", base.jev.timeoutMs, positiveInt), ...jevChain(jev) },
    budget: {
      maxRequestsPerTask: number(budget.maxRequestsPerTask, "budget.maxRequestsPerTask", base.budget.maxRequestsPerTask, (n) => Number.isInteger(n) && n >= 0),
      waitMs: number(budget.waitMs, "budget.waitMs", base.budget.waitMs, positiveInt),
      ...(budget.compactRequests !== undefined ? { compactRequests: number(budget.compactRequests, "budget.compactRequests", 0, (n) => Number.isInteger(n) && n >= 0) } : {}),
      ...(budget.compactWaitMs !== undefined ? { compactWaitMs: number(budget.compactWaitMs, "budget.compactWaitMs", 0, positiveInt) } : {}),
    },
    tools: {
      topK: number(tools.topK, "tools.topK", t.topK, (n) => positiveInt(n) && n <= 254),
      confidenceFloor: number(tools.confidenceFloor, "tools.confidenceFloor", t.confidenceFloor, unit),
      probabilityFloor: number(tools.probabilityFloor, "tools.probabilityFloor", t.probabilityFloor, unit),
      relevanceWindow: number(tools.relevanceWindow, "tools.relevanceWindow", t.relevanceWindow, unit),
      maxCostUnits: number(tools.maxCostUnits, "tools.maxCostUnits", t.maxCostUnits, (n) => n >= 0),
      maxBundleTools: number(tools.maxBundleTools, "tools.maxBundleTools", t.maxBundleTools, positiveInt),
      maxBundleSchemaBytes: number(tools.maxBundleSchemaBytes, "tools.maxBundleSchemaBytes", t.maxBundleSchemaBytes, positiveInt),
    },
    telemetryDir: (top.telemetryDir as string | undefined) ?? base.telemetryDir,
    harness: parseHarness(top.harness, base.harness),
    // The OMP opt-in (`allowModeOn`) also admits the OMP-only context keys.
    context: parseContext(top.context, base.context, allowModeOn),
    approval: parseApproval(top.approval, base.approval),
    effort: featureMode(top.effort, "effort", base.effort),
  };
}

/** `PI_JEV_RUNS_DIR` / `PI_JEV_RUN_ID` overrides; `error` names the first invalid value. */
function runOverrides(env: Readonly<Record<string, string | undefined>>): { runsDir?: string; runId?: string; error?: string } {
  const out: { runsDir?: string; runId?: string; error?: string } = {};
  const dir = env.PI_JEV_RUNS_DIR;
  if (dir !== undefined && dir !== "") {
    if (isAbsolute(dir)) out.runsDir = dir;
    else out.error = "PI_JEV_RUNS_DIR must be an absolute path";
  }
  const id = env.PI_JEV_RUN_ID;
  if (id !== undefined && id !== "") {
    if (RUN_ID_PATTERN.test(id)) out.runId = id;
    else out.error ??= "PI_JEV_RUN_ID must be one path segment of letters, digits, '.', '_' or '-' (max 128)";
  }
  return out;
}

export interface LoadConfigOptions extends ConfigLocation {
  env?: Readonly<Record<string, string | undefined>>;
  readText?: (path: string) => Promise<string>;
  /**
   * Host opt-in: accept `mode: "on"` in the file. Only the OMP adapter sets it; Pi keeps refusing
   * it (Pi's `on` is per session only, `/jev mode on`).
   */
  allowModeOn?: boolean;
  /** Host opt-in: accept the `approval` section (OMP only, T105 C3); Pi keeps refusing it. */
  allowApproval?: boolean;
}

/**
 * Missing file → defaults (off). Unreadable, unparsable or invalid file → off with a reason;
 * the file is left untouched. `PI_JEV_URL` overrides the Jev URL in every case; `PI_JEV_RUNS_DIR`
 * and `PI_JEV_RUN_ID` override the run directory (see `HarnessConfig`), and an invalid one makes
 * the config invalid.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? {};
  const home = options.home ?? homedir();
  const baseDir = options.baseDir ?? harnessDir(home);
  const path = options.path ?? join(baseDir, "config.json");
  const base = defaultConfig(home, env, baseDir);
  const run = runOverrides(env);
  const finish = (parsed: AdapterConfig, parsedSource: ConfigSource, parsedReason?: string, notes: string[] = []): LoadedConfig => {
    const invalidEnv = parsedSource !== "invalid" && run.error !== undefined;
    const config = invalidEnv ? base : parsed;
    const source: ConfigSource = invalidEnv ? "invalid" : parsedSource;
    const reason = invalidEnv ? run.error : parsedReason;
    const url = jevUrl(env);
    const runId = options.runId ?? run.runId;
    const resolved = {
      ...config,
      jev: { ...config.jev, url: url ?? config.jev.url },
      telemetryDir: options.telemetryDir ?? config.telemetryDir,
      harness: {
        ...config.harness,
        runsDir: options.runsDir ?? run.runsDir ?? config.harness.runsDir,
        ...(runId === undefined ? {} : { runId }),
      },
    };
    const loaded: LoadedConfig = reason === undefined ? { config: resolved, source, path } : { config: resolved, source, path, reason };
    return source === "file" && notes.length > 0 ? { ...loaded, notes } : loaded;
  };
  const read = options.readText ?? ((p: string) => readFile(p, "utf8"));
  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return finish(base, "default");
    return finish(base, "invalid", "config file unreadable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return finish(base, "invalid", "config file is not valid JSON");
  }
  try {
    const router = isObject(raw) && isObject(raw.router) ? raw.router : undefined;
    const loaded = finish(parseConfig(raw, base, options.allowModeOn === true, options.allowApproval === true), "file", undefined, router?.models !== undefined ? [MODEL_ROUTING_IGNORED_NOTE] : []);
    const continuation = isObject(raw) && isObject(raw.harness) && isObject(raw.harness.continuation) ? raw.harness.continuation : undefined;
    return loaded.source === "file" && typeof continuation?.enabled === "boolean" ? { ...loaded, explicitContinuationEnabled: true } : loaded;
  } catch (error) {
    return finish(base, "invalid", error instanceof ConfigError ? error.message : "config file is invalid");
  }
}

/** Optional ordered provider chain; `capabilities` requires `providers`. */
function jevChain(jev: Record<string, unknown>): { chain?: JevChainConfig } {
  if (jev.providers === undefined) {
    if (jev.capabilities !== undefined) throw new ConfigError("jev.capabilities requires jev.providers");
    return {};
  }
  const parsed = parseJevChainConfig(jev.providers, jev.capabilities);
  if (!parsed.ok) throw new ConfigError(parsed.reason);
  return { chain: parsed.value };
}
