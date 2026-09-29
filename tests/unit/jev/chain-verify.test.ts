// Verifier edge cases for the C9 provider chain.
import assert from "node:assert/strict";
import test from "node:test";
import {
  TYPESAFE_PROFILE,
  createJevChainClient,
  createJevClient,
  parseJevChainConfig,
  readLegacyProviders,
  resolveChain,
  singleUrlChain,
  chainFor,
  chainSecrets,
  type ChoiceQuestion,
  type JevChainAttempt,
  type JevProviderSpec,
} from "../../../src/jev/index.ts";
import { containsCredential, loadConfig } from "../../../src/adapters/shared/config.ts";

const Q: ChoiceQuestion = {
  id: "route",
  question: "TASK-TEXT which?",
  options: [
    { id: "read", description: "Read" },
    { id: "decline", description: "Decline" },
  ],
};
const body = (model: string) =>
  JSON.stringify({ model, answers: { route: { type: "choice", choice: "read", confidence: 0.8, probabilities: { read: 0.8, decline: 0.2 } } } });
const spec = (id: string, extra: Partial<JevProviderSpec> = {}): JevProviderSpec => ({
  id,
  url: `https://${id}.test/v1`,
  model: "jev-1.13.0",
  identity: "exact",
  timeoutMs: 1000,
  keyEnv: `${id.toUpperCase()}_KEY`,
  ...extra,
});
const ENV = { A_KEY: "sk-a", B_KEY: "sk-b", C_KEY: "sk-c" };

type Reply = () => Response | Promise<Response>;
function harness(providers: JevProviderSpec[], replies: Record<string, Reply>, opts: { waitMs?: number; now?: () => number; env?: Record<string, string> } = {}) {
  const calls: { host: string; headers: Record<string, string>; body: string; url: string }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    calls.push({ host, url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body: String(init?.body) });
    const signal = init?.signal;
    const reply = replies[host];
    if (!reply) return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    return reply();
  }) as typeof fetch;
  const attempts: JevChainAttempt[] = [];
  const client = createJevChainClient({
    providers: resolveChain(providers, { env: opts.env ?? ENV }),
    fetch: fakeFetch,
    now: opts.now ?? Date.now,
    newId: () => "id",
    waitMs: opts.waitMs ?? 5000,
    onChainAttempt: (a) => attempts.push(a),
  });
  return { calls, attempts, client };
}

test("single-url chain sends the same request as the pre-chain client", async () => {
  const replies = { "api.typesafe.ai": () => new Response(body("jev-1.13.0")) };
  const chain = singleUrlChain(TYPESAFE_PROFILE.url, TYPESAFE_PROFILE.timeoutMs);
  const viaChain = harness(chain.providers, replies, { env: { TYPESAFE_API_KEY: "sk-t" } });
  const r1 = await viaChain.client.choice([Q], { decisionId: "d", state: "s" });

  const direct: typeof viaChain.calls = [];
  const client = createJevClient({
    profile: TYPESAFE_PROFILE,
    key: "sk-t",
    fetch: (async (url: string, init: RequestInit) => {
      direct.push({ host: new URL(url).host, url, headers: Object.fromEntries(new Headers(init.headers)), body: String(init.body) });
      return replies["api.typesafe.ai"]();
    }) as unknown as typeof fetch,
    now: Date.now,
    newId: () => "id",
  });
  const r2 = await client.choice([Q], { decisionId: "d", state: "s" });
  assert.deepEqual(viaChain.calls, direct);
  assert.equal(direct[0]!.headers.authorization, "Bearer sk-t");
  assert.ok(r1.ok && r2.ok);
  assert.deepEqual(r1.evidence, r2.evidence);
});

test("default identity is exact: a mismatched or missing model is rejected by the plain client", async () => {
  for (const model of ["jev-1.13.0-x", ""]) {
    const client = createJevClient({
      profile: TYPESAFE_PROFILE,
      key: "k",
      fetch: (async () => new Response(model ? body(model) : JSON.stringify({ answers: {} }))) as unknown as typeof fetch,
      now: Date.now,
      newId: () => "id",
    });
    const r = await client.choice([Q], { decisionId: "d", state: "s" });
    assert.ok(!r.ok && r.error.kind === "malformed");
    assert.equal(r.error.wire?.kind, model ? "model_mismatch" : "model_missing");
  }
});

test("keyless provider sends no authorization header", async () => {
  const h = harness([spec("a", { keyEnv: undefined })], { "a.test": () => new Response(body("jev-1.13.0")) });
  assert.ok((await h.client.choice([Q], { decisionId: "d", state: "s" })).ok);
  assert.equal(h.calls[0]!.headers.authorization, undefined);
});

