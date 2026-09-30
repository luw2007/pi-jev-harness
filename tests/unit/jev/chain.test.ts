import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  LEGACY_INLINE_KEY_MODE_WARNING,
  LEGACY_TYPESAFE_PIN_WARNING,
  chainFor,
  chainSecrets,
  createJevChainClient,
  describeChain,
  parseJevChainConfig,
  readLegacyProviders,
  resolveChain,
  singleUrlChain,
  type ChoiceQuestion,
  type JevChainAttempt,
  type JevProviderSpec,
  type ResolvedJevProvider,
} from "../../../src/jev/index.ts";
import { containsCredential, loadConfig } from "../../../src/adapters/shared/config.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "jev-providers.legacy.json");
const QUESTION: ChoiceQuestion = {
  id: "route",
  question: "TASK-TEXT-SECRET which tool?",
  options: [
    { id: "read", description: "Read" },
    { id: "decline", description: "Decline" },
  ],
};

function answer(model: string, choice = "read") {
  const probabilities = choice === "read" ? { read: 0.8, decline: 0.2 } : { read: 0.2, decline: 0.8 };
  return JSON.stringify({ model, answers: { route: { type: "choice", choice, confidence: 0.8, probabilities } } });
}

function spec(id: string, extra: Partial<JevProviderSpec> = {}): JevProviderSpec {
  return { id, url: `https://${id}.test/v1`, model: "jev-1.13.0", identity: "exact", timeoutMs: 1000, keyEnv: `${id.toUpperCase()}_KEY`, ...extra };
}

type Reply = Response | "throw" | "hang";
/** Fake fetch: `replies[host]` decides each provider's response. Records hosts and auth headers. */
function fakeFetch(replies: Record<string, () => Reply>) {
  const calls: { host: string; auth: string | null }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    calls.push({ host, auth: new Headers(init?.headers).get("authorization") });
    const reply = replies[host]!();
    if (reply === "throw") throw new TypeError("fetch failed");
    if (reply === "hang") return new Promise<Response>(() => {});
    return reply;
  }) as typeof fetch;
  return { fetch: fake, calls };
}

function run(providers: JevProviderSpec[], replies: Record<string, () => Reply>, waitMs = 5000, env: Record<string, string> = {}) {
  const { fetch, calls } = fakeFetch(replies);
  const attempts: JevChainAttempt[] = [];
  const allEnv = { A_KEY: "sk-a", B_KEY: "sk-b", C_KEY: "sk-c", ...env };
  let n = 0;
  const client = createJevChainClient({
    providers: resolveChain(providers, { env: allEnv }),
    fetch,
    now: Date.now,
    newId: () => `id-${n++}`,
    waitMs,
    onChainAttempt: (a) => attempts.push(a),
  });
  return { calls, attempts, result: client.choice([QUESTION], { decisionId: "d1", state: "s" }) };
}

const ok = (model = "jev-1.13.0", choice = "read") => () => new Response(answer(model, choice), { status: 200 });
const status = (code: number) => () => new Response("provider error sk-leak", { status: code });

test("first healthy provider answers; later providers untouched", async () => {
  const r = run([spec("a"), spec("b")], { "a.test": ok(), "b.test": ok() });
  assert.equal((await r.result).ok, true);
  assert.deepEqual(r.calls.map((c) => c.host), ["a.test"]);
  assert.equal(r.calls[0]!.auth, "Bearer sk-a");
});

for (const [name, reply] of [
  ["transport error", () => "throw" as const],
  ["5xx", status(503)],
  ["429", status(429)],
  ["identity mismatch", ok("other-model")],
] as const) {
  test(`falls back in order on ${name}`, async () => {
    const r = run([spec("a"), spec("b"), spec("c")], { "a.test": reply, "b.test": reply, "c.test": ok() });
    const result = await r.result;
    assert.equal(result.ok, true);
    assert.deepEqual(r.calls.map((c) => c.host), ["a.test", "b.test", "c.test"]);
    assert.deepEqual(r.attempts.map((a) => [a.providerId, a.fellBack]), [["a", true], ["b", true], ["c", false]]);
  });
}

test("falls back on per-provider timeout", async () => {
  const r = run([spec("a", { timeoutMs: 30 }), spec("b")], { "a.test": () => "hang", "b.test": ok() });
  assert.equal((await r.result).ok, true);
  assert.equal(r.attempts[0]!.outcome, "timeout");
});

test("well-formed decline stops the chain", async () => {
  const r = run([spec("a"), spec("b")], { "a.test": ok("jev-1.13.0", "decline"), "b.test": ok() });
  const result = await r.result;
  assert.ok(result.ok && result.evidence[0]!.choice === "decline");
  assert.deepEqual(r.calls.map((c) => c.host), ["a.test"]);
});

