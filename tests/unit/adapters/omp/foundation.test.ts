/**
 * foundation: OMP directories, config `mode: "on"` opt-in, legacy plugin conflict, host port.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyToolSet } from "../../../../src/adapters/core/port.ts";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { isOwnPath, lockConflict, ompPluginsLockPath, OWN_COMMAND_DESCRIPTION, PACKAGE_ROOT, runtimeConflict } from "../../../../src/adapters/omp/legacy.ts";
import { createOmpPort, ompSessionView } from "../../../../src/adapters/omp/port.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolInfo } from "../../../../src/adapters/omp/types.ts";
import { loadConfig } from "../../../../src/adapters/shared/index.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

const ENOENT = async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); };

// ---- item 3: directories ---------------------------------------------------------------------

test("OMP defaults runsDir, context.storeDir and telemetry under ~/.omp/agent/pi-jev-harness", async () => {
  const result = await loadOmpConfig({ home: "/h", env: {}, readText: ENOENT });
  const dir = "/h/.omp/agent/pi-jev-harness";
  assert.equal(result.config.harness.runsDir, join(dir, "runs"));
  assert.equal(result.config.context.storeDir, join(dir, "context"));
  assert.equal(result.config.telemetryDir, join(dir, "telemetry"));
  assert.ok(!JSON.stringify(result.config).includes(".pi/"), JSON.stringify(result.config));
});

test("OMP file values and PI_JEV_RUNS_DIR still override the OMP defaults", async () => {
  const file = await loadOmpConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ harness: { runsDir: "/r" }, context: { storeDir: "/s" } }) });
  assert.equal(file.config.harness.runsDir, "/r");
  assert.equal(file.config.context.storeDir, "/s");
  const env = await loadOmpConfig({ home: "/h", env: { PI_JEV_RUNS_DIR: "/e" }, readText: ENOENT });
  assert.equal(env.config.harness.runsDir, "/e");
});

test("Pi defaults stay under ~/.pi", async () => {
  const result = await loadConfig({ home: "/h", env: {}, readText: ENOENT });
  assert.equal(result.config.harness.runsDir, "/h/.pi/agent/pi-jev-harness/runs");
  assert.equal(result.config.context.storeDir, "/h/.pi/agent/pi-jev-harness/context");
  assert.equal(result.path, "/h/.pi/agent/pi-jev-harness/config.json");
});

// ---- item 4: mode on opt-in ------------------------------------------------------------------

test("config mode on: OMP parses it, Pi still rejects it", async () => {
  const readText = async () => JSON.stringify({ mode: "on" });
  const omp = await loadOmpConfig({ home: "/h", env: {}, readText });
  assert.equal(omp.source, "file");
  assert.equal(omp.config.mode, "on");
  const pi = await loadConfig({ home: "/h", env: {}, readText });
  assert.equal(pi.source, "invalid");
  assert.equal(pi.config.mode, "off");
  assert.match(pi.reason ?? "", /mode on has not passed/);
  const bogus = await loadOmpConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ mode: "yes" }) });
  assert.equal(bogus.source, "invalid");
});

// ---- item 5: legacy conflict -----------------------------------------------------------------

const LOCK_ON = JSON.stringify({ plugins: { "@omp-jev/harness": { version: "0.1.0", enabled: true } } });
const LOCK_OFF = JSON.stringify({ plugins: { "@omp-jev/harness": { version: "0.1.0", enabled: false } } });

test("lockConflict: enabled legacy plugin only; missing/unreadable/garbled lock is no conflict", () => {
  assert.match(lockConflict(() => LOCK_ON) ?? "", /@omp-jev\/harness enabled/);
  assert.equal(lockConflict(() => LOCK_OFF), undefined);
  assert.equal(lockConflict(() => JSON.stringify({ plugins: {} })), undefined);
  assert.equal(lockConflict(() => undefined), undefined);
  assert.equal(lockConflict(() => "{broken"), undefined);
  assert.equal(lockConflict(() => { throw new Error("EACCES"); }), undefined);
});

test("runtimeConflict: non-own jev_acceptance_gate or a /jev that is not ours", () => {
  const own: OmpToolInfo = { name: "jev_acceptance_gate", sourceInfo: { path: join(PACKAGE_ROOT, "src/adapters/omp/index.ts") } };
  const foreign: OmpToolInfo = { name: "jev_acceptance_gate", sourceInfo: { path: "/elsewhere/jev-harness/index.ts" } };
  const ours = { name: "jev", description: OWN_COMMAND_DESCRIPTION };
  assert.equal(runtimeConflict([own], [ours], true), undefined);
  assert.match(runtimeConflict([foreign], [], true) ?? "", /non-own jev_acceptance_gate/);
  assert.match(runtimeConflict([{ name: "jev_acceptance_gate", sourceInfo: { path: "<extension:jev_acceptance_gate>" } }], [], true) ?? "", /non-own/);
  // Map semantics: one row per name, the later loader's description wins.
  assert.match(runtimeConflict([], [{ name: "jev", description: "legacy" }], true) ?? "", /non-own \/jev/);
  assert.match(runtimeConflict([], [ours], false) ?? "", /non-own \/jev/);
  assert.equal(runtimeConflict(undefined, undefined, true), undefined);
});

test("ownership through a symlinked package root (omp plugin link) compares realpaths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-l1-link-"));
  try {
    const realRoot = join(dir, "real", "pi-jev-harness");
    await mkdir(join(realRoot, "src", "adapters", "omp"), { recursive: true });
    await writeFile(join(realRoot, "src", "adapters", "omp", "index.ts"), "");
    const linked = join(dir, "plugins", "node_modules", "pi-jev-harness");
    await mkdir(join(dir, "plugins", "node_modules"), { recursive: true });
    await symlink(realRoot, linked);
    const viaLink = join(linked, "src", "adapters", "omp", "index.ts");
    const viaReal = join(realRoot, "src", "adapters", "omp", "index.ts");
    assert.equal(isOwnPath(viaLink, realRoot), true);
    assert.equal(isOwnPath(viaReal, linked), true);
    assert.equal(runtimeConflict([{ name: "jev_acceptance_gate", sourceInfo: { path: viaLink } }], [], true, realRoot), undefined);
    assert.equal(isOwnPath(join(dir, "other", "index.ts"), linked), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugins lock path resolves like OMP getPluginsLockfile (PI_CONFIG_DIR, profile, XDG)", () => {
  const none = () => false;
  assert.equal(ompPluginsLockPath("/h", {}, "darwin", none), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { PI_CONFIG_DIR: ".omp-dev" }, "darwin", none), "/h/.omp-dev/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "work" }, "darwin", none), "/h/.omp/profiles/work/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { PI_PROFILE: "old" }, "darwin", none), "/h/.omp/profiles/old/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "", PI_PROFILE: "old" }, "darwin", none), "/h/.omp/plugins/omp-plugins.lock.json");
  const xdg = (path: string) => path === "/x/omp";
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x" }, "linux", xdg), "/x/omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x" }, "linux", none), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x" }, "win32", xdg), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x", PI_CODING_AGENT_DIR: "/elsewhere" }, "linux", xdg), "/h/.omp/plugins/omp-plugins.lock.json");
});

interface Fake {
  api: OmpExtensionAPI;
  ctx: OmpContext;
  handlers: Map<string, OmpHandler[]>;
  commands: string[];
  notes: string[];
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

/** OMP 18.3.5 command list: a Map keyed by name, later registration wins; rows carry the description. */
function fakeHost(tools: OmpToolInfo[] = [], commandRows: Array<{ name: string; description?: string }> = []): Fake {
  const registry = new Map<string, { name: string; description?: string; source: "extension" }>(commandRows.map((row) => [row.name, { ...row, source: "extension" as const }]));
  const handlers = new Map<string, OmpHandler[]>();
  const commands: string[] = [];
  const notes: string[] = [];
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}) },
    getContextUsage: () => undefined,
    ui: { notify: (message) => { notes.push(message); } },
  };
  const api: OmpExtensionAPI = {
    pi: { VERSION: "18.3.5" },
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name, options) => { commands.push(name); registry.delete(name); registry.set(name, { name, ...(options.description ? { description: options.description } : {}), source: "extension" }); },
    registerTool: (tool) => { commands.push(`tool:${tool.name}`); },
    getAllTools: () => tools,
    getActiveTools: () => [],
    getCommands: () => [...registry.values()],
    getThinkingLevel: () => undefined,
    setActiveTools: () => {},
    setModel: () => true,
    setThinkingLevel: () => {},
  };
  return {
    api, ctx, handlers, commands, notes,
    async emit(event, payload = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
      return results;
    },
  };
}

