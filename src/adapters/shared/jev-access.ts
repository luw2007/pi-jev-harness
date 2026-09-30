/**
 * T105 integration: one place that decides which Jev endpoint(s) a capability talks to.
 *
 * Source, in order:
 * 1. config `jev.providers` (+ `jev.capabilities`) → provider chain (`createJevChainClient`);
 * 2. OMP only (`legacyProvidersPath` given): the legacy `jev-providers.json`, read-only, when it
 *    exists and maps cleanly → provider chain; missing / unreadable / invalid → 3 (noted in status);
 * 3. the single-url client (`jev.url`, `TYPESAFE_API_KEY`), byte-for-byte the pre-chain behaviour.
 *
 * Pi passes no legacy path, so without `jev.providers` Pi keeps the single-url client.
 * Every capability picks its chain with `chainFor(capability)`. Credential scans use `secrets`
 * (`[readJevKey(env), ...chainSecrets(resolved)]`). A chain call is one budget unit: callers that
 * count requests pass `take`, which is consulted once per call, never per provider attempt.
 */
import { readFileSync, statSync } from "node:fs";
import {
  chainFor,
  chainSecrets,
  createJevChainClient,
  createJevClient,
  describeChain,
  readLegacyProviders,
  resolveChain,
  TYPESAFE_PROFILE,
  type JevAttempt,
  type JevDebugEvent,
  type JevCapability,
  type JevChainAttempt,
  type JevChainConfig,
  type JevChainSource,
  type JevClient,
  type JevResult,
} from "../../jev/index.ts";
import { readJevKey, type AdapterConfig } from "./config.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface JevAccessOptions {
  config: AdapterConfig;
  env: Env;
  /** OMP only: legacy `jev-providers.json`; absent (Pi) means no legacy mapping. */
  legacyProvidersPath?: string;
  /** Reads key files and the legacy file; default `readFileSync(path, "utf8")`. */
  readFile?: (path: string) => string;
  /** Permission bits of the legacy file (inline-key mode warning); default `statSync(path).mode`. */
  fileMode?: (path: string) => number | undefined;
  /** Every chain step of every client this access creates (content-free; see `JevChainAttempt`). */
  onChainAttempt?: (attempt: JevChainAttempt) => void;
  /** Physical Jev request and response observer (not telemetry). */
  onDebug?: (event: JevDebugEvent) => void;
  /** Avoid preparing trace bodies while the session switch is off. */
  debugEnabled?: () => boolean;
}

export interface JevClientRequest {
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  /** Total wait of one chain call (the site's wait budget). */
  waitMs: number;
  onAttempt?: (attempt: JevAttempt) => void;
  /** Single-url only: model override (e.g. the legacy fast-jev model); chain providers pin their own. */
  model?: string;
  /** One budget unit per call; false refuses the call without any request. */
  take?: () => boolean;
}

export interface JevAccess {
  source: JevChainSource;
  /** Every Jev key this session may send, for `containsCredential`. Never log it. */
  secrets: readonly string[];
  /** True when the capability's chain has at least one provider that can be called. */
  available(capability: JevCapability): boolean;
  /** The capability's client, or undefined when `available` is false. */
  client(capability: JevCapability, request: JevClientRequest): JevClient | undefined;
  /** Content-free: provider ids, per-capability overrides, source, legacy notes. */
  statusLines(): string[];
}

const REFUSED = { ok: false, error: { kind: "network_error" } } as const;

/** Wraps `client` so each call spends exactly one unit from `take`. */
function unitBound(client: JevClient, take: () => boolean): JevClient {
  return {
    choice: (questions, options) => (take() ? client.choice(questions, options) : Promise.resolve(REFUSED as JevResult<never>)),
    noul: (questions, options) => (take() ? client.noul(questions, options) : Promise.resolve(REFUSED as JevResult<never>)),
  };
}

