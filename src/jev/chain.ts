/**
 * Ordered Jev provider chain with fallback.
 *
 * A chain is a list of providers tried in order. The next provider is tried only on transport
 * failure, timeout, HTTP 5xx/429 or a model-identity failure; a well-formed answer (including a
 * decline) and every other error end the chain. One total wait budget covers the whole chain:
 * each provider's deadline is clipped to what is left. Chain telemetry carries provider id,
 * outcome and duration only, never keys or request text.
 *
 * The outbound gate and credential scan belong to the caller and run before `choice`/`noul`.
 * The scan must cover every chain key: callers pass `[readJevKey(env), ...chainSecrets(resolved)]`
 * to `containsCredential` (src/adapters/shared/config.ts) instead of the TypeSafe key alone.
 *
 * Budget: one `choice`/`noul` call on a chain client is one gated Jev decision and counts as ONE
 * unit against `budget.maxRequestsPerTask`, however many providers it tries. Callers must count
 * chain calls, not `onAttempt` events. Physical requests per call are bounded by the chain length
 * and all of them by `waitMs`.
 */
import { createJevClient, type JevClient, type JevCallOptions, type JevDebugEvent } from "./client.ts";
import {
  TYPESAFE_PROFILE,
  type IdentityPolicy,
  type JevAttempt,
  type JevError,
  type JevErrorKind,
  type JevProfile,
  type JevResult,
} from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * One provider. The key comes from `keyEnv`, `keyFile` (a file holding only the key) or, for the
 * legacy `jev-providers.json` only, an inline `apiKey`. Never log or project a spec: it may carry a key.
 */
export interface JevProviderSpec {
  id: string;
  url: string;
  model: string;
  identity: IdentityPolicy;
  timeoutMs: number;
  keyEnv?: string;
  keyFile?: string;
  /** Inline key from the legacy file; plaintext at rest. Secret: never log, status or send it. */
  apiKey?: string;
}

/** Default chain plus optional per-capability chains (e.g. route, acceptance, assess, compact, plan). */
export interface JevChainConfig {
  providers: JevProviderSpec[];
  capabilities?: Record<string, JevProviderSpec[]>;
}

export type JevChainSource = { kind: "single-url" } | { kind: "config" } | { kind: "legacy"; path: string };

export const IDENTITY_POLICIES: readonly IdentityPolicy[] = ["exact", "prefix", "none"];

/** Capabilities that may carry their own chain. */
export const JEV_CAPABILITIES = ["route", "acceptance", "assess", "compact", "plan", "continuation", "toolContext", "effort"] as const;
export type JevCapability = (typeof JEV_CAPABILITIES)[number];
export const isJevCapability = (name: string): name is JevCapability => (JEV_CAPABILITIES as readonly string[]).includes(name);

/** The pre-chain behaviour: one TypeSafe provider, `TYPESAFE_API_KEY`, exact model identity. */
export function singleUrlChain(url: string, timeoutMs: number): JevChainConfig {
  return {
    providers: [
      { id: TYPESAFE_PROFILE.id, url, model: TYPESAFE_PROFILE.model, identity: "exact", timeoutMs, keyEnv: "TYPESAFE_API_KEY" },
    ],
  };
}

/** The capability's chain when configured, otherwise the default chain. */
export function chainFor(config: JevChainConfig, capability?: string): JevProviderSpec[] {
  return (capability !== undefined && config.capabilities?.[capability]) || config.providers;
}

export interface ResolvedJevProvider {
  spec: JevProviderSpec;
  /** Absent for keyless providers and for providers whose declared key source is empty. */
  key?: string;
  /** True when a key source is declared but yields nothing; such providers are skipped. */
  missingKey: boolean;
}

/** Reads each provider's key from its declared source. `readFile` is injected; failures mean missing. */
export function resolveChain(
  providers: readonly JevProviderSpec[],
  io: { env: Env; readFile?: (path: string) => string },
): ResolvedJevProvider[] {
  return providers.map((spec) => {
    let key: string | undefined;
    if (spec.apiKey !== undefined) key = spec.apiKey.trim() || undefined;
    else if (spec.keyEnv !== undefined) key = io.env[spec.keyEnv]?.trim() || undefined;
    else if (spec.keyFile !== undefined && io.readFile) {
      try {
        key = io.readFile(spec.keyFile).trim() || undefined;
      } catch {
        key = undefined;
      }
    }
    const declared = spec.apiKey !== undefined || spec.keyEnv !== undefined || spec.keyFile !== undefined;
    return { spec, ...(key === undefined ? {} : { key }), missingKey: declared && key === undefined };
  });
}