function load(host: Fake, lock: string | undefined, config: Record<string, unknown> = { mode: "shadow", outbound: { taskIntent: true } }) {
  const events: TelemetryInput[] = [];
  const registry: Record<symbol, { host: { statusText(): string; canRegister(name: string): boolean } }> = {};
  let requests = 0;
  const extension = createExtension({
    env: { TYPESAFE_API_KEY: "k" },
    loadConfig: () => loadOmpConfig({ home: "/h", env: {}, readText: async () => JSON.stringify(config) }),
    fetch: (async () => { requests++; throw new Error("no network"); }) as typeof fetch,
    readPluginsLock: () => lock,
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
  }, registry as never);
  extension(host.api);
  const claim = () => registry[Symbol.for("pi-jev-harness.adapter.omp")]!.host;
  return { events, claim, requests: () => requests };
}

test("legacy enabled in plugins lock: /jev not registered, forced off, diagnostic + status line", async () => {
  const host = fakeHost();
  const s = load(host, LOCK_ON);
  // Load-time conflict: none of our tools (jev_plan included) and no /jev.
  assert.deepEqual(host.commands, []);
  assert.equal(s.claim().canRegister("jev_acceptance_gate"), false);
  assert.equal(s.claim().canRegister("jev"), false);
  assert.equal(s.claim().canRegister("jev_plan"), true);
  await host.emit("session_start");
  await host.emit("before_agent_start", { prompt: "List the files in src" });
  const status = s.claim().statusText();
  assert.match(status, /^Jev: off/);
  assert.match(status, /legacy conflict: @omp-jev\/harness enabled in plugins lock; forced off/);
  assert.equal(s.requests(), 0);
  assert.ok(s.events.some((event) => event.kind === "diagnostic" && event.source === "adapter:legacy_conflict"), JSON.stringify(s.events));
  await host.emit("session_shutdown");
});