for (const code of [400, 401, 403, 404, 413, 422]) {
  test(`HTTP ${code} stops the chain`, async () => {
    const h = harness([spec("a"), spec("b")], { "a.test": () => new Response("x", { status: code }), "b.test": () => new Response(body("jev-1.13.0")) });
    const r = await h.client.choice([Q], { decisionId: "d", state: "s" });
    assert.ok(!r.ok && r.error.httpStatus === code);
    assert.deepEqual(h.calls.map((c) => c.host), ["a.test"]);
    assert.equal(h.attempts[0]!.fellBack, false);
  });
}

test("model_missing falls back under exact identity", async () => {
  const h = harness([spec("a"), spec("b")], {
    "a.test": () => new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "read", confidence: 0.8, probabilities: { read: 0.8, decline: 0.2 } } } })),
    "b.test": () => new Response(body("jev-1.13.0")),
  });
  assert.ok((await h.client.choice([Q], { decisionId: "d", state: "s" })).ok);
  assert.deepEqual(h.calls.map((c) => c.host), ["a.test", "b.test"]);
});

test("caller abort stops the chain", async () => {
  const controller = new AbortController();
  const h = harness([spec("a"), spec("b")], {
    "a.test": () => {
      controller.abort();
      return new Promise<Response>(() => {});
    },
    "b.test": () => new Response(body("jev-1.13.0")),
  });
  const r = await h.client.choice([Q], { decisionId: "d", state: "s", signal: controller.signal });
  assert.ok(!r.ok && r.error.kind === "aborted");
  assert.deepEqual(h.calls.map((c) => c.host), ["a.test"]);
});

test("every provider missing its key: no request is sent", async () => {
  const h = harness([spec("x"), spec("y")], {}, { env: {} });
  const r = await h.client.choice([Q], { decisionId: "d", state: "s" });
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 0);
  assert.ok(!r.ok && r.error.kind === "no_provider_available");
  assert.deepEqual(h.attempts.map((a) => a.outcome), ["no_key", "no_key"]);
});

test("fake clock: slow providers never stretch the chain past waitMs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const waitMs = 1000;
  // a and b hang until aborted; each has a per-provider timeout (800) below the budget.
  const h = harness([spec("a", { timeoutMs: 800 }), spec("b", { timeoutMs: 800 }), spec("c")], { "c.test": () => new Response(body("jev-1.13.0")) }, { waitMs });
  let settled = false;
  const pending = h.client.choice([Q], { decisionId: "d", state: "s" }).finally(() => (settled = true));
  let elapsed = 0;
  const flush = () => new Promise<void>((r) => setImmediate(r));
  await flush();
  while (!settled && elapsed < 5000) {
    t.mock.timers.tick(10);
    elapsed += 10;
    for (let i = 0; i < 5; i++) await flush();
  }
  const r = await pending;
  assert.ok(elapsed <= waitMs, `chain took ${elapsed}ms of fake time, budget ${waitMs}`);
  assert.ok(!r.ok && r.error.kind === "timeout");
  assert.deepEqual(h.attempts.map((a) => [a.providerId, a.outcome]), [["a", "timeout"], ["b", "timeout"], ["c", "budget_exhausted"]]);
  assert.ok(h.attempts[0]!.durationMs + h.attempts[1]!.durationMs <= waitMs);
  assert.ok(!h.calls.some((c) => c.host === "c.test"));
});

test("fake clock: a provider that consumed the whole budget leaves nothing for the next", async () => {
  let clock = 0;
  const h = harness(
    [spec("a"), spec("b")],
    { "a.test": () => ((clock += 1000), new Response("x", { status: 503 })), "b.test": () => new Response(body("jev-1.13.0")) },
    { waitMs: 1000, now: () => clock },
  );
  const r = await h.client.choice([Q], { decisionId: "d", state: "s" });
  assert.ok(!r.ok && r.error.httpStatus === 503);
  assert.deepEqual(h.calls.map((c) => c.host), ["a.test"]);
  assert.equal(h.attempts.at(-1)!.outcome, "budget_exhausted");
});

test("config: capabilities without providers, inline key in a capability, keyEnv+keyFile are rejected", async () => {
  const load = (jev: unknown) => loadConfig({ env: {}, home: "/nonexistent-home", path: "/cfg.json", readText: async () => JSON.stringify({ jev }) });
  assert.equal((await load({ capabilities: { compact: [spec("a")] } })).source, "invalid");
  assert.equal((await load({ providers: [spec("a")], capabilities: { compact: [{ ...spec("b"), key: "sk" }] } })).source, "invalid");
  assert.equal((await load({ providers: [{ ...spec("a"), keyFile: "/k" }] })).source, "invalid");
  assert.equal((await load({ providers: [] })).source, "invalid");
  assert.equal((await load({ providers: [spec("a"), spec("a")] })).source, "invalid");
  assert.equal(parseJevChainConfig([spec("a", { url: "ftp://x" })], undefined).ok, false);
  const invalid = await load({ providers: [{ ...spec("a"), key: "sk-inline-secret" }] });
  assert.ok(!JSON.stringify(invalid).includes("sk-inline-secret"));
});

