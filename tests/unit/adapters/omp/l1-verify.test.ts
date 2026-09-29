/**
 * verification (verifier-added): Pi apply path stays synchronous, Pi/OMP real config entry
 * points, read-only lock check through the default deps, and legacy detection against a fake that
 * follows OMP 18.3.5 semantics (`getRegisteredCommands` keys commands by name, later wins; tool
 * `sourceInfo.path` is the registering extension's resolved entry).
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyToolSet } from "../../../../src/adapters/core/port.ts";
import { loadOmpConfig } from "../../../../src/adapters/omp/config.ts";
import { defaultOmpHostDeps } from "../../../../src/adapters/omp/host.ts";
import { createExtension } from "../../../../src/adapters/omp/index.ts";
import { isOwnPath, ompPluginsLockPath, PACKAGE_ROOT } from "../../../../src/adapters/omp/legacy.ts";
import type { OmpContext, OmpExtensionAPI, OmpHandler, OmpToolInfo } from "../../../../src/adapters/omp/types.ts";
import { defaultHostDeps } from "../../../../src/adapters/pi/host.ts";
import type { TelemetryInput } from "../../../../src/telemetry/index.ts";

// ---- Pi: apply / read-back / restore stays in one synchronous step ---------------------------

test("applyToolSet on a synchronous host: set, read-back, restore and re-read all run before the call returns", () => {
  const log: string[] = [];
  let active = ["a", "b", "c"];
  let reads = 0;
  const port = {
    getActiveTools: () => { log.push("get"); reads++; return reads === 1 ? ["x"] : [...active]; },
    setActiveTools: (names: string[]) => { log.push(`set:${names.join(",")}`); active = names; },
  };
  const pending = applyToolSet(port, ["a", "b", "c"], ["a"]);
  // Nothing awaited yet: the whole sequence already ran synchronously.
  assert.deepEqual(log, ["set:a", "get", "set:a,b,c", "get"]);
  return pending.then((result) => assert.deepEqual(result, { ok: false, readBack: ["x"], restored: true }));
});

test("applyToolSet on a synchronous host: a matching read-back never calls setActiveTools twice", async () => {
  const calls: string[][] = [];
  let active = ["a", "b"];
  const port = { getActiveTools: () => [...active], setActiveTools: (names: string[]) => { calls.push(names); active = names; } };
  assert.deepEqual(await applyToolSet(port, ["a", "b"], ["b"]), { ok: true, readBack: ["b"] });
  assert.deepEqual(calls, [["b"]]);
});

test("applyToolSet: a throwing host setter surfaces as a rejection (Pi host catch path still restores)", async () => {
  const port = { getActiveTools: () => ["a"], setActiveTools: () => { throw new Error("host"); } };
  await assert.rejects(applyToolSet(port, ["a", "b"], ["a"]), /host/);
});

// ---- Config through the real entry-point deps -------------------------------------------------

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "l1-verify-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = saved;
    await rm(home, { recursive: true, force: true });
  }
}

test("Pi default deps: config file mode on is still rejected (source invalid, mode off)", async () => {
  await withHome(async (home) => {
    const dir = join(home, ".pi", "agent", "pi-jev-harness");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ mode: "on" }));
    const loaded = await defaultHostDeps({ env: { HOME: home } }).loadConfig();
    assert.equal(loaded.source, "invalid");
    assert.equal(loaded.config.mode, "off");
  });
});

test("OMP default deps: config under ~/.omp/agent/pi-jev-harness, mode on accepted, every dir defaults there", async () => {
  await withHome(async (home) => {
    const dir = join(home, ".omp", "agent", "pi-jev-harness");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ mode: "on" }));
    const loaded = await defaultOmpHostDeps({ env: { HOME: home } }).loadConfig();
    assert.equal(loaded.source, "file");
    assert.equal(loaded.config.mode, "on");
    assert.equal(loaded.config.telemetryDir, join(dir, "telemetry"));
    assert.equal(loaded.config.harness.runsDir, join(dir, "runs"));
    assert.equal(loaded.config.context.storeDir, join(dir, "context"));
  });
});

test("OMP default deps: plugins lock read from $HOME/.omp/plugins is read-only (read-only file and dir, mtime and listing unchanged)", async () => {
  await withHome(async (home) => {
    const plugins = join(home, ".omp", "plugins");
    await mkdir(plugins, { recursive: true });
    const lock = join(plugins, "omp-plugins.lock.json");
    const text = JSON.stringify({ plugins: { "@omp-jev/harness": { version: "0.1.0" } } });
    await writeFile(lock, text);
    await chmod(lock, 0o444);
    await chmod(plugins, 0o555);
    try {
      const before = { mtime: (await stat(lock)).mtimeMs, names: await readdir(plugins) };
      const deps = defaultOmpHostDeps({ env: { HOME: home } });
      assert.equal(deps.readPluginsLock(), text);
      // `enabled` absent counts as enabled: forced off through the real extension entry.
      const host = ompFakeRunner();
      const s = loadInto(host, { env: { HOME: home, TYPESAFE_API_KEY: "k" }, readPluginsLock: deps.readPluginsLock });
      assert.equal(host.commandNames().includes("jev"), false);
      await host.emit("session_start");
      assert.match(s.claim().statusText(), /^Jev: off[\s\S]*legacy conflict: @omp-jev\/harness enabled in plugins lock/);
      await host.emit("session_shutdown");
      assert.equal((await stat(lock)).mtimeMs, before.mtime);
      assert.deepEqual(await readdir(plugins), before.names);
    } finally {
      await chmod(plugins, 0o755);
    }
  });
});

test("OMP default deps: no HOME in env → no lock read at all", () => {
  assert.equal(defaultOmpHostDeps({ env: {} }).readPluginsLock(), undefined);
});

// ---- Legacy detection against OMP 18.3.5 registry semantics ----------------------------------

interface Runner {
  /** One API per loaded extension, all sharing the runner's registries (as OMP does). */
  apiFor(extensionPath: string): OmpExtensionAPI;
  commandNames(): string[];
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