test("non-own jev_acceptance_gate at session_start: forced off with diagnostic", async () => {
  const host = fakeHost([{ name: "jev_acceptance_gate", sourceInfo: { path: "/legacy/jev-harness/index.ts", source: "extension" } }]);
  const s = load(host, undefined);
-  // The fake exposes tool registries during load; a conflicting legacy tool is detected immediately.
-  assert.deepEqual(host.commands, []);
  await host.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: off[\s\S]*legacy conflict: non-own jev_acceptance_gate/);
  assert.ok(s.events.some((event) => event.source === "adapter:legacy_conflict"));
  await host.emit("session_shutdown");
});

test("/jev already registered at load: ours not registered, forced off", async () => {
  const host = fakeHost([], [{ name: "jev", description: "legacy" }]);
  const s = load(host, undefined);
  assert.deepEqual(host.commands, []);
  await host.emit("session_start");
  assert.match(s.claim().statusText(), /legacy conflict: non-own \/jev command/);
  await host.emit("session_shutdown");
});

test("no legacy: shadow as before, no conflict diagnostic", async () => {
  const host = fakeHost();
  const s = load(host, LOCK_OFF);
  await host.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: shadow/);
  assert.doesNotMatch(s.claim().statusText(), /legacy conflict/);
  assert.ok(!s.events.some((event) => event.source === "adapter:legacy_conflict"));
  await host.emit("session_shutdown");
});

test("config mode on under OMP: parsed, session runs in on with the L2 capability lines (T105 L2)", async () => {
  const host = fakeHost();
  const s = load(host, undefined, { mode: "on", outbound: { taskIntent: true } });
  await host.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: on[\s\S]*tools apply:[\s\S]*enforce: none[\s\S]*approval: off/);
  assert.match(s.claim().statusText(), /^Jev: on/);
  assert.doesNotMatch(s.claim().statusText(), /not yet supported/);
  await host.emit("session_shutdown");
});

// ---- host port -------------------------------------------------------------------------------

test("OMP port: async setActiveTools is awaited before read-back; result shapes", async () => {
  let active = ["a", "b", "c"];
  let pending = false;
  const api = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { pending = true; return new Promise<void>((resolve) => setTimeout(() => { active = names; pending = false; resolve(); }, 5)); },
  } as unknown as OmpExtensionAPI;
  const port = createOmpPort(api);
  const applied = await applyToolSet(port, ["a", "b", "c"], ["a"]);
  assert.equal(pending, false);
  assert.deepEqual(applied, { ok: true, readBack: ["a"] });
  assert.deepEqual(port.blockResult("r"), { block: true, reason: "r" });
  assert.deepEqual(port.contextResult([1]), { messages: [1] });
  assert.deepEqual(port.continueResult({ prompt: "p" }, undefined as never), { continue: true, additionalContext: "p" });
});

test("applyToolSet restores the previous set on a read-back mismatch", async () => {
  let active = ["a", "b"];
  const port = { getActiveTools: () => (active.length === 1 ? ["x"] : [...active]), setActiveTools: (names: string[]) => { active = names; } };
  assert.deepEqual(await applyToolSet(port, ["a", "b"], ["a"]), { ok: false, readBack: ["x"], restored: true });
});

test("OMP session view: child session, pending work, confirm without UI", async () => {
  const base = fakeHost().ctx;
  const child = ompSessionView({ ...base, sessionManager: { getHeader: () => ({ parentSession: "/p.jsonl" }), getSessionId: () => "s1" } });
  assert.equal(child.isChildSession, true);
  assert.equal(child.parentSession, "/p.jsonl");
  assert.equal(child.sessionId, "s1");
  assert.equal(ompSessionView({ ...base, agent: { kind: "sub" } }).isChildSession, true);
  assert.equal(ompSessionView(base).isChildSession, false);
  assert.equal(ompSessionView({ ...base, hasPendingMessages: () => true }).hasPendingWork(), true);
  assert.equal(ompSessionView({ ...base, getAsyncJobSnapshot: () => ({ running: [{ id: "j" }], recent: [] }) }).hasPendingWork(), true);
  assert.equal(ompSessionView({ ...base, getAsyncJobSnapshot: () => null, hasPendingMessages: () => false }).hasPendingWork(), false);
  assert.equal(ompSessionView({ ...base, hasUI: false, ui: { notify() {}, confirm: async () => true } }).confirm("t", "m"), undefined);
  assert.equal(await ompSessionView({ ...base, hasUI: true, ui: { notify() {}, confirm: async () => true } }).confirm("t", "m"), true);
});