test("non-fallback errors (4xx, malformed body) stop the chain", async () => {
  for (const reply of [status(400), () => new Response(JSON.stringify({ model: "jev-1.13.0" }), { status: 200 })]) {
    const r = run([spec("a"), spec("b")], { "a.test": reply, "b.test": ok() });
    assert.equal((await r.result).ok, false);
    assert.equal(r.calls.length, 1);
  }
});

test("total wait stays within budget; remaining providers recorded as budget_exhausted", async () => {
  const started = Date.now();
  const r = run([spec("a"), spec("b"), spec("c")], { "a.test": () => "hang", "b.test": () => "hang", "c.test": ok() }, 60);
  const result = await r.result;
  assert.ok(Date.now() - started < 400, "chain must not multiply the wait budget");
  assert.equal(result.ok, false);
  assert.equal(r.attempts.at(-1)!.outcome, "budget_exhausted");
  assert.ok(!r.calls.some((c) => c.host === "c.test"));
});

test("missing key skips a provider; identity none/prefix accepted with warning", async () => {
  const r = run(
    [spec("x"), spec("b", { identity: "none", model: "bjev" }), spec("c")],
    { "b.test": ok("jev-9"), "c.test": ok() },
  );
  const result = await r.result;
  assert.ok(result.ok && result.evidence[0]!.model === "jev-9");
  assert.deepEqual(r.attempts.map((a) => a.outcome), ["no_key", "ok"]);
  assert.equal(r.attempts[1]!.identityWarning, true);
  const p = run([spec("a", { identity: "prefix", model: "jev-1" })], { "a.test": ok("jev-1.13.0") });
  assert.equal((await p.result).ok, true);
});

test("telemetry never carries keys, urls or task text", async () => {
  const r = run([spec("a"), spec("b")], { "a.test": status(500), "b.test": ok() });
  await r.result;
  const text = JSON.stringify(r.attempts);
  for (const secret of ["sk-a", "sk-b", "TASK-TEXT", "https://", "sk-leak"]) assert.ok(!text.includes(secret), secret);
  for (const a of r.attempts) assert.deepEqual(Object.keys(a).sort().filter((k) => !["httpStatus", "identityWarning"].includes(k)), ["chainLength", "decisionId", "durationMs", "fellBack", "outcome", "providerId", "sequence"]);
});

test("single-url chain is TypeSafe, exact identity, TYPESAFE_API_KEY", async () => {
  const chain = singleUrlChain("https://api.typesafe.ai/v1/systemone", 15_000);
  assert.equal(chain.providers.length, 1);
  assert.deepEqual(chain.providers[0], {
    id: "typesafe",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    identity: "exact",
    timeoutMs: 15_000,
    keyEnv: "TYPESAFE_API_KEY",
  });
  const resolved: ResolvedJevProvider[] = resolveChain(chain.providers, { env: {} });
  assert.equal(resolved[0]!.missingKey, true);
});

test("adapter config: no providers keeps the single-url shape; providers parse; inline keys rejected", async () => {
  const load = (jev: unknown) =>
    loadConfig({ env: {}, home: "/nonexistent-home", path: "/cfg.json", readText: async () => JSON.stringify({ jev }) });
  const plain = await load({ url: "https://x.test/v1" });
  assert.equal(plain.source, "file");
  assert.equal(plain.config.jev.chain, undefined);
  const chained = await load({ providers: [spec("a")], capabilities: { compact: [spec("b"), spec("c")] } });
  assert.equal(chained.source, "file");
  assert.deepEqual(chainFor(chained.config.jev.chain!, "compact").map((p) => p.id), ["b", "c"]);
  assert.deepEqual(chainFor(chained.config.jev.chain!, "route").map((p) => p.id), ["a"]);
  assert.equal((await load({ providers: [{ ...spec("a"), key: "sk-inline" }] })).source, "invalid");
  assert.equal(parseJevChainConfig([spec("a", { identity: "loose" as never })], undefined).ok, false);
});