/**
 * OMP 18.3.5: `getCommands()` → `getRegisteredCommands()` collects every extension's commands into a
 * `Map` keyed by name (later wins, one row per name, no path). `getAllTools()` rows carry the
 * registering extension's resolved entry path in `sourceInfo.path`.
 */
function ompFakeRunner(): Runner {
  const handlers: Array<[string, OmpHandler]> = [];
  const commands = new Map<string, { name: string; description?: string; source: "extension" }>();
  const tools = new Map<string, OmpToolInfo>();
  const ctx: OmpContext = {
    model: undefined,
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({}) },
    getContextUsage: () => undefined,
    ui: { notify() {} },
    hasUI: false,
  };
  return {
    apiFor(extensionPath) {
      return {
        pi: { VERSION: "18.3.5" },
        on: (event, handler) => { handlers.push([event, handler]); },
        registerCommand: (name, options) => { commands.delete(name); commands.set(name, { name, ...(options.description ? { description: options.description } : {}), source: "extension" }); },
        registerTool: (tool) => { tools.set(tool.name, { name: tool.name, sourceInfo: { path: extensionPath, source: "extension" } }); },
        getAllTools: () => [...tools.values()],
        getActiveTools: () => [...tools.keys()],
        getCommands: () => [...commands.values()],
        getThinkingLevel: () => undefined,
        setActiveTools: async () => {},
        setModel: () => true,
        setThinkingLevel: () => {},
      };
    },
    commandNames: () => [...commands.keys()],
    async emit(event, payload = {}) {
      const results: unknown[] = [];
      for (const [name, handler] of handlers) if (name === event) results.push(await handler({ type: event, ...payload }, ctx));
      return results;
    },
  };
}

type Claim = { statusText(): string };

const shadowConfig = () => loadOmpConfig({ home: "/h", env: {}, readText: async () => JSON.stringify({ mode: "shadow", outbound: { taskIntent: true } }) });

function loadInto(runner: Runner, overrides: Parameters<typeof createExtension>[0] = {}, registry: Record<symbol, { host: Claim }> = {}) {
  const events: TelemetryInput[] = [];
  const extension = createExtension({
    env: { TYPESAFE_API_KEY: "k" },
    loadConfig: shadowConfig,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
    readPluginsLock: () => undefined,
    createTelemetry: () => ({ record: async (event) => { events.push(event); return true; }, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }),
    ...overrides,
  }, registry as never);
  extension(runner.apiFor(join(PACKAGE_ROOT, "src/adapters/omp/index.ts")));
  return { events, claim: () => registry[Symbol.for("pi-jev-harness.adapter.omp")]!.host };
}