/** Every resolved key in the chain, for the outbound credential scan. Never log the result. */
export function chainSecrets(resolved: readonly ResolvedJevProvider[]): string[] {
  return [...new Set(resolved.flatMap((p) => (p.key === undefined ? [] : [p.key])))];
}

export type JevChainOutcome = "ok" | JevErrorKind | "no_key" | "budget_exhausted";

/** One chain step. Content-free: no key, url, question or state text. */
export interface JevChainAttempt {
  decisionId: string;
  providerId: string;
  outcome: JevChainOutcome;
  httpStatus?: number;
  durationMs: number;
  /** True when this step's failure moved the chain on to the next provider. */
  fellBack: boolean;
  /** One chain call; steps of the same call share it, concurrent calls never do (even under one decisionId). */
  sequence: number;
  /** Providers in this chain. */
  chainLength: number;
  /** Set when the provider's identity policy is `none` and the reported model differs from the pinned one. */
  identityWarning?: true;
}

/** Errors that move the chain to the next provider. */
export function isFallbackError(error: JevError): boolean {
  if (error.kind === "network_error" || error.kind === "timeout") return true;
  if (error.kind === "http_error") return error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500;
  return error.kind === "malformed" && (error.wire?.kind === "model_mismatch" || error.wire?.kind === "model_missing");
}

export interface JevChainClientOptions {
  providers: readonly ResolvedJevProvider[];
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  /** Total wait across the whole chain (`budget.waitMs`). */
  waitMs: number;
  limits?: { maxRequestBytes: number; maxResponseBytes: number };
  /** Per physical request, as in `createJevClient`. */
  onAttempt?: (attempt: JevAttempt, providerId: string) => void;
  /** Physical request/response events from each provider; failures cannot affect calls. */
  onDebug?: (event: JevDebugEvent) => void;
  debugEnabled?: () => boolean;
  /** Per chain step, including skipped providers. Throwing cannot change the call result. */
  onChainAttempt?: (attempt: JevChainAttempt) => void;
}

let nextSequence = 0;

type Call<E> = (client: JevClient) => Promise<JevResult<E>>;

export function createJevChainClient(options: JevChainClientOptions): JevClient {
  const { now, waitMs, onChainAttempt } = options;
  const limits = options.limits ?? TYPESAFE_PROFILE;
  const record = (attempt: JevChainAttempt) => {
    try {
      onChainAttempt?.(attempt);
    } catch {
      // Telemetry cannot change the call result.
    }
  };

  async function run<E extends { model: string }[]>(call: Call<E>, decisionId: string): Promise<JevResult<E>> {
    const deadline = now() + waitMs;
    const sequence = ++nextSequence;
    const chainLength = options.providers.length;
    let last: JevResult<E> | undefined;
    for (const [index, provider] of options.providers.entries()) {
      const { spec } = provider;
      const hasNext = index < options.providers.length - 1;
      if (provider.missingKey) {
        record({ decisionId, sequence, chainLength, providerId: spec.id, outcome: "no_key", durationMs: 0, fellBack: hasNext });
        continue;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        record({ decisionId, sequence, chainLength, providerId: spec.id, outcome: "budget_exhausted", durationMs: 0, fellBack: false });
        return last ?? { ok: false, error: { kind: "timeout" } };
      }
      const profile: JevProfile = {
        id: spec.id,
        url: spec.url,
        model: spec.model,
        identity: spec.identity,
        timeoutMs: Math.min(spec.timeoutMs, remaining),
        maxRequestBytes: limits.maxRequestBytes,
        maxResponseBytes: limits.maxResponseBytes,
      };
      const client = createJevClient({
        profile,
        key: provider.key,
        fetch: options.fetch,
        now,
        newId: options.newId,
        onAttempt: (attempt) => options.onAttempt?.(attempt, spec.id),
        ...(options.onDebug ? { onDebug: options.onDebug } : {}),
        ...(options.debugEnabled ? { debugEnabled: options.debugEnabled } : {}),
      });
      const started = now();
      const result = await call(client);
      const durationMs = now() - started;
      const httpStatus = result.ok ? undefined : result.error.httpStatus;
      const fellBack = !result.ok && isFallbackError(result.error) && hasNext;
      const identityWarning =
        result.ok && spec.identity !== "exact" && result.evidence.some((e) => e.model !== spec.model) ? true : undefined;
      record({
        decisionId,
        sequence,
        chainLength,
        providerId: spec.id,
        outcome: result.ok ? "ok" : result.error.kind,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs,
        fellBack,
        ...(identityWarning ? { identityWarning } : {}),
      });
      last = result;
      if (!fellBack) return result;
    }
    // Every provider skipped for a missing key: nothing was sent.
    return last ?? { ok: false, error: { kind: "no_provider_available" } };
  }

  return {
    choice(questions, call: JevCallOptions) {
      return run((client) => client.choice(questions, call), call.decisionId);
    },
    noul(questions, call: JevCallOptions) {
      return run((client) => client.noul(questions, call), call.decisionId);
    },
  };
}