test("legacy: real-file shape (keyless internal Jev deployment, fallback typesafe, no capabilities)", () => {
  const raw = { schemaVersion: 1, default: "internal", fallback: ["typesafe"], providers: { internal: { url: "https://jev.example.invalid/v1", model: "jev-internal", timeoutMs: 3000 } } };
  const r = readLegacyProviders("/p", () => JSON.stringify(raw));
  assert.ok(r.ok);
  assert.deepEqual(r.config.providers.map((p) => [p.id, p.model, p.identity, p.timeoutMs, p.keyEnv]), [
    ["internal", "jev-internal", "none", 3000, undefined],
    ["typesafe", "jev-1.13.0", "exact", 15_000, "TYPESAFE_API_KEY"],
  ]);
  assert.deepEqual(chainFor(r.config, "compact").map((p) => p.id), ["internal", "typesafe"]);
  const resolved = resolveChain(r.config.providers, { env: {} });
  assert.deepEqual(resolved.map((p) => p.missingKey), [false, true]);
});

test("round 2: legacy parity with old providers.ts", () => {
  const read = (obj: unknown, env: Record<string, string> = {}) => readLegacyProviders("/p", () => JSON.stringify(obj), env);
  // Missing file: old defaultProviderConfig (typesafe; compact typesafe -> openrouter).
  const enoent = readLegacyProviders("/none", () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); });
  assert.ok(enoent.ok && enoent.defaulted);
  assert.deepEqual(enoent.config.providers.map((p) => p.id), ["typesafe"]);
  assert.deepEqual(chainFor(enoent.config, "compact").map((p) => p.id), ["typesafe", "openrouter"]);
  // JEV_URL overrides only the built-in typesafe url; a file url still wins.
  const env = { JEV_URL: " https://override.test/v1 " };
  const viaEnv = read({ schemaVersion: 1, default: "typesafe" }, env);
  assert.ok(viaEnv.ok && viaEnv.config.providers[0]!.url === "https://override.test/v1");
  const viaFile = read({ schemaVersion: 1, default: "typesafe", providers: { typesafe: { url: "https://file.test" } } }, env);
  assert.ok(viaFile.ok && viaFile.config.providers[0]!.url === "https://file.test");
  // Secret-looking values outside apiKey and whitespace-only strings reject the file; an inline
  // apiKey replaces the built-in env key source.
  const p = (extra: Record<string, unknown>) => ({ schemaVersion: 1, default: "p", providers: { p: { url: "https://a.test", model: "m", ...extra } } });
  const inline = read({ schemaVersion: 1, default: "openrouter", providers: { openrouter: { apiKey: "inline-key" } } });
  assert.ok(inline.ok && inline.config.providers[0]!.keyEnv === undefined && inline.config.providers[0]!.apiKey === "inline-key");
  assert.equal(read(p({ url: "https://a.test/?k=sk-abcdefghijkl" })).ok, false);
  assert.equal(read(p({ model: "   " })).ok, false);
  const trimmedRes = read(p({ model: "  jev-internal  " }));
  assert.ok(trimmedRes.ok && trimmedRes.config.providers[0]!.model === "jev-internal");
  // The pin deviation is surfaced whenever typesafe is in play.
  assert.ok(viaEnv.ok && viaEnv.warnings.some((w) => w.includes("jev-1.13.0")));
});

test("round 2: capability names validated; chain secrets feed the credential scan", async () => {
  assert.equal(parseJevChainConfig([spec("a")], { compaction: [spec("b")] }).ok, false);
  assert.equal(parseJevChainConfig([spec("a")], { compact: [spec("b")] }).ok, true);
  const resolved = resolveChain([spec("a"), spec("b"), spec("c", { keyEnv: undefined })], { env: { A_KEY: "zz-key-a-1", B_KEY: "zz-key-b-2" } });
  const secrets = chainSecrets(resolved);
  assert.equal(secrets.length, 2);
  assert.equal(containsCredential("prompt with zz-key-b-2 inside", [undefined, ...secrets]), true);
  assert.equal(containsCredential("clean prompt", [undefined, ...secrets]), false);
  assert.equal(containsCredential("old zz-key-a-1", "zz-key-a-1"), true);
});