export function createJevAccess(options: JevAccessOptions): JevAccess {
  const { config, env } = options;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const key = readJevKey(env);
  const notes: string[] = [];
  let chain: JevChainConfig | undefined;
  let source: JevChainSource = { kind: "single-url" };

  if (config.jev.chain) {
    chain = config.jev.chain;
    source = { kind: "config" };
  } else if (options.legacyProvidersPath !== undefined) {
    const fileMode = options.fileMode ?? ((path: string) => statSync(path).mode);
    const legacy = readLegacyProviders(options.legacyProvidersPath, readFile, env, fileMode);
    if (!legacy.ok) {
      const why = legacy.detail ? `${legacy.reason} (${legacy.detail})` : legacy.reason;
      notes.push(`legacy ${options.legacyProvidersPath} ${why}; ignored (single-url)`);
    }
    else if (legacy.defaulted) notes.push(`legacy ${options.legacyProvidersPath}: absent (single-url)`);
    else {
      chain = legacy.config;
      source = legacy.source;
      notes.push(...legacy.warnings);
    }
  }

  const resolve = (capability: JevCapability) => (chain ? resolveChain(chainFor(chain, capability), { env, readFile }) : []);
  const all = chain ? resolveChain([chain.providers, ...Object.values(chain.capabilities ?? {})].flat(), { env, readFile }) : [];
  const secrets = [...new Set([...(key ? [key] : []), ...chainSecrets(all)])];

  return {
    source,
    secrets,
    available: (capability) => (chain ? resolve(capability).some((p) => !p.missingKey) : key !== undefined),
    client(capability, request) {
      let client: JevClient;
      if (chain) {
        const providers = resolve(capability);
        if (!providers.some((p) => !p.missingKey)) return undefined;
        client = createJevChainClient({ providers, fetch: request.fetch, now: request.now, newId: request.newId, waitMs: request.waitMs,
          ...(request.onAttempt ? { onAttempt: request.onAttempt } : {}),
          ...(options.onDebug ? { onDebug: options.onDebug } : {}),
          ...(options.debugEnabled ? { debugEnabled: options.debugEnabled } : {}),
          ...(options.onChainAttempt ? { onChainAttempt: options.onChainAttempt } : {}) });
      } else if (options.onChainAttempt) {
        // Single-url as a 1-provider chain, so its attempts are reported like any chain step.
        if (!key) return undefined;
        const spec = { id: TYPESAFE_PROFILE.id, url: config.jev.url, model: request.model ?? TYPESAFE_PROFILE.model, identity: TYPESAFE_PROFILE.identity ?? "exact", timeoutMs: config.jev.timeoutMs };
        client = createJevChainClient({ providers: [{ spec, key, missingKey: false }], fetch: request.fetch, now: request.now, newId: request.newId, waitMs: request.waitMs,
          ...(request.onAttempt ? { onAttempt: request.onAttempt } : {}), ...(options.onDebug ? { onDebug: options.onDebug } : {}),
          ...(options.debugEnabled ? { debugEnabled: options.debugEnabled } : {}), onChainAttempt: options.onChainAttempt });
      } else {
        if (!key) return undefined;
        client = createJevClient({
          profile: { ...TYPESAFE_PROFILE, url: config.jev.url, timeoutMs: config.jev.timeoutMs, ...(request.model ? { model: request.model } : {}) },
          key, fetch: request.fetch, now: request.now, newId: request.newId,
          ...(request.onAttempt ? { onAttempt: request.onAttempt } : {}),
          ...(options.onDebug ? { onDebug: options.onDebug } : {}),
          ...(options.debugEnabled ? { debugEnabled: options.debugEnabled } : {}),
        });
      }
      return request.take ? unitBound(client, request.take) : client;
    },
    statusLines() {
      if (!chain) return ["jev providers=typesafe source=single-url (jev.url)", ...notes.map((note) => `jev providers: ${note}`)];
      const overrides = Object.entries(chain.capabilities ?? {}).map(([name, list]) => `jev chain ${name}: ${list.map((p) => p.id).join(" -> ")}`);
      return [`jev ${describeChain(chain, source)}`, ...overrides, ...notes.map((note) => `jev providers: ${note}`)];
    },
  };
}