class ChainConfigError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parseProvider(raw: unknown, where: string): JevProviderSpec {
  if (!isRecord(raw)) throw new ChainConfigError(`${where} must be an object`);
  const allowed = ["id", "url", "model", "identity", "timeoutMs", "keyEnv", "keyFile"];
  const extra = Object.keys(raw).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ChainConfigError(`${where}.${extra} is not a known field (inline keys are not allowed)`);
  if (!nonEmpty(raw.id)) throw new ChainConfigError(`${where}.id must be a non-empty string`);
  if (!nonEmpty(raw.url) || !/^https?:\/\//.test(raw.url)) throw new ChainConfigError(`${where}.url must be an http(s) URL`);
  if (!nonEmpty(raw.model)) throw new ChainConfigError(`${where}.model must be a non-empty string`);
  const identity = raw.identity ?? "exact";
  if (!IDENTITY_POLICIES.includes(identity as IdentityPolicy))
    throw new ChainConfigError(`${where}.identity must be exact, prefix or none`);
  if (!(typeof raw.timeoutMs === "number" && Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0))
    throw new ChainConfigError(`${where}.timeoutMs must be a positive integer`);
  if (raw.keyEnv !== undefined && !nonEmpty(raw.keyEnv)) throw new ChainConfigError(`${where}.keyEnv must be a non-empty string`);
  if (raw.keyFile !== undefined && !nonEmpty(raw.keyFile)) throw new ChainConfigError(`${where}.keyFile must be a non-empty string`);
  if (raw.keyEnv !== undefined && raw.keyFile !== undefined) throw new ChainConfigError(`${where} must set at most one of keyEnv, keyFile`);
  return {
    id: raw.id,
    url: raw.url,
    model: raw.model,
    identity: identity as IdentityPolicy,
    timeoutMs: raw.timeoutMs,
    ...(raw.keyEnv === undefined ? {} : { keyEnv: raw.keyEnv as string }),
    ...(raw.keyFile === undefined ? {} : { keyFile: raw.keyFile as string }),
  };
}

function parseList(raw: unknown, where: string): JevProviderSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ChainConfigError(`${where} must be a non-empty array`);
  const list = raw.map((entry, i) => parseProvider(entry, `${where}[${i}]`));
  if (new Set(list.map((p) => p.id)).size !== list.length) throw new ChainConfigError(`${where} has duplicate provider ids`);
  return list;
}

/**
 * Parses `jev.providers` / `jev.capabilities` from the adapter config. Returns an error message
 * instead of throwing so the shared config parser stays in charge of its error type.
 */