test("legacy jev-providers.json maps to a chain, read-only, with its source", () => {
  const reads: string[] = [];
  const result = readLegacyProviders(FIXTURE, (p) => (reads.push(p), readFileSync(p, "utf8")));
  assert.deepEqual(reads, [FIXTURE]);
  assert.ok(result.ok);
  assert.deepEqual(result.source, { kind: "legacy", path: FIXTURE });
  const [internal, typesafe, openrouter] = result.config.providers;
  assert.deepEqual(internal, { id: "internal", url: "https://bjev.example.invalid/v1/systemone", model: "bjev", identity: "none", timeoutMs: 3000 });
  assert.equal(typesafe!.identity, "exact");
  assert.equal(typesafe!.keyEnv, "TYPESAFE_API_KEY");
  assert.equal(openrouter!.keyEnv, "FAKE_OPENROUTER_KEY_ENV");
  assert.deepEqual(chainFor(result.config, "compact").map((p) => p.id), ["typesafe", "openrouter"]);
  assert.deepEqual(chainFor(result.config, "plan").map((p) => p.id), ["internal"]);
  assert.equal(result.config.capabilities?.modelRouting, undefined);
  assert.match(describeChain(result.config, result.source), /providers=internal -> typesafe -> openrouter source=legacy:/);

  assert.ok(result.warnings.includes(LEGACY_TYPESAFE_PIN_WARNING));
  assert.equal(readLegacyProviders("/bad.json", () => "{ not json").ok, false);
  assert.equal(readLegacyProviders("/bad.json", () => JSON.stringify({ schemaVersion: 1, default: "ghost" })).ok, false);
});

test("legacy: missing file yields the old default chain (compact: typesafe -> openrouter)", () => {
  const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
  const r = readLegacyProviders("/missing.json", () => { throw enoent; });
  assert.ok(r.ok && r.defaulted);
  assert.deepEqual(r.config.providers.map((p) => p.id), ["typesafe"]);
  assert.deepEqual(chainFor(r.config, "compact").map((p) => p.id), ["typesafe", "openrouter"]);
  assert.equal(r.config.providers[0]!.model, "jev-1.13.0");
  assert.ok(r.warnings.includes(LEGACY_TYPESAFE_PIN_WARNING));
});

test("legacy: secret-looking values outside apiKey, empty apiKey, or apiKey with apiKeyEnv reject the file", () => {
  const file = (provider: Record<string, unknown>) => () =>
    JSON.stringify({ schemaVersion: 1, default: "x", providers: { x: { url: "https://x.test", model: "m", ...provider } } });
  assert.equal(readLegacyProviders("/p", file({ model: "sk-FAKEFAKEFAKE1234" })).ok, false);
  assert.equal(readLegacyProviders("/p", file({ apiKey: "   " })).ok, false);
  assert.equal(readLegacyProviders("/p", file({ apiKey: "k", apiKeyEnv: "X_KEY" })).ok, false);
  assert.equal(readLegacyProviders("/p", file({ token: "k" })).ok, false);
  assert.equal(readLegacyProviders("/p", file({})).ok, true);
});

test("legacy: inline apiKey authenticates, falls back, and stays out of status and telemetry", async () => {
  const INLINE = "sk-FAKEINLINEKEY-0123456789";
  const raw = { schemaVersion: 1, default: "x", fallback: ["y"], providers: {
    x: { url: "https://x.test/v1", model: "jev-1.13.0", apiKey: ` ${INLINE} ` },
    y: { url: "https://y.test/v1", model: "jev-1.13.0", apiKeyEnv: "Y_KEY" },
  } };
  const legacy = readLegacyProviders("/p", () => JSON.stringify(raw));
  assert.ok(legacy.ok);
  const resolved = resolveChain(legacy.config.providers, { env: { Y_KEY: "env-key-y" } });
  assert.deepEqual(chainSecrets(resolved), [INLINE, "env-key-y"]);
  assert.equal(containsCredential(`task text ${INLINE}`, [undefined, ...chainSecrets(resolved)]), true);
  const { fetch, calls } = fakeFetch({ "x.test": status(503), "y.test": ok() });
  const attempts: JevChainAttempt[] = [];
  const client = createJevChainClient({ providers: resolved, fetch, now: Date.now, newId: () => "id", waitMs: 5000, onChainAttempt: (a) => attempts.push(a) });
  assert.equal((await client.choice([QUESTION], { decisionId: "d1", state: "s" })).ok, true);
  assert.deepEqual(calls.map((c) => [c.host, c.auth]), [["x.test", `Bearer ${INLINE}`], ["y.test", "Bearer env-key-y"]]);
  const visible = JSON.stringify([attempts, legacy.warnings, describeChain(legacy.config, legacy.source)]);
  assert.equal(visible.includes(INLINE), false);
});

