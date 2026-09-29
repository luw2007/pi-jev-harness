/**
 * Verifier: legacy inline `apiKey` / `api-key` never leaks and is sent only to its own provider.
 * A distinctive fake key (not `sk-`-shaped, so generic credential patterns cannot mask a miss) is
 * pushed through every surface that could carry it. Injected reader, mode reader and fetch only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_INLINE_KEY_MODE_WARNING,
  chainSecrets,
  createJevChainClient,
  describeChain,
  readLegacyProviders,
  resolveChain,
  type ChoiceQuestion,
  type JevChainAttempt,
} from "../../../src/jev/index.ts";
import { containsCredential, defaultConfig } from "../../../src/adapters/shared/config.ts";
import { createJevAccess } from "../../../src/adapters/shared/jev-access.ts";

const KEY = "FAKEINLINEzq7Wm3Kx9Pv2Lr8Tn4";
const TS_ENV_KEY = "FAKETSENVkey4488aa";
const QUESTION: ChoiceQuestion = { id: "route", question: "which tool?", options: [{ id: "read", description: "Read" }, { id: "decline", description: "Decline" }] };
const answer = (model: string) =>
  JSON.stringify({ model, answers: { route: { type: "choice", choice: "read", confidence: 0.8, probabilities: { read: 0.8, decline: 0.2 } } } });

const legacyFile = (internal: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, default: "internal", fallback: ["typesafe"],
    providers: { internal: { url: "https://internal.test/v1", model: "jev-internal", ...internal } }, ...extra });

const noLeak = (value: unknown, label: string) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(KEY), false, `${label} leaked the key`);
  assert.equal(text.includes(KEY.slice(4, 20)), false, `${label} leaked part of the key`);
};

test("verify: internal fails (transport error echoing headers) -> typesafe answers with its own key only", async () => {
  for (const field of ["apiKey", "api-key"]) {
    const legacy = readLegacyProviders("/p", () => legacyFile({ [field]: KEY }), {}, () => 0o100600);
    assert.ok(legacy.ok, field);
    const resolved = resolveChain(legacy.config.providers, { env: { TYPESAFE_API_KEY: TS_ENV_KEY } });
    const calls: { host: string; auth: string | null }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const headers = new Headers(init?.headers);
      calls.push({ host, auth: headers.get("authorization") });
      // Undici-style error that echoes the request headers in its message and cause.
      if (host === "internal.test") throw Object.assign(new TypeError(`fetch failed: ${JSON.stringify(init?.headers)}`), { cause: init });
      return new Response(answer("jev-1.13.0"), { status: 200 });
    }) as typeof globalThis.fetch;
    const chainAttempts: JevChainAttempt[] = [];
    const attempts: unknown[] = [];
    const client = createJevChainClient({ providers: resolved, fetch, now: Date.now, newId: () => "id", waitMs: 5000,
      onChainAttempt: (a) => chainAttempts.push(a), onAttempt: (a, id) => attempts.push([a, id]) });
    const result = await client.choice([QUESTION], { decisionId: "d1", state: "s" });
    assert.equal(result.ok, true, field);
    assert.deepEqual(calls, [
      { host: "internal.test", auth: `Bearer ${KEY}` },
      { host: "api.typesafe.ai", auth: `Bearer ${TS_ENV_KEY}` },
    ]);
    assert.equal(calls.filter((c) => c.auth?.includes(KEY)).length, 1, "inline key sent exactly once, to internal");
    assert.equal(chainAttempts[0]!.outcome, "network_error");
    noLeak(result, "result");
    noLeak(chainAttempts, "chain telemetry");
    noLeak(attempts, "attempt telemetry");
    noLeak(legacy.warnings, "warnings");
    noLeak(describeChain(legacy.config, legacy.source), "describeChain");
    noLeak(legacy.source, "source");
  }
});

test("verify: failing results (5xx echoing key, thrown non-Error, timeout) never carry the key", async () => {
  const legacy = readLegacyProviders("/p", () => legacyFile({ apiKey: KEY }, { fallback: [] }));
  assert.ok(legacy.ok);
  const resolved = resolveChain(legacy.config.providers, { env: {} });
  for (const behaviour of ["5xx", "throw-string", "throw-object", "hang"] as const) {
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      if (behaviour === "5xx") return new Response(`bad key ${KEY}`, { status: 503 });
      if (behaviour === "throw-string") throw `boom ${KEY}`;
      if (behaviour === "throw-object") throw { headers: init?.headers };
      return new Promise<Response>(() => {});
    }) as typeof globalThis.fetch;
    const telemetry: unknown[] = [];
    const client = createJevChainClient({ providers: resolved, fetch, now: Date.now, newId: () => "id", waitMs: 50,
      onChainAttempt: (a) => telemetry.push(a), onAttempt: (a) => telemetry.push(a) });
    const result = await client.choice([QUESTION], { decisionId: "d", state: "s" });
    assert.equal(result.ok, false, behaviour);
    noLeak(result, `result(${behaviour})`);
    noLeak(telemetry, `telemetry(${behaviour})`);
  }
});

test("verify: typesafe inline key overrides TYPESAFE_API_KEY and is the only key typesafe gets", async () => {
  const raw = JSON.stringify({ schemaVersion: 1, default: "typesafe", providers: { typesafe: { "api-key": KEY } } });
  const legacy = readLegacyProviders("/p", () => raw);
  assert.ok(legacy.ok);
  assert.equal(legacy.config.providers[0]!.keyEnv, undefined);
  const resolved = resolveChain(legacy.config.providers, { env: { TYPESAFE_API_KEY: TS_ENV_KEY } });
  assert.deepEqual(chainSecrets(resolved), [KEY]);
});

test("verify: chainSecrets / access.secrets feed the credential scan for task text", () => {
  const access = createJevAccess({ config: defaultConfig("/h"), env: { TYPESAFE_API_KEY: TS_ENV_KEY }, legacyProvidersPath: "/legacy.json",
    readFile: () => legacyFile({ apiKey: KEY }), fileMode: () => 0o100600 });
  assert.equal(access.source.kind, "legacy");
  assert.ok(access.secrets.includes(KEY));
  assert.equal(containsCredential(`please use ${KEY} for this`, access.secrets), true);
  assert.equal(containsCredential("please list files", access.secrets), false);
  assert.equal(access.available("route"), true);
  noLeak(access.statusLines(), "statusLines");
  noLeak(access.source, "access.source");
});

test("verify: every rejection reason / status note is key-free", () => {
  const variants: [string, string][] = [
    ["both spellings", legacyFile({ apiKey: KEY, "api-key": KEY })],
    ["inline + apiKeyEnv", legacyFile({ "api-key": KEY, apiKeyEnv: "X_KEY" })],
    ["apiKey + apiKeyEnv", legacyFile({ apiKey: KEY, apiKeyEnv: "X_KEY" })],
    ["unknown field", legacyFile({ apiKey: KEY, token: KEY })],
    ["secret shape elsewhere", legacyFile({ apiKey: KEY, model: `sk-${KEY}` })],
    ["bearer in url", legacyFile({ apiKey: KEY, url: `https://x.test/?h=Bearer ${KEY}` })],
    ["non-string key", legacyFile({ apiKey: 12345 })],
    ["bad url", legacyFile({ apiKey: KEY, url: "ftp://x" })],
    ["bad schema", legacyFile({ apiKey: KEY }).replace('"schemaVersion":1', '"schemaVersion":2')],
    ["broken json", `{"schemaVersion":1,"providers":{"internal":{"apiKey":"${KEY}"`],
    ["unknown chain id", legacyFile({ apiKey: KEY }, { fallback: ["nope"] })],
  ];
  for (const [label, raw] of variants) {
    const r = readLegacyProviders("/p", () => raw, {}, () => 0o100644);
    assert.equal(r.ok, false, label);
    noLeak(r, `result(${label})`);
    const access = createJevAccess({ config: defaultConfig("/h"), env: {}, legacyProvidersPath: "/legacy.json", readFile: () => raw, fileMode: () => 0o100644 });
    assert.equal(access.source.kind, "single-url", label);
    noLeak(access.statusLines(), `status(${label})`);
    assert.equal(access.secrets.includes(KEY), false, `${label}: rejected file contributes no secret`);
  }
  const both = readLegacyProviders("/p", () => variants[0]![1]);
  assert.ok(!both.ok && /both apiKey and api-key/.test(both.detail ?? ""));
  const mixed = readLegacyProviders("/p", () => variants[1]![1]);
  assert.ok(!mixed.ok && /mutually exclusive/.test(mixed.detail ?? ""));
  const unreadable = readLegacyProviders("/p", () => { throw Object.assign(new Error(KEY), { code: "EACCES" }); });
  assert.ok(!unreadable.ok && unreadable.reason === "unreadable");
  noLeak(unreadable, "unreadable");
});

test("verify: mode warning only for an inline key in a file looser than 0600; mode reader failure is silent", () => {
  const withKey = () => legacyFile({ apiKey: KEY });
  const without = () => legacyFile({});
  const warns = (read: () => string, mode: (() => number | undefined) | undefined) => {
    const r = readLegacyProviders("/p", read, {}, mode);
    assert.ok(r.ok);
    noLeak(r.warnings, "warnings");
    return r.warnings.includes(LEGACY_INLINE_KEY_MODE_WARNING);
  };
  for (const mode of [0o100644, 0o100640, 0o100604, 0o100660, 0o100666, 0o100601, 0o100610]) assert.equal(warns(withKey, () => mode), true, mode.toString(8));
  for (const mode of [0o100600, 0o100400, 0o100700]) assert.equal(warns(withKey, () => mode), false, mode.toString(8));
  for (const mode of [0o100644, 0o100666]) assert.equal(warns(without, () => mode), false, `no key ${mode.toString(8)}`);
  assert.equal(warns(withKey, undefined), false, "no mode reader");
  assert.equal(warns(withKey, () => { throw new Error("stat failed"); }), false, "stat failure");
  // A key held by a provider outside every chain still counts: the file holds a plaintext key.
  const unused = JSON.stringify({ schemaVersion: 1, default: "typesafe", providers: { internal: { url: "https://i.test", model: "m", apiKey: KEY } } });
  assert.equal(warns(() => unused, () => 0o100644), true);
});