export function parseJevChainConfig(
  providers: unknown,
  capabilities: unknown,
): { ok: true; value: JevChainConfig } | { ok: false; reason: string } {
  try {
    const value: JevChainConfig = { providers: parseList(providers, "jev.providers") };
    if (capabilities !== undefined) {
      if (!isRecord(capabilities)) throw new ChainConfigError("jev.capabilities must be an object");
      const unknown = Object.keys(capabilities).find((name) => !isJevCapability(name));
      if (unknown !== undefined)
        throw new ChainConfigError(`jev.capabilities.${unknown} is not a known capability (${JEV_CAPABILITIES.join(", ")})`);
      value.capabilities = Object.fromEntries(
        Object.entries(capabilities).map(([name, list]) => [name, parseList(list, `jev.capabilities.${name}`)]),
      );
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ChainConfigError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Legacy capability names in `jev-providers.json` mapped to chain capability names. */
export const LEGACY_CAPABILITY_NAMES: Readonly<Record<string, JevCapability>> = {
  planning: "plan",
  assessment: "assess",
  acceptance: "acceptance",
  continuation: "continuation",
  compaction: "compact",
  toolContext: "toolContext",
};

const LEGACY_DEFAULT_TIMEOUT_MS = 15_000;
const LEGACY_PROVIDER_FIELDS = ["url", "model", "apiKey", "api-key", "apiKeyEnv", "timeoutMs"];
/** Inline-key field names; `api-key` is an alias of `apiKey`. */
const LEGACY_INLINE_KEY_FIELDS = ["apiKey", "api-key"];
/** Content-free warning for an inline key in a file readable beyond its owner. */
export const LEGACY_INLINE_KEY_MODE_WARNING = "legacy file holds an inline apiKey but its mode is looser than 0600; run chmod 600 on it";
/** Old `providers.ts` pinned `jev-latest`; this harness pins the TypeSafe model version on purpose. */
export const LEGACY_TYPESAFE_PIN_WARNING = "typesafe model pinned to jev-1.13.0 (legacy default was jev-latest)";
/** Secret-looking values outside `apiKey`/`api-key`; a legacy file carrying one is rejected rather than mapped. */
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{8,}/, /\bBearer\s+\S+/i, /\b(?:ghp|gho|xox[bp])[-_][A-Za-z0-9]{8,}/];

function legacyBuiltins(env: Env): Record<string, JevProviderSpec> {
  return {
    typesafe: {
      id: "typesafe",
      // Same override as the old providers.ts: JEV_URL replaces only the built-in typesafe URL.
      url: env.JEV_URL?.trim() || TYPESAFE_PROFILE.url,
      // Deviation from the old `jev-latest`: pinned version, exact identity (product decision).
      model: TYPESAFE_PROFILE.model,
      identity: "exact",
      timeoutMs: LEGACY_DEFAULT_TIMEOUT_MS,
      keyEnv: "TYPESAFE_API_KEY",
    },
    openrouter: {
      id: "openrouter",
      url: "https://openrouter.ai/api/alpha/decisions",
      model: "typesafe/jev-1.13",
      identity: "none",
      timeoutMs: LEGACY_DEFAULT_TIMEOUT_MS,
      keyEnv: "OPENROUTER_API_KEY",
    },
  };
}

type LegacySource = JevChainSource & { kind: "legacy" };
export type LegacyProvidersResult =
  | { ok: true; source: LegacySource; config: JevChainConfig; warnings: string[]; defaulted?: true }
  /** `detail` is content-free (field names and provider ids only, never a value). */
  | { ok: false; source: LegacySource; reason: "unreadable" | "invalid"; detail?: string };

/**
 * Read-only mapping of the legacy `~/.omp/agent/jev-providers.json` (schemaVersion 1:
 * `default`, `fallback`, `providers{name: {url, model, apiKey? | api-key?, apiKeyEnv?, timeoutMs?}}`,
 * `capabilities{name: {default, fallback}}`) into a chain config, with the old semantics:
 * unknown provider fields, setting both `apiKey` and `api-key` or an inline key and `apiKeyEnv`, or secret-looking values in
 * any field other than the inline key reject the file. An inline `apiKey` is a plaintext secret at rest
 * (keep the file mode 0600); it is used only as the provider's bearer key and joins the outbound
 * credential scan via `chainSecrets`, never status, warnings or telemetry;
 * strings are trimmed; `JEV_URL` overrides the built-in typesafe URL; a missing file yields the
 * old default (typesafe, and typesafe -> openrouter for `compact`). Unknown capability names are
 * dropped with a warning. Built-in `typesafe` keeps the exact identity check; other providers use
 * `none` (warning on mismatch). When an inline key is present and `fileMode` reports group/other
 * permission bits, a content-free warning is added (nothing is chmod-ed). Path, reader, env and
 * mode reader are injected.
 */
export function readLegacyProviders(
  path: string,
  readFile: (path: string) => string,
  env: Env = {},
  fileMode?: (path: string) => number | undefined,
): LegacyProvidersResult {
  const source = { kind: "legacy" as const, path };
  const specs = legacyBuiltins(env);
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, source, reason: "unreadable" };
    const config = { providers: [specs.typesafe!], capabilities: { compact: [specs.typesafe!, specs.openrouter!] } };
    return { ok: true, source, config, warnings: [LEGACY_TYPESAFE_PIN_WARNING], defaulted: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, source, reason: "invalid" };
  }
  const warnings: string[] = [];
  const problem: { detail?: string } = {};
  const config = mapLegacy(raw, specs, warnings, problem);
  if (!config) return { ok: false, source, reason: "invalid", ...(problem.detail ? { detail: problem.detail } : {}) };
  const all = [config.providers, ...Object.values(config.capabilities ?? {})].flat();
  if (all.some((p) => p.id === "typesafe")) warnings.unshift(LEGACY_TYPESAFE_PIN_WARNING);
  if (Object.values(specs).some((p) => p.apiKey !== undefined)) {
    let mode: number | undefined;
    try {
      mode = fileMode?.(path);
    } catch {
      mode = undefined;
    }
    if (mode !== undefined && (mode & 0o077) !== 0) warnings.push(LEGACY_INLINE_KEY_MODE_WARNING);
  }
  return { ok: true, source, config, warnings };
}

