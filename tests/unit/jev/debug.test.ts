import assert from "node:assert/strict";
import test from "node:test";
import { createJevChainClient, createJevClient, resolveChain, type ChoiceQuestion, type JevDebugEvent } from "../../../src/jev/index.ts";

const question: ChoiceQuestion = { id: "route", question: "Choose a tool", options: [{ id: "read", description: "Read" }, { id: "edit", description: "Edit" }] };
const answer = { model: "jev-1.13.0", answers: { route: { type: "choice", choice: "read", confidence: 0.8, probabilities: { read: 0.8, edit: 0.2 } } } };
const profile = { id: "primary", url: "https://primary.test/v1", model: "jev-1.13.0", timeoutMs: 1000, maxRequestBytes: 64000, maxResponseBytes: 64000 };

test("debug events correlate one physical request and response with exact wire bodies", async () => {
  const events: JevDebugEvent[] = [];
  let wireBody = "";
  const client = createJevClient({
    profile, key: "secret-key", now: () => 100, newId: () => "attempt-1",
    fetch: (async (_url, init) => { wireBody = String(init?.body); return new Response(JSON.stringify(answer), { status: 200 }); }) as typeof fetch,
    onDebug: (event) => events.push(event),
  });
  const result = await client.choice([question], { decisionId: "decision-1", state: { task: "sensitive task" } });
  assert.equal(result.ok, true);
  assert.equal(events.length, 2);
  const [req, resp] = events;
  assert.equal(req?.phase, "req");
  assert.equal(resp?.phase, "resp");
  assert.equal(req?.attemptId, resp?.attemptId);
  assert.equal(req?.decisionId, "decision-1");
  assert.equal(resp?.decisionId, "decision-1");
  assert.equal(req?.providerId, "primary");
  assert.equal(resp?.providerId, "primary");
  assert.equal(req?.model, profile.model);
  assert.equal(resp?.model, profile.model);
  assert.equal(req?.url, profile.url);
  assert.equal(resp?.url, profile.url);
  if (req?.phase !== "req" || resp?.phase !== "resp") throw new Error("incorrect debug event phases");
  assert.equal(req.body, wireBody);
  assert.deepEqual(JSON.parse(req.body).state, { task: "sensitive task" });
  assert.deepEqual(resp.body, answer);
  assert.equal(resp.httpStatus, 200);
  assert.equal(resp.status, "ok");
  assert.equal(resp.durationMs, 0);
  assert.ok(!JSON.stringify(events).includes("secret-key"));
});

test("fallback emits paired physical events per provider, not one pair per logical call", async () => {
  const events: JevDebugEvent[] = [];
  const calls: string[] = [];
  const providers = resolveChain([
    { id: "first", url: "https://first.test/v1", model: profile.model, identity: "exact", timeoutMs: 1000 },
    { id: "second", url: "https://second.test/v1", model: profile.model, identity: "exact", timeoutMs: 1000 },
  ], { env: {} });
  let nextId = 0;
  const client = createJevChainClient({ providers, waitMs: 2000, now: Date.now, newId: () => `attempt-${++nextId}`,
    fetch: (async (url) => {
      const host = new URL(String(url)).host;
      calls.push(host);
      return host === "first.test" ? new Response("upstream down", { status: 503 }) : new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch,
    onDebug: (event) => events.push(event),
  });
  const result = await client.choice([question], { decisionId: "decision-1", state: "task" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["first.test", "second.test"]);
  assert.deepEqual(events.map((event) => [event.phase, event.providerId]), [["req", "first"], ["resp", "first"], ["req", "second"], ["resp", "second"]]);
  assert.equal(events[0]?.attemptId, events[1]?.attemptId);
  assert.equal(events[2]?.attemptId, events[3]?.attemptId);
  assert.notEqual(events[0]?.attemptId, events[2]?.attemptId);
  assert.equal(events[1]?.phase, "resp");
  if (events[1]?.phase === "resp") {
    assert.equal(events[1].httpStatus, 503);
    assert.equal(events[1].body, undefined, "non-successful response body is not parsed or debugged");
  }
});

test("throwing debug observers do not alter Jev response or subsequent event delivery", async () => {
  const phases: string[] = [];
  const client = createJevClient({ profile, key: undefined, now: Date.now, newId: () => "attempt-1",
    fetch: (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch,
    onDebug: (event) => { phases.push(event.phase); throw new Error("observer failure"); },
  });
  const result = await client.choice([question], { decisionId: "decision-1", state: "task" });
  assert.equal(result.ok, true);
  assert.deepEqual(phases, ["req", "resp"]);
});

test("debug redacts configured credential from URL and both bodies without changing wire transport", async () => {
  const key = "sensitive-key";
  const events: JevDebugEvent[] = [];
  let actualUrl = "";
  let actualBody = "";
  const client = createJevClient({
    profile: { ...profile, url: `https://user:${key}@primary.test/${key}?token=${key}#${key}` }, key,
    now: Date.now, newId: () => `attempt-${key}`,
    fetch: (async (url, init) => {
      actualUrl = String(url);
      actualBody = String(init?.body);
      return new Response(JSON.stringify({ ...answer, extra: key }), { status: 200 });
    }) as typeof fetch,
    onDebug: (event) => events.push(event),
  });
  const result = await client.choice([question], { decisionId: `decision-${key}`, state: { task: key } });
  assert.equal(result.ok, true);
  assert.ok(actualUrl.includes(key));
  assert.ok(actualBody.includes(key));
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(events).includes(key));
  assert.ok(!events[0]!.url.includes("?"));
  assert.ok(!events[0]!.url.includes("#"));
  assert.ok(!events[0]!.url.includes("@"));
  assert.ok(JSON.stringify(events).includes("[REDACTED]"));
});
