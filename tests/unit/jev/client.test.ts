import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createJevClient,
  choiceBody,
  type ChoiceQuestion,
  type JevAttempt,
  type JevProfile,
  type NoulQuestion,
} from "../../../src/jev/index.ts";

const MODEL = "jev-1.13.0";
const KEY = "sk-test-key-123";
const SECRET = "provider-said: leaked-credential sk-live-XYZ user data";
const route: ChoiceQuestion = {
  id: "route",
  question: "Which tool fits?",
  options: [
    { id: "read", description: "Read a file" },
    { id: "edit", description: "Edit a file" },
  ],
};
const noulQuestions: NoulQuestion[] = [{ id: "safe", question: "Safe?" }];
const validChoice = JSON.stringify({
  model: MODEL,
  answers: { route: { type: "choice", choice: "read", confidence: 0.8, probabilities: { read: 0.8, edit: 0.2 } } },
});

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
interface FakeServer {
  url: string;
  requests: { headers: IncomingMessage["headers"]; body: string }[];
  /** Resolves when the first response connection closes (client finished or cancelled). */
  firstClose: Promise<void>;
  close(): Promise<void>;
}

/** ES2022 lib (tsconfig target) lacks Promise.withResolvers. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** Local fake Jev: records every received request and signals response close. */
async function fakeServer(handler: Handler): Promise<FakeServer> {
  const closed = deferred();
  const requests: FakeServer["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ headers: req.headers, body });
      res.on("close", () => closed.resolve());
      handler(req, res, body);
    });
  });
  const listening = deferred();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`,
    requests,
    firstClose: closed.promise,
    close() {
      const done = deferred();
      server.closeAllConnections();
      server.close(() => done.resolve());
      return done.promise;
    },
  };
}

/** Counts physical fetch dispatches independently of the server. */
function countingFetch() {
  const counter = { calls: 0 };
  const wrapped = ((input, init) => {
    counter.calls++;
    return fetch(input, init);
  }) as typeof fetch;
  return { counter, fetch: wrapped };
}

function setup(url: string, profile: Partial<JevProfile> = {}, fetchImpl: typeof fetch = fetch) {
  const attempts: JevAttempt[] = [];
  let clock = 1_000;
  let ids = 0;
  const client = createJevClient({
    profile: { id: "test", url, model: MODEL, timeoutMs: 2_000, maxResponseBytes: 64_000, maxRequestBytes: 64_000, ...profile },
    key: KEY,
    fetch: fetchImpl,
    now: () => (clock += 5),
    newId: () => `a${++ids}`,
    onAttempt: (attempt) => attempts.push(attempt),
  });
  return { client, attempts };
}

const json = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};

test("choice sends one whitelisted request and returns evidence with one attempt", async (t) => {
  const server = await fakeServer((_req, res) => json(res, 200, validChoice));
  t.after(() => server.close());
  const { client, attempts } = setup(server.url);

  const result = await client.choice([route], { decisionId: "d1", state: { task: "fix bug" } });

  assert.deepEqual(result, {
    ok: true,
    evidence: [{ questionId: "route", model: MODEL, choice: "read", confidence: 0.8, probabilities: { read: 0.8, edit: 0.2 } }],
    attempt: attempts[0],
  });
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0]!.body, choiceBody(MODEL, { task: "fix bug" }, [route]));
  assert.equal(server.requests[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(attempts, [
    {
      attemptId: "a1",
      decisionId: "d1",
      startedAt: 1_005,
      durationMs: 5,
      status: "ok",
      httpStatus: 200,
      requestBytes: Buffer.byteLength(server.requests[0]!.body),
      responseBytes: Buffer.byteLength(validChoice),
    },
  ]);
});

test("noul batch round trip", async (t) => {
  const body = JSON.stringify({ model: MODEL, answers: { safe: { type: "noul", noul: 0.25 } } });
  const server = await fakeServer((_req, res) => json(res, 200, body));
  t.after(() => server.close());
  const { client } = setup(server.url);
  const result = await client.noul(noulQuestions, { decisionId: "d", state: "s" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.evidence, [{ questionId: "safe", model: MODEL, yes: 0.25 }]);
  assert.deepEqual(JSON.parse(server.requests[0]!.body).questions, { safe: { type: "noul", instructions: "Safe?" } });
});

test("HTTP 4xx/5xx yield category only; provider error text never reaches the result", async (t) => {
  for (const status of [400, 401, 402, 429, 500, 503]) {
    const server = await fakeServer((_req, res) => json(res, status, JSON.stringify({ error: SECRET })));
    t.after(() => server.close());
    const { client, attempts } = setup(server.url);
    const result = await client.choice([route], { decisionId: "d", state: "s" });
    assert.deepEqual(result.ok ? null : result.error, { kind: "http_error", httpStatus: status });
    assert.equal(attempts[0]!.status, "http_error");
    assert.equal(attempts[0]!.httpStatus, status);
    const serialized = JSON.stringify({ result, attempts });
    assert.ok(!serialized.includes("leaked-credential"), `status ${status} leaked provider text`);
    assert.ok(!serialized.includes(KEY), `status ${status} leaked key`);
    assert.equal(server.requests.length, 1);
  }
});

test("malformed JSON and off-contract answers become malformed with wire category", async (t) => {
  const bodies = [
    "not json " + SECRET,
    JSON.stringify({ model: "jev-latest", answers: { route: { type: "choice", choice: "read", confidence: 1, probabilities: { read: 1, edit: 0 } } } }),
    JSON.stringify({ model: MODEL, answers: { route: { type: "choice", choice: "read", confidence: 1, probabilities: { read: 0.5, edit: 0.3 } } } }),
    "",
  ];
  let i = 0;
  const server = await fakeServer((_req, res) => json(res, 200, bodies[i++]!));
  t.after(() => server.close());
  const { client, attempts } = setup(server.url);
  const errors = [];
  for (let n = 0; n < bodies.length; n++) {
    const result = await client.choice([route], { decisionId: `d${n}`, state: "s" });
    errors.push(result.ok ? null : result.error);
  }
  assert.deepEqual(errors, [
    { kind: "malformed" },
    { kind: "malformed", wire: { kind: "model_mismatch" } },
    { kind: "malformed", wire: { kind: "probability_sum", questionId: "route" } },
    { kind: "malformed" },
  ]);
  assert.deepEqual(attempts.map((a) => a.status), ["malformed", "malformed", "malformed", "malformed"]);
  assert.ok(!JSON.stringify(errors).includes("leaked-credential"));
});

// Real timers on purpose: the client's deadline is a platform timer racing real socket I/O.
test("deadline covers a body that streams slowly", { timeout: 5_000 }, async (t) => {
  const server = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"model":');
    const drip = setInterval(() => res.write(" "), 20);
    res.on("close", () => clearInterval(drip));
  });
  t.after(() => server.close());
  const { client, attempts } = setup(server.url, { timeoutMs: 200 });
  const started = performance.now();
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  const elapsed = performance.now() - started;
  assert.deepEqual(result.ok ? null : result.error, { kind: "timeout", httpStatus: 200 });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.status, "timeout");
  assert.ok(attempts[0]!.responseBytes > 0);
  assert.ok(elapsed < 1_000, `took ${elapsed}ms`);
  await server.firstClose; // resolves only once the client cancelled the stream
});

test("deadline covers a server that never sends headers", async (t) => {
  const server = await fakeServer(() => {});
  t.after(() => server.close());
  const { client, attempts } = setup(server.url, { timeoutMs: 150 });
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  assert.deepEqual(result.ok ? null : result.error, { kind: "timeout" });
  assert.equal(attempts.length, 1);
  assert.equal(server.requests.length, 1);
});

test("deadline holds even when an injected fetch ignores abort", async () => {
  let calls = 0;
  const stuck = (() => {
    calls++;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const { client, attempts } = setup("http://unused.invalid/", { timeoutMs: 100 }, stuck);
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  assert.deepEqual(result.ok ? null : result.error, { kind: "timeout" });
  assert.equal(calls, 1);
  assert.equal(attempts[0]!.status, "timeout");
});

test("streamed response over the limit is cancelled immediately", { timeout: 5_000 }, async (t) => {
  const server = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const flood = setInterval(() => res.write("x".repeat(512)), 5);
    res.on("close", () => clearInterval(flood));
  });
  t.after(() => server.close());
  const { client, attempts } = setup(server.url, { maxResponseBytes: 2_000 });
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  assert.deepEqual(result.ok ? null : result.error, { kind: "too_large", httpStatus: 200 });
  assert.equal(attempts[0]!.status, "too_large");
  assert.ok(attempts[0]!.responseBytes > 2_000 && attempts[0]!.responseBytes <= 2_000 + 64 * 1024);
  await server.firstClose; // resolves only once the client cancelled the stream
});

test("declared content-length over the limit is rejected before reading", async (t) => {
  const big = JSON.stringify({ model: MODEL, pad: "x".repeat(5_000) });
  const server = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(big) });
    res.end(big);
  });
  t.after(() => server.close());
  const { client, attempts } = setup(server.url, { maxResponseBytes: 1_000 });
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  assert.deepEqual(result.ok ? null : result.error, { kind: "too_large", httpStatus: 200 });
  assert.equal(attempts[0]!.responseBytes, 0);
});

test("pre-cancelled call sends zero requests and records no attempt", async (t) => {
  const server = await fakeServer((_req, res) => json(res, 200, validChoice));
  t.after(() => server.close());
  const counting = countingFetch();
  const { client, attempts } = setup(server.url, {}, counting.fetch);
  const controller = new AbortController();
  controller.abort();
  const result = await client.choice([route], { decisionId: "d", state: "s", signal: controller.signal });
  assert.deepEqual(result, { ok: false, error: { kind: "aborted" } });
  assert.equal(counting.counter.calls, 0);
  assert.equal(server.requests.length, 0);
  assert.equal(attempts.length, 0);
});

test("request over maxRequestBytes and invalid questions send zero requests", async (t) => {
  const server = await fakeServer((_req, res) => json(res, 200, validChoice));
  t.after(() => server.close());
  const counting = countingFetch();
  const { client, attempts } = setup(server.url, { maxRequestBytes: 100 }, counting.fetch);
  const tooBig = await client.choice([route], { decisionId: "d", state: "x".repeat(200) });
  assert.deepEqual(tooBig, { ok: false, error: { kind: "request_too_large" } });
  const dupOptions = { ...route, options: [route.options[0]!, route.options[0]!] };
  assert.deepEqual(await client.choice([dupOptions], { decisionId: "d", state: "" }), { ok: false, error: { kind: "invalid_request" } });
  assert.deepEqual(await client.noul([], { decisionId: "d", state: "" }), { ok: false, error: { kind: "invalid_request" } });
  assert.equal(counting.counter.calls, 0);
  assert.equal(server.requests.length, 0);
  assert.equal(attempts.length, 0);
});

test("cancel during the body read aborts and cancels the stream", { timeout: 5_000 }, async (t) => {
  const server = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  t.after(() => server.close());
  const reading = deferred();
  // Wraps the real body so the test learns when the client pulls it, i.e. is inside the body read.
  const observed = (async (input, init) => {
    const response = await fetch(input, init);
    const source = response.body!.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading.resolve();
        const chunk = await source.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel: (reason) => source.cancel(reason),
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  const { client, attempts } = setup(server.url, {}, observed);
  const controller = new AbortController();
  const pending = client.choice([route], { decisionId: "d", state: "s", signal: controller.signal });
  await reading.promise;
  controller.abort();
  const result = await pending;
  assert.deepEqual(result.ok ? null : result.error, { kind: "aborted", httpStatus: 200 });
  assert.equal(attempts[0]!.status, "aborted");
  await server.firstClose; // resolves only once the client cancelled the stream
});

test("cancel after return changes nothing and sends nothing", async (t) => {
  const server = await fakeServer((_req, res) => json(res, 200, validChoice));
  t.after(() => server.close());
  const { client, attempts } = setup(server.url);
  const controller = new AbortController();
  const result = await client.choice([route], { decisionId: "d", state: "s", signal: controller.signal });
  const snapshot = structuredClone(result);
  controller.abort();
  assert.equal(result.ok, true);
  assert.deepEqual(result, snapshot);
  assert.equal(server.requests.length, 1);
  assert.equal(attempts.length, 1);
});

test("network failure is a category, not the raw error", async () => {
  const server = await fakeServer(() => {});
  const url = server.url;
  await server.close();
  const { client, attempts } = setup(url);
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  assert.deepEqual(result.ok ? null : result.error, { kind: "network_error" });
  assert.equal(attempts[0]!.status, "network_error");
});

test("one attempt per physical request across mixed outcomes; no automatic retry", async (t) => {
  const plan: Handler[] = [
    (_req, res) => json(res, 200, validChoice),
    (_req, res) => json(res, 503, SECRET),
    (_req, res) => json(res, 200, "{"),
    () => {},
    (_req, res) => json(res, 200, validChoice),
  ];
  let i = 0;
  const server = await fakeServer((req, res, body) => plan[i++]!(req, res, body));
  t.after(() => server.close());
  const { client, attempts } = setup(server.url, { timeoutMs: 150 });
  const statuses = [];
  for (let n = 0; n < plan.length; n++) {
    const result = await client.choice([route], { decisionId: `d${n}`, state: { n } });
    statuses.push(result.ok ? "ok" : result.error.kind);
  }
  assert.deepEqual(statuses, ["ok", "http_error", "malformed", "timeout", "ok"]);
  assert.equal(attempts.length, server.requests.length);
  assert.equal(attempts.length, plan.length);
  assert.deepEqual(attempts.map((a) => a.decisionId), ["d0", "d1", "d2", "d3", "d4"]);
  assert.equal(new Set(attempts.map((a) => a.attemptId)).size, attempts.length);
  assert.deepEqual(
    attempts.map((a) => a.requestBytes),
    server.requests.map((r) => Buffer.byteLength(r.body)),
  );
});

test("a throwing onAttempt cannot change the result", async (t) => {
  const server = await fakeServer((_req, res) => json(res, 200, validChoice));
  t.after(() => server.close());
  const client = createJevClient({
    profile: { id: "t", url: server.url, model: MODEL, timeoutMs: 2_000, maxResponseBytes: 64_000, maxRequestBytes: 64_000 },
    key: KEY,
    fetch,
    now: () => 0,
    newId: () => "a",
    onAttempt: () => {
      throw new Error("sink down");
    },
  });
  const result = await client.choice([route], { decisionId: "d", state: "s" });
  assert.equal(result.ok, true);
});

/** Holds fetch until `release()` so the test can mutate caller-owned inputs mid-flight. */
function gatedFetch() {
  const started = deferred();
  const gate = deferred();
  const wrapped = (async (input, init) => {
    started.resolve();
    await gate.promise;
    return fetch(input, init);
  }) as typeof fetch;
  return { started: started.promise, release: gate.resolve, fetch: wrapped };
}

function snapshotClient(profile: JevProfile, fetchImpl: typeof fetch) {
  return createJevClient({ profile, key: KEY, fetch: fetchImpl, now: () => 1, newId: () => "a1" });
}

test("mutating questions and profile.model during fetch cannot validate a different contract", async (t) => {
  const server = await fakeServer((_req, res) =>
    json(
      res,
      200,
      JSON.stringify({
        model: "other-model",
        answers: { route: { type: "choice", choice: "read", confidence: 0.8, probabilities: { read: 0.8, delete: 0.2 } } },
      }),
    ),
  );
  t.after(() => server.close());
  const gated = gatedFetch();
  const profile: JevProfile = { id: "test", url: server.url, model: MODEL, timeoutMs: 2_000, maxResponseBytes: 64_000, maxRequestBytes: 64_000 };
  const question: ChoiceQuestion = structuredClone(route);
  const client = snapshotClient(profile, gated.fetch);

  const pending = client.choice([question], { decisionId: "d1", state: "s" });
  await gated.started;
  question.options[1]!.id = "delete";
  profile.model = "other-model";
  gated.release();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, "malformed");
  assert.equal(server.requests[0]!.body, choiceBody(MODEL, "s", [route]));
});

test("shrinking profile.maxResponseBytes during fetch keeps the snapshot limit", async (t) => {
  const server = await fakeServer((_req, res) => json(res, 200, validChoice));
  t.after(() => server.close());
  const gated = gatedFetch();
  const profile: JevProfile = { id: "test", url: server.url, model: MODEL, timeoutMs: 2_000, maxResponseBytes: 64_000, maxRequestBytes: 64_000 };
  const client = snapshotClient(profile, gated.fetch);

  const pending = client.choice([route], { decisionId: "d1", state: "s" });
  await gated.started;
  profile.maxResponseBytes = 1;
  gated.release();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.attempt?.responseBytes, Buffer.byteLength(validChoice));
});