const trimmed = (value: unknown): unknown => (typeof value === "string" ? value.trim() : value);
const looksSecret = (value: unknown): boolean => typeof value === "string" && SECRET_SHAPES.some((re) => re.test(value));

function mapLegacy(
  raw: unknown,
  specs: Record<string, JevProviderSpec>,
  warnings: string[],
  problem: { detail?: string },
): JevChainConfig | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return undefined;
  if (raw.providers !== undefined && !isRecord(raw.providers)) return undefined;
  for (const [rawId, value] of Object.entries(raw.providers ?? {})) {
    const id = rawId.trim();
    if (!id || !isRecord(value)) return undefined;
    if (Object.keys(value).some((key) => !LEGACY_PROVIDER_FIELDS.includes(key))) return undefined;
    if (Object.entries(value).some(([key, field]) => !LEGACY_INLINE_KEY_FIELDS.includes(key) && looksSecret(field))) return undefined;
    if ("apiKey" in value && "api-key" in value) {
      problem.detail = `provider ${id}: both apiKey and api-key set`;
      return undefined;
    }
    const base = specs[id];
    const url = trimmed(value.url) ?? base?.url;
    const model = trimmed(value.model) ?? base?.model;
    if (!nonEmpty(url) || !/^https?:\/\//.test(url) || !nonEmpty(model)) return undefined;
    const timeoutMs = value.timeoutMs ?? base?.timeoutMs ?? LEGACY_DEFAULT_TIMEOUT_MS;
    if (!(typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0)) return undefined;
    const apiKeyEnv = trimmed(value.apiKeyEnv);
    if (apiKeyEnv !== undefined && !nonEmpty(apiKeyEnv)) return undefined;
    const apiKey = trimmed("apiKey" in value ? value.apiKey : value["api-key"]);
    if (apiKey !== undefined && !nonEmpty(apiKey)) return undefined;
    if (apiKey !== undefined && apiKeyEnv !== undefined) {
      problem.detail = `provider ${id}: inline key and apiKeyEnv are mutually exclusive`;
      return undefined;
    }
    // An inline key replaces the built-in env source; otherwise keep the old env mapping.
    const keyEnv = apiKey === undefined ? ((apiKeyEnv as string | undefined) ?? base?.keyEnv) : undefined;
    specs[id] = {
      id, url, model, identity: base?.identity ?? "none", timeoutMs,
      ...(keyEnv === undefined ? {} : { keyEnv }),
      ...(apiKey === undefined ? {} : { apiKey: apiKey as string }),
    };
  }
  const chain = (value: unknown): JevProviderSpec[] | undefined => {
    if (!isRecord(value)) return undefined;
    const first = trimmed(value.default);
    const fallback = value.fallback ?? [];
    if (!nonEmpty(first) || !Array.isArray(fallback)) return undefined;
    const rest = fallback.map(trimmed);
    if (!rest.every(nonEmpty)) return undefined;
    const ids = [...new Set([first, ...(rest as string[])])];
    if (!ids.every((id) => specs[id])) return undefined;
    return ids.map((id) => specs[id]!);
  };
  const providers = chain({ default: raw.default, fallback: raw.fallback });
  if (!providers) return undefined;
  const config: JevChainConfig = { providers };
  if (raw.capabilities !== undefined) {
    if (!isRecord(raw.capabilities)) return undefined;
    const capabilities: Record<string, JevProviderSpec[]> = {};
    for (const [rawName, value] of Object.entries(raw.capabilities)) {
      const name = rawName.trim();
      if (name === "modelRouting") continue; // Model routing is not a Jev capability here.
      const mapped = LEGACY_CAPABILITY_NAMES[name] ?? (isJevCapability(name) ? name : undefined);
      if (!mapped) {
        warnings.push(`unknown legacy capability dropped: ${name}`);
        continue;
      }
      const list = chain(value);
      if (!list) return undefined;
      capabilities[mapped] = list;
    }
    config.capabilities = capabilities;
  }
  return config;
}

/** Content-free status line: provider ids in order and the config source. */
export function describeChain(config: JevChainConfig, source: JevChainSource): string {
  const where = source.kind === "legacy" ? `legacy:${source.path}` : source.kind;
  return `providers=${config.providers.map((p) => p.id).join(" -> ")} source=${where}`;
}
