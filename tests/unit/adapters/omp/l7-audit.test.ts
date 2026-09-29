/**
 * L7 (found on real omp): C11 audit must carry stop and approval decisions, not only
 * jev_plan and effort. Fake OMP host, fake Jev (injected fetch), in-memory audit writer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import type { OmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler } from "../../../../src/adapters/omp/types.ts";
import type { AuditInput } from "../../../../src/telemetry/audit.ts";

function setup(config: Record<string, unknown>) {
  const handlers = new Map<string, OmpHandler[]>();
  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}), getSessionId: () => "s-l7", getLeafId: () => "leaf", getBranch: () => [], getCwd: () => "/tmp" },
    getContextUsage: () => ({ percent: null }),
    ui: { notify: () => {} },
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
    isIdle: () => true,
    compact: () => {},
  } as unknown as OmpContext;
  const api = {
    pi: { VERSION: "18.4.1" },
    on: (event: string, handler: OmpHandler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: () => {},
    registerTool: () => {},
    getAllTools: () => [{ name: "bash", description: "Run", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["bash"],
    getCommands: () => [],
    getThinkingLevel: () => undefined,
    setActiveTools: async () => {},
    setModel: () => true,
    setThinkingLevel: () => {},
  } as unknown as OmpExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler({ type: event, ...payload }, ctx));
    return out;
  };
  const audit: AuditInput[] = [];
  const fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    return new Response(JSON.stringify({ model: body.model, answers: {} }), { status: 503 });
  }) as typeof globalThis.fetch;
  const overrides: Partial<OmpHostDeps> = {
    env: { TYPESAFE_API_KEY: "fake-typesafe-key-l7" },
    loadConfig: () => loadOmpConfig({ home: "/nonexistent-home", path: "/x/config.json", env: {}, readText: async () => JSON.stringify({ effort: "off", ...config }) }),
    fetch,
    createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    createAudit: () => ({ record: async (input) => { audit.push(input); return true; }, flush: async () => {}, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    readPluginsLock: () => undefined,
    loadLegacyConfig: async () => ({ dir: "" }),
  };
  const registry = {};
  createExtension(overrides, registry)(api);
  const host = (registry as Record<symbol, { host: { settled(): Promise<void> } }>)[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  return { emit, audit, settled: () => host.settled() };
}

const ON = { mode: "on", outbound: { taskIntent: true }, router: { tools: "off" }, budget: { maxRequestsPerTask: 4, waitMs: 2000 } };

test("approval no-UI deny writes one approval audit line (tool_call, denied)", async () => {
  const s = setup({ ...ON, approval: { enabled: true, noUi: "deny", denyTools: ["bash"] } });
  await s.emit("session_start");
  await s.emit("before_agent_start", { prompt: "run a command" });
  const [result] = await s.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "echo hi" } });
  assert.equal((result as { block?: boolean }).block, true);
  await s.settled();
  const lines = s.audit.filter((a) => a.kind === "approval");
  assert.equal(lines.length, 1, JSON.stringify(s.audit));
  assert.equal(lines[0]!.event, "tool_call");
  assert.equal(lines[0]!.outcome, "denied");
  assert.equal(lines[0]!.mode, "on");
  await s.emit("session_shutdown");
});

test("session_stop in mode on writes one stop audit line with the continuation counts", async () => {
  const s = setup({ ...ON, harness: { continuation: { enabled: true, max: 2 } } });
  await s.emit("session_start");
  await s.emit("before_agent_start", { prompt: "fix the bug" });
  await s.emit("session_stop", { messages: [], stop_hook_active: false });
  await s.settled();
  const lines = s.audit.filter((a) => a.kind === "stop");
  assert.equal(lines.length, 1, JSON.stringify(s.audit));
  assert.equal(lines[0]!.event, "settle");
  assert.equal(lines[0]!.mode, "on");
  assert.deepEqual(lines[0]!.metrics, { continues: 0, maxContinues: 2 });
  await s.emit("session_shutdown");
});