async function shadowConfigLoader() {
  return shadowConfig;
}

/** Legacy plugin's own registrations (it always registers both names). */
function loadLegacy(runner: Runner, options: { tool: boolean }) {
  const api = runner.apiFor("/home/user/src/omp-jev-extensions/extensions/jev-harness/index.ts");
  api.registerCommand("jev", { description: "Jev harness (legacy)", handler: () => undefined });
  if (options.tool) api.registerTool!({ name: "jev_acceptance_gate", label: "l", description: "d", parameters: {}, execute: async () => ({ content: [] }) });
}

test("OMP semantics: legacy loaded first (tool + /jev), lock silent → forced off via the tool", async () => {
  const runner = ompFakeRunner();
  loadLegacy(runner, { tool: true });
  const s = loadInto(runner, { loadConfig: await shadowConfigLoader() });
  await runner.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: off[\s\S]*non-own jev_acceptance_gate/);
  assert.ok(s.events.some((e) => e.source === "adapter:legacy_conflict"));
  await runner.emit("session_shutdown");
});

test("OMP semantics: pi-jev-harness loaded twice (two extension APIs, one process) → no false legacy conflict", async () => {
  const runner = ompFakeRunner();
  const registry: Record<symbol, { host: Claim }> = {};
  const loadConfig = await shadowConfigLoader();
  const first = loadInto(runner, { loadConfig }, registry);
  // Second copy from another path shares globalThis claims.
  createExtension({ loadConfig, readPluginsLock: () => undefined, createTelemetry: () => ({ record: async () => true, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) }) }, registry as never)(
    runner.apiFor("/other/copy/pi-jev-harness/src/adapters/omp/index.ts"),
  );
  assert.deepEqual(runner.commandNames(), ["jev"]);
  await runner.emit("session_start");
  assert.match(first.claim().statusText(), /^Jev: shadow/);
  assert.doesNotMatch(first.claim().statusText(), /legacy conflict/);
  assert.ok(!first.events.some((e) => e.source === "adapter:legacy_conflict"));
  await runner.emit("session_shutdown");
});

test("OMP semantics: a foreign /jev (no legacy tool, lock silent) forces off", async () => {
  for (const order of ["legacy-first", "legacy-last"] as const) {
    const runner = ompFakeRunner();
    if (order === "legacy-first") loadLegacy(runner, { tool: false });
    const s = loadInto(runner, { loadConfig: await shadowConfigLoader() });
    if (order === "legacy-last") loadLegacy(runner, { tool: false });
    await runner.emit("session_start");
    assert.match(s.claim().statusText(), /^Jev: off[\s\S]*non-own \/jev/, order);
    await runner.emit("session_shutdown");
  }
});

// ---- Round 2: load-time throws (OMP 18.3.5 loader.ts: runtime actions throw until bound) -------

/** Like `ompFakeRunner`, but `getCommands`/`getAllTools`/`getActiveTools` throw until session_start. */
function loadingRunner(): Runner {
  const inner = ompFakeRunner();
  let bound = false;
  const notYet = () => { throw new Error("Extension runtime not initialized."); };
  return {
    apiFor(path) {
      const api = inner.apiFor(path);
      return {
        ...api,
        getCommands: () => (bound ? api.getCommands!() : notYet()),
        getAllTools: () => (bound ? api.getAllTools() : notYet()),
        getActiveTools: () => (bound ? api.getActiveTools() : notYet()),
      };
    },
    commandNames: inner.commandNames,
    emit(event, payload) {
      if (event === "session_start") bound = true;
      return inner.emit(event, payload);
    },
  };
}

test("real-OMP load order: legacy /jev loaded AFTER us overrides ours and is detected at session_start", async () => {
  const runner = loadingRunner();
  const s = loadInto(runner);
  loadLegacy(runner, { tool: false });
  await runner.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: off[\s\S]*non-own \/jev/);
  assert.ok(s.events.some((e) => e.source === "adapter:legacy_conflict"));
  await runner.emit("session_shutdown");
});