test("legacy: api-key is an alias of apiKey; conflicts reject with a key-free detail; loose mode warns", () => {
  const KEY = "sk-FAKEALIASKEY-0123456789";
  const file = (provider: Record<string, unknown>) => () =>
    JSON.stringify({ schemaVersion: 1, default: "openrouter", providers: { openrouter: provider } });
  for (const field of ["apiKey", "api-key"]) {
    const r = readLegacyProviders("/p", file({ [field]: KEY }), {}, () => 0o100600);
    assert.ok(r.ok, field);
    assert.equal(r.config.providers[0]!.apiKey, KEY);
    assert.equal(r.config.providers[0]!.keyEnv, undefined, "inline key overrides the built-in env var");
    assert.deepEqual(r.warnings, []);
    const resolved = resolveChain(r.config.providers, { env: { OPENROUTER_API_KEY: "env-should-not-win" } });
    assert.deepEqual(chainSecrets(resolved), [KEY]);
  }
  const both = readLegacyProviders("/p", file({ apiKey: KEY, "api-key": KEY }));
  const withEnv = readLegacyProviders("/p", file({ "api-key": KEY, apiKeyEnv: "X_KEY" }));
  for (const r of [both, withEnv]) {
    assert.ok(!r.ok && r.reason === "invalid" && r.detail);
    assert.equal(JSON.stringify(r).includes(KEY), false);
  }
  assert.match((both as { detail: string }).detail, /both apiKey and api-key/);
  assert.match((withEnv as { detail: string }).detail, /mutually exclusive/);
  // Secret shapes in other fields still reject; the alias field itself does not.
  assert.equal(readLegacyProviders("/p", file({ "api-key": KEY, model: "sk-FAKEFAKEFAKE1234" })).ok, false);
  const loose = readLegacyProviders("/p", file({ "api-key": KEY }), {}, () => 0o100644);
  assert.ok(loose.ok && loose.warnings.includes(LEGACY_INLINE_KEY_MODE_WARNING));
  assert.equal(JSON.stringify(loose.warnings).includes(KEY), false);
  const noKey = readLegacyProviders("/p", file({}), {}, () => 0o100644);
  assert.ok(noKey.ok && !noKey.warnings.includes(LEGACY_INLINE_KEY_MODE_WARNING));
});

test("legacy: JEV_URL overrides built-in typesafe url; strings are trimmed; unknown capability dropped with warning", () => {
  const raw = {
    schemaVersion: 1,
    default: " typesafe ",
    fallback: [" x "],
    providers: { " x ": { url: " https://x.test/v1 ", model: " m ", apiKeyEnv: " X_KEY " } },
    capabilities: { compaction: { default: "x" }, mystery: { default: "x" } },
  };
  const r = readLegacyProviders("/p", () => JSON.stringify(raw), { JEV_URL: " https://fake-typesafe.test/v1 " });
  assert.ok(r.ok);
  assert.equal(r.config.providers[0]!.url, "https://fake-typesafe.test/v1");
  assert.deepEqual(r.config.providers[1], { id: "x", url: "https://x.test/v1", model: "m", identity: "none", timeoutMs: 15_000, keyEnv: "X_KEY" });
  assert.deepEqual(Object.keys(r.config.capabilities!), ["compact"]);
  assert.ok(r.warnings.some((w) => w.includes("mystery")));
});

test("config: unknown capability names are rejected", async () => {
  assert.equal(parseJevChainConfig([spec("a")], { mystery: [spec("b")] }).ok, false);
  assert.equal(parseJevChainConfig([spec("a")], { effort: [spec("b")], route: [spec("c")] }).ok, true);
});

test("all providers missing keys -> no_provider_available, nothing sent", async () => {
  const r = run([spec("x"), spec("y")], {});
  const result = await r.result;
  assert.ok(!result.ok && result.error.kind === "no_provider_available");
  assert.equal(r.calls.length, 0);
});

test("chainSecrets returns every resolved key; credential scan covers them", () => {
  const resolved = resolveChain([spec("a"), spec("b"), spec("c", { keyEnv: undefined, keyFile: "/k" })], {
    env: { A_KEY: "sk-a-secret", B_KEY: "b-secret" },
    readFile: () => " file-secret\n",
  });
  const secrets = chainSecrets(resolved);
  assert.deepEqual(secrets, ["sk-a-secret", "b-secret", "file-secret"]);
  assert.equal(containsCredential("leak file-secret here", [undefined, ...secrets]), true);
  assert.equal(containsCredential("clean text", [undefined, ...secrets]), false);
  assert.equal(containsCredential("clean text", "b-secret"), false);
});

test("budget: one chain call is one decision unit; attempts bounded by chain length", async () => {
  const { fetch, calls } = fakeFetch({ "a.test": status(503), "b.test": status(502), "c.test": ok() });
  const physical: string[] = [];
  const client = createJevChainClient({
    providers: resolveChain([spec("a"), spec("b"), spec("c")], { env: { A_KEY: "1", B_KEY: "2", C_KEY: "3" } }),
    fetch,
    now: Date.now,
    newId: () => "id",
    waitMs: 5000,
    onAttempt: (_a, id) => physical.push(id),
  });
  let decisions = 0;
  const decide = () => (decisions++, client.choice([QUESTION], { decisionId: `d${decisions}`, state: "s" }));
  assert.equal((await decide()).ok, true);
  assert.equal(decisions, 1);
  assert.equal(physical.length, 3);
  assert.ok(calls.length <= 3);
});