test("real-OMP load order: no legacy → own marked /jev is not a conflict", async () => {
  const runner = loadingRunner();
  const s = loadInto(runner);
  await runner.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: shadow/);
  await runner.emit("session_shutdown");
});

test("real-OMP load order: legacy /jev loaded BEFORE us (no tool, lock silent) forces off", { todo: "known limitation: getCommands throws during load, our /jev then overwrites the legacy row; only the lock or the legacy tool catch this order" }, async () => {
  const runner = loadingRunner();
  loadLegacy(runner, { tool: false });
  const s = loadInto(runner);
  await runner.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: off/);
  await runner.emit("session_shutdown");
});

test("real-OMP load order: legacy BEFORE us with its tool → forced off via the tool", { todo: "T105 int: since L3 registers its own jev_acceptance_gate, ours overwrites the legacy row in this load order (getAllTools throws during load); only the lock catches it" }, async () => {
  const runner = loadingRunner();
  loadLegacy(runner, { tool: true });
  const s = loadInto(runner);
  await runner.emit("session_start");
  assert.match(s.claim().statusText(), /^Jev: off[\s\S]*non-own jev_acceptance_gate/);
  await runner.emit("session_shutdown");
});

// ---- Round 2: lock path vs OMP 18.3.5 dirs.ts --------------------------------------------------

const noDirs = () => false;

test("lock path: default, PI_CONFIG_DIR, named profile, XDG_DATA_HOME (existing / missing)", () => {
  assert.equal(ompPluginsLockPath("/h", {}, "darwin", noDirs), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { PI_CONFIG_DIR: ".cfg" }, "darwin", noDirs), "/h/.cfg/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "work" }, "darwin", noDirs), "/h/.omp/profiles/work/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "", PI_PROFILE: "work" }, "darwin", noDirs), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { PI_PROFILE: "work" }, "darwin", noDirs), "/h/.omp/profiles/work/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x" }, "darwin", (p) => p === "/x/omp"), "/x/omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x" }, "darwin", noDirs), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x" }, "win32", () => true), "/h/.omp/plugins/omp-plugins.lock.json");
  // Profile XDG keyed on the profile path only, never the base app root.
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x", OMP_PROFILE: "work" }, "darwin", (p) => p === "/x/omp"), "/h/.omp/profiles/work/plugins/omp-plugins.lock.json");
  // Non-default PI_CODING_AGENT_DIR disables XDG; ignored under a named profile.
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x", PI_CODING_AGENT_DIR: "/a" }, "darwin", () => true), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { XDG_DATA_HOME: "/x", PI_CODING_AGENT_DIR: "/h/.omp/agent" }, "darwin", () => true), "/x/omp/plugins/omp-plugins.lock.json");
});

test("lock path: OMP_PROFILE=default is the default profile (normalizeProfileName sentinel)", () => {
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "default" }, "darwin", noDirs), "/h/.omp/plugins/omp-plugins.lock.json");
});

test("lock path: an invalid profile name falls back to the default profile (readProfileFromEnvSafe)", () => {
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "Bad Name" }, "darwin", noDirs), "/h/.omp/plugins/omp-plugins.lock.json");
  assert.equal(ompPluginsLockPath("/h", { OMP_PROFILE: "../x" }, "darwin", noDirs), "/h/.omp/plugins/omp-plugins.lock.json");
});

test("ownership: realpath'd on both sides (symlinked plugin install counts as own)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "l1-own-"));
  try {
    const link = join(dir, "linked-pkg");
    await symlink(PACKAGE_ROOT, link);
    assert.equal(isOwnPath(join(link, "src/adapters/omp/index.ts")), true);
    assert.equal(isOwnPath(join(PACKAGE_ROOT, "src/adapters/omp/index.ts")), true);
    assert.equal(isOwnPath(`${PACKAGE_ROOT}-other/src/index.ts`), false);
    assert.equal(isOwnPath("<extension:jev_acceptance_gate>"), false);
    assert.equal(isOwnPath(undefined), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
