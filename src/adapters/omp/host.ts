/**
 * OMP host adapter: off / shadow only (M1 level).
 *
 * shadow snapshots the host tools at `before_agent_start`, runs the tool router asynchronously
 * against Jev and records the result in telemetry. It never calls setActiveTools / setModel /
 * setThinkingLevel, never edits the prompt, and every handler returns undefined without awaiting
 * Jev. off sends no Jev request. Model selection is not routed here (T104: the gateway owns it).
 *
 * Events come only from the selected profile (`./profile.ts`). With no profile only the `/jev`
 * command and `session_start` are registered; the latter only loads config and records one
 * `adapter:no_profile` diagnostic per session. The adapter stays off.
 *
 * T105 L1 foundation (extension points for L2–L6):
 * - Host access goes through the host port (`OmpHost.port`, `./port.ts`, `../core/port.ts`).
 * - Legacy `@omp-jev/harness` coexistence (`./legacy.ts`): a conflict found at load time (plugins
 *   lock) registers neither `/jev` nor any legacy-named tool; one found at `session_start` forces
 *   the session off. Both record `adapter:legacy_conflict` and show in `/jev status`. Lanes that
 *   register tools do it in `register()` and only when `canRegister(name)` is true.
 * - Config `mode: "on"` parses (OMP opt-in) and is honored; each capability acts only when its
 *   own switch is on (T105 L4: `context.request`, `context.compaction`, `context.proactive.mode`).
 * - Config `mode: "on"` (OMP opt-in) is effective: only capabilities whose own switch is on change
 *   behavior (T105 L3: completion acceptance + bounded continuation at `session_stop`, see
 *   `./stop.ts`); tool routing still only observes here.
 * - T105 L3: `session_stop` / `agent_end` → `./stop.ts`; tools → `./tools-register.ts`; `/jev` →
 *   `./commands.ts`; legacy config files → `./legacy-config.ts` (read-only).
 */
import { randomUUID } from "node:crypto";
import type { JevAttempt, JevChainAttempt } from "../../jev/index.ts";
import {
  prepareToolExposure,
  routeToolsForTask,
  snapshotToolCatalog,
  type ToolRouteResult,
} from "../../router/index.ts";
import { createTelemetryWriter, type TelemetryInput, type TelemetryOutcome, type TelemetrySource, type TelemetryWriter } from "../../telemetry/index.ts";
import { containsCredential, createJevToolRouter, readJevKey, truncateIntent, type LoadedConfig } from "./shared.ts";
import { loadOmpConfig } from "./config.ts";
import type { HostPort, HostToolInfo } from "../core/port.ts";
import { LEGACY_COMMAND, LEGACY_TOOL, LEGACY_TOOLS, lockConflict, ompPluginsLockPath, OWN_COMMAND_DESCRIPTION, readLockFile, runtimeConflict } from "./legacy.ts";
import { createOmpGates } from "./gates.ts";
import { createOmpPort, type OmpPort } from "./port.ts";
import { detectProfile, type OmpProfile } from "./profile.ts";
import { hostToolsFromOmp } from "./tools.ts";
import type { OmpAgentEndEvent, OmpBeforeAgentStartEvent, OmpContext, OmpContextEvent, OmpExtensionAPI, OmpSessionBeforeCompactEvent, OmpSessionStopEvent, OmpToolCallEvent } from "./types.ts";
import { createOmpCompaction, type OmpCompaction } from "./compaction.ts";
import { createOmpContextReducer, recallToolDefinition, RECALL_TOOL, type OmpContextReducer } from "./context.ts";
import { ompContextSettings, ompTelemetryEnabled, ompTelemetryMaxBytes } from "./context-settings.ts";
import { auditDirFor, createAuditWriter, type AuditWriter } from "../../telemetry/audit.ts";
import { JEV_PLAN_PARAMETERS, JEV_PLAN_TOOL, runJevPlan } from "./plan.ts";
import { effectiveEffort, suggestEffort, type EffortLevel } from "./effort.ts";
import { jevCompletions, runJevCommand } from "./commands.ts";
import { legacyConfigDir, loadLegacyConfig, type LegacyConfig } from "./legacy-config.ts";
import { attemptTokens, createJevAccess, type JevAccess } from "../shared/jev-access.ts";
import { formatJevDebugCompact, jevDebugDetails, renderJevDebug, type JevDebugDetails } from "../shared/jev-debug.ts";
import { join } from "node:path";
import { assessOffResult, createOmpStop, type OmpStop } from "./stop.ts";
import { routeOffResult } from "./route.ts";
import { registerOmpTools } from "./tools-register.ts";

export type OmpMode = "off" | "shadow" | "on";

export interface OmpHostDeps {
  env: Readonly<Record<string, string | undefined>>;
  loadConfig: () => Promise<LoadedConfig>;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  createTelemetry: (dir: string) => TelemetryWriter;
  detectProfile: (api: OmpExtensionAPI) => OmpProfile;
  /**
   * Plugins lock text (`~/.omp/plugins/omp-plugins.lock.json`), read-only; undefined when absent.
   * Default reads `$HOME/.omp/...` from the injected env (no HOME → no lock check).
   */
  readPluginsLock: () => string | undefined;
  /** Content-free audit writer (T105 C11); default `<harnessDir>/audit` next to telemetry. */
  createAudit: (telemetryDir: string) => AuditWriter;
  /** Root whose tools count as this adapter's own (legacy tool check); default this package. */
  packageRoot?: string;
  /** Legacy `@omp-jev/harness` config files, read-only (T105 C10); default `$HOME/.omp/agent`. */
  loadLegacyConfig: () => Promise<LegacyConfig>;
  /** Legacy `jev-providers.json` (T105 C9), read-only; default `$HOME/.omp/agent/jev-providers.json`. */
  legacyProvidersPath?: string;
  /** Reads the legacy providers file and chain key files; default `readFileSync(path, "utf8")`. */
  readFile?: (path: string) => string;
  /** Raw debug output; defaults to stderr and is enabled only by /jev debug on. */
  writeDebug?: (text: string) => void;
}

export function defaultOmpHostDeps(overrides: Partial<OmpHostDeps> = {}): OmpHostDeps {
  const env = overrides.env ?? process.env;
  return {
    env,
    loadConfig: () => loadOmpConfig({ env }),
    fetch: globalThis.fetch,
    now: Date.now,
    newId: randomUUID,
    createTelemetry: (dir) => {
      // Legacy kill switch OMP_TELEMETRY=0: nothing is written.
      if (!ompTelemetryEnabled(env)) return { record: async () => false, diagnostics: () => ({ written: 0, rejected: 0, writeFailures: 0 }) };
      const maxFileBytes = ompTelemetryMaxBytes(env);
      return createTelemetryWriter({ dir, now: Date.now, ...(maxFileBytes !== undefined ? { maxFileBytes } : {}) });
    },
    createAudit: (telemetryDir) => createAuditWriter({ dir: auditDirFor(telemetryDir), now: Date.now, env }),
    detectProfile,
    readPluginsLock: readLockFile(env.HOME ? ompPluginsLockPath(env.HOME, env) : undefined),
    loadLegacyConfig: async () => (env.HOME ? loadLegacyConfig(legacyConfigDir(env.HOME)) : { dir: "" }),
    ...(env.HOME ? { legacyProvidersPath: join(legacyConfigDir(env.HOME), "jev-providers.json") } : {}),
    writeDebug: (text) => process.stderr.write(`${text}\n`),
    ...overrides,
  };
}

type StopReason = "wait_budget" | "shutdown" | "mode_off";

interface InFlight {
  controller: AbortController;
  done: Promise<void>;
}

interface SessionState {
  runId: string;
  loaded: LoadedConfig;
  mode: OmpMode;
  debug: boolean;
  telemetry: TelemetryWriter;
  audit: AuditWriter;
  pendingRecords: Set<Promise<boolean>>;
  inflight: Set<InFlight>;
  requests: number;
  tasks: number;
  stops: number;
  fallbackReasons: string[];
  /** Legacy plugin conflict: forces the session off. */
  legacyConflict?: string;
  closed: boolean;
  /** C7 request reduction + jev_recall, C8 compaction and proactive compaction (T105 L4). */
  context: OmpContextReducer;
  compaction: OmpCompaction;
  /** T105 L3: acceptance checkpoint, bounded continuation, assessment and route tools. */
  stop: OmpStop;
  legacy: LegacyConfig;
  /** T105 C9: provider chain / legacy mapping / single-url, and the credential-scan secrets. */
  jev: JevAccess;
  /** Units spent from the per-task counter (see ./budget.ts); reset at each new task. */
  taskUnits: number;
  /** Units spent by shadow observations (same limit, separate counter; ./budget.ts rule 1). */
  shadowUnits: number;
  /** T106: provider-chain fallback bookkeeping for status and the one-time notice. */
  chain: ChainNotice;
  /** Latest handler ctx, for chain notices; `child` suppresses them. */
  ui?: { ctx: OmpContext; child: boolean };
}

interface ChainNotice {
  lastAnswered?: string;
  fallbacks: number;
  lastReason?: string;
  /** Providers already announced as failing; cleared when the provider answers again. */
  failing: Set<string>;
  allFailNotified: boolean;
  /** The chain call that just fell back: its failures, and the notice owed once a provider answers. */
  calls: Map<number, { reasons: string[]; notice?: string }>;
}

/** Short reason label: outcome plus HTTP status; never an error body, url or key. */
function chainLabel(attempt: JevChainAttempt): string {
  return attempt.httpStatus !== undefined ? `${attempt.outcome} ${attempt.httpStatus}` : attempt.outcome;
}

/** A provider being down, not our own cancellation or a bad request. */
function isOutage(attempt: JevChainAttempt): boolean {
  if (attempt.outcome === "http_error") return attempt.httpStatus === undefined || attempt.httpStatus === 429 || attempt.httpStatus >= 500;
  return ["timeout", "network_error", "malformed", "no_key", "no_provider_available"].includes(attempt.outcome);
}

function chainOutcome(attempt: JevChainAttempt): TelemetryOutcome {
  return attempt.outcome === "ok" ? "ok" : attempt.fellBack ? "fallback" : attempt.outcome === "timeout" ? "timeout" : "unavailable";
}

const MAX_FALLBACK_REASONS = 5;

function toolOutcome(status: ToolRouteResult["status"]): TelemetryOutcome {
  if (status === "selected") return "ok";
  if (status === "withheld") return "withheld";
  if (status === "unavailable") return "unavailable";
  return "skipped";
}

export interface OmpHost {
  register(): void;
  noteDuplicateLoad(): void;
  statusText(): string;
  shutdown(): Promise<void>;
  settled(): Promise<void>;
  readonly profile: OmpProfile;
  /** Host port for lanes that need tool/session access (T105). */
  readonly port: HostPort<OmpContext>;
  /** False for a legacy-shared name while a load-time legacy conflict is known. */
  canRegister(name: string): boolean;
  /** Current session's audit writer (T105 C11), for stop / autorun / approval lanes. */
  audit(): AuditWriter | undefined;
}

export function createOmpHost(api: OmpExtensionAPI, deps: OmpHostDeps, onShutdown: () => void = () => {}): OmpHost {
  const profile = deps.detectProfile(api);
  const port: OmpPort = createOmpPort(api);
  /** Known at load time from the plugins lock; decides registration of shared names. */
  let loadConflict: string | undefined;
  let lockReason: string | undefined;
  let ownsCommand = false;
  let session: SessionState | undefined;
  let duplicateLoads = 0;
  let duplicatesRecorded = 0;
  let recallRegistered = false;
  /**
   * `session_before_compact` is registered at most once, at the first session start, and only when
   * that config enables compaction: any handler makes OMP skip its speculative compaction. Turning
   * compaction on later needs an omp restart.
   */
  let compactHandler: "registered" | "not_registered" | undefined;

  const record = (state: SessionState, event: TelemetryInput) => {
    const pending = state.telemetry.record(event);
    state.pendingRecords.add(pending);
    void pending.finally(() => state.pendingRecords.delete(pending));
  };

  // T105 L2 (C1–C3): tool apply, enforce, approval + steer.
  const gates = createOmpGates(port, api, {
    env: deps.env, fetch: deps.fetch, now: deps.now, newId: deps.newId,
    record: (event) => { if (session) record(session, event); },
    onJevRequest: () => { if (session) session.requests++; },
    reserveTask: () => (session ? reserveTask(session, session.mode !== "on") : false),
    noteFallback: (reason) => { if (session) noteFallback(session, reason); },
    audit: (input) => { void session?.audit.record(input); },
  });

  /** One unit of the per-task counter shared by routing, effort, enforce and approval (./budget.ts). */
  function reserveTask(state: SessionState, observe = false): boolean {
    const key = observe ? "shadowUnits" : "taskUnits";
    if (state[key] >= state.loaded.config.budget.maxRequestsPerTask) return false;
    state[key]++;
    return true;
  }

  /** OMP loads this extension again for every in-process subagent session: one diagnostic per host, the count stays in status. */
  const recordDuplicates = (state: SessionState) => {
    if (duplicatesRecorded === 0 && duplicateLoads > 0)
      record(state, { runId: state.runId, decisionId: `dec_${deps.newId()}`, kind: "diagnostic", outcome: "skipped", durationMs: 0, source: "adapter:duplicate_load" });
    duplicatesRecorded = duplicateLoads;
  };

  const noteFallback = (state: SessionState, reason: string) => {
    state.fallbackReasons = [...state.fallbackReasons.filter((r) => r !== reason), reason].slice(-MAX_FALLBACK_REASONS);
  };

  /** Never throws: no ui (print mode), a child session or mode off means no notice. */
  const notifyChain = (state: SessionState, message: string) => {
    if (state.mode === "off" || !state.ui || state.ui.child) return;
    try {
      state.ui.ctx.ui?.notify?.(message, "warning");
    } catch {
      // A notice cannot change the call result.
    }
  };

  /** T106: telemetry for every chain step; one notice per failing provider until it answers again. */
  function onChainAttempt(state: SessionState, attempt: JevChainAttempt) {
    record(state, { runId: state.runId, decisionId: attempt.decisionId, kind: "jev_attempt", outcome: chainOutcome(attempt), durationMs: attempt.durationMs,
      chain: { providerId: attempt.providerId, outcome: attempt.outcome, fellBack: attempt.fellBack, ...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}) } });
    const chain = state.chain;
    const call = chain.calls.get(attempt.sequence);
    chain.calls.delete(attempt.sequence);
    const label = chainLabel(attempt);
    if (attempt.outcome === "ok") {
      if (call?.notice) notifyChain(state, `Jev：${call.notice}已回退到 ${attempt.providerId}`);
      chain.lastAnswered = attempt.providerId;
      chain.failing.delete(attempt.providerId);
      chain.allFailNotified = false;
      return;
    }
    const reasons = [...(call?.reasons ?? []), `${attempt.providerId}: ${label}`];
    if (attempt.fellBack) {
      chain.fallbacks++;
      chain.lastReason = `${attempt.providerId}: ${label}`;
      let notice = call?.notice;
      if (!chain.failing.has(attempt.providerId)) {
        chain.failing.add(attempt.providerId);
        notice ??= `${attempt.providerId} 不可用（${label}），`;
      }
      chain.calls.set(attempt.sequence, { reasons, ...(notice ? { notice } : {}) });
      return;
    }
    // Outage: the call's last provider failed after a fallback, or a 1-provider chain's only provider failed.
    if (!(call || attempt.chainLength === 1) || !isOutage(attempt) || chain.allFailNotified) return;
    chain.allFailNotified = true;
    notifyChain(state, attempt.chainLength === 1
      ? `Jev：${attempt.providerId} 不可用（${label}），本次跳过`
      : `Jev：所有 provider 均不可用（${reasons.join("; ")}），本次跳过`);
  }

  /** OMP `getCommands()` rows (one per name, later loader wins); undefined when unavailable (e.g. during load). */
  const commandRows = () => {
    try {
      return api.getCommands?.();
    } catch {
      return undefined;
    }
  };

  /** Runtime check at session start; host runtime actions are unavailable during load. */
  function sessionConflict(): string | undefined {
    if (lockReason) return lockReason;
    let tools: readonly HostToolInfo[] | undefined;
    try {
      tools = port.getAllTools();
    } catch {
      tools = undefined;
    }
    return runtimeConflict(tools, commandRows(), ownsCommand, deps.packageRoot);
  }

  async function startSession() {
    const loaded = await deps.loadConfig();
    const legacy = await deps.loadLegacyConfig().catch((): LegacyConfig => ({ dir: "" }));
    let debugState: SessionState | undefined;
    const writeDebug = deps.writeDebug ?? ((text: string) => process.stderr.write(`${text}\n`));
    const jev = createJevAccess({ config: loaded.config, env: deps.env, onChainAttempt: (attempt) => { if (debugState && !debugState.closed) onChainAttempt(debugState, attempt); },
      onDebug: (event) => {
        if (!debugState?.debug || debugState.closed) return;
        try {
          const ctx = debugState.ui?.ctx;
          if (api.registerMessageRenderer && api.sendMessage && ctx?.hasUI && ctx.mode === "tui") {
            // OMP does not render custom entries. Empty content leaves only display details;
            // aside prevents the host's default streaming steer and triggerTurn prevents a new turn.
            api.sendMessage({ customType: "jev-debug", content: [], details: jevDebugDetails(event), display: true }, { deliverAs: "aside", triggerTurn: false });
          } else writeDebug(formatJevDebugCompact(event));
        } catch { /* Debug output must not affect Jev requests. */ }
      },
      debugEnabled: () => debugState?.debug === true && !debugState.closed,
      ...(deps.legacyProvidersPath !== undefined ? { legacyProvidersPath: deps.legacyProvidersPath } : {}), ...(deps.readFile ? { readFile: deps.readFile } : {}) });
    const legacyConflict = sessionConflict();
    const runId = `run_${deps.newId()}`;
    session = {
      runId,
      loaded,
      legacy,
      jev,
      stop: createOmpStop({
        jev, loaded, legacy, runId, explicitContinuation: loaded.explicitContinuationEnabled === true, env: deps.env, fetch: deps.fetch, now: deps.now, newId: deps.newId,
        onJevRequest: () => { if (session) session.requests++; },
        record: (event) => { if (session) record(session, event); },
        getAllTools: () => port.getAllTools(),
        getActiveTools: () => port.getActiveTools(),
        audit: (input) => { void session?.audit.record(input); },
      }),
      // T105 L2: `on` enables only the capabilities whose own switch is on (C1–C3 so far).
      mode: legacyConflict || loaded.source === "invalid" || !profile.spec ? "off" : loaded.config.mode,
      debug: false,
      telemetry: deps.createTelemetry(loaded.config.telemetryDir),
      audit: deps.createAudit(loaded.config.telemetryDir),
      pendingRecords: new Set(),
      inflight: new Set(),
      requests: 0,
      taskUnits: 0,
      shadowUnits: 0,
      chain: { fallbacks: 0, failing: new Set(), allFailNotified: false, calls: new Map() },
      tasks: 0,
      stops: 0,
      fallbackReasons: loaded.source === "invalid" ? [`config: ${loaded.reason}`] : [],
      ...(legacyConflict ? { legacyConflict } : {}),
      closed: false,
    } as SessionState;
    debugState = session;
    const state = session;
    const contextDeps = {
      jev, config: loaded.config, settings: ompContextSettings(loaded), runId: state.runId, env: deps.env, fetch: deps.fetch, now: deps.now, newId: deps.newId,
      onJevRequest: () => { state.requests++; }, record: (event: TelemetryInput) => record(state, event), onFallback: (reason: string) => noteFallback(state, reason),
    };
    state.context = createOmpContextReducer(contextDeps);
    state.compaction = createOmpCompaction(contextDeps);
    if (compactHandler === undefined) {
      const enable = state.mode !== "off" && ompContextSettings(loaded).compaction !== "off";
      if (enable) api.on("session_before_compact", handlers.session_before_compact as (event: unknown, ctx: OmpContext) => unknown);
      compactHandler = enable ? "registered" : "not_registered";
    }
    // jev_recall is registered inactive; exposed only in mode on with request reduction on (as Pi).
    if (state.mode === "on" && loaded.config.context.request === "on" && recallRegistered) {
      try {
        const activeTools = port.getActiveTools();
        if (!activeTools.includes(RECALL_TOOL)) await port.setActiveTools([...activeTools, RECALL_TOOL]);
      } catch {
        noteFallback(state, "jev_recall: could not activate");
      }
    }
    state.stop.setMode(state.mode);
    recordDuplicates(session);
    if (legacyConflict)
      record(session, { runId: session.runId, decisionId: `dec_${deps.newId()}`, kind: "diagnostic", outcome: "skipped", durationMs: 0, source: "adapter:legacy_conflict" });
    if (!profile.spec)
      record(session, { runId: session.runId, decisionId: `dec_${deps.newId()}`, kind: "diagnostic", outcome: "skipped", durationMs: 0, source: "adapter:no_profile" });
  }

  /** Synchronous snapshot, then asynchronous routing; the handler returns immediately. */
  /** Starts routing (and effort); returns the route to gate on and the effort decision to await when effort is on. */
  function startShadow(state: SessionState, event: OmpBeforeAgentStartEvent): { route: Promise<ToolRouteResult | undefined>; effort: Promise<unknown> | undefined } | undefined {
    const { config } = state.loaded;
    const decisionId = `dec_${deps.newId()}`;
    const prompt = typeof event.prompt === "string" ? event.prompt : "";

    const withheld: TelemetrySource | undefined = !config.outbound.taskIntent ? "outbound:not_authorized"
      : containsCredential(prompt, state.jev.secrets) ? "outbound:credential_detected"
      : undefined;
    if (withheld) {
      if (withheld === "outbound:credential_detected") noteFallback(state, "outbound: credential detected; Jev request withheld");
      if (config.router.tools !== "off") record(state, { runId: state.runId, decisionId, kind: "route_tools", outcome: "withheld", durationMs: 0, source: withheld });
      return undefined;
    }

    // Host snapshot: read-only getters only.
    const intent = truncateIntent(prompt);
    const allTools = port.getAllTools();
    const activeTools = port.getActiveTools();

    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort("wait_budget" satisfies StopReason), config.budget.waitMs);
    // Budget: routing and effort draw on the task counter shared with enforce/approval (./budget.ts).
    // Routing acts only in on + router.tools on; otherwise it observes on the shadow counter.
    const gate = () => reserveTask(state, !(state.mode === "on" && config.router.tools === "on"));
    const stopCategory = () => (signal.aborted && typeof signal.reason === "string" ? (signal.reason as StopReason) : undefined);

    const request = (capability: "route" | "effort") => state.jev.client(capability, {
      fetch: (input, init) => {
        state.requests++;
        return deps.fetch(input, init);
      },
      now: deps.now, newId: () => `att_${deps.newId()}`, waitMs: config.budget.waitMs,
      onAttempt: (attempt: JevAttempt) =>
        record(state, { runId: state.runId, decisionId, attemptId: attempt.attemptId, kind: "jev_attempt",
          outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}`, ...attemptTokens(attempt) }),
    });
    const client = request("route");

    const routeTools = async () => {
      // "shadow" and "on" both observe: the OMP profile cannot apply routing yet.
      if (config.router.tools === "off") return;
      const started = deps.now();
      let failure: string | undefined = client ? undefined : "no_key";
      let result: ToolRouteResult | undefined;
      try {
        const catalog = snapshotToolCatalog(hostToolsFromOmp(allTools, activeTools));
        const router = client
          ? createJevToolRouter(client, decisionId, gate, (category) => { failure = category; })
          : { source: "jev" as const, review: async () => null };
        result = intent.trim()
          ? await routeToolsForTask({ catalog, intent, candidateRootIds: catalog.availableIds, policy: config.tools, router,
              dependencies: {}, maxBundleTools: config.tools.maxBundleTools, maxBundleSchemaBytes: config.tools.maxBundleSchemaBytes, signal })
          : undefined;
        // Shadow suggestion only; never applied to the host.
        if (result) prepareToolExposure({ mode: "shadow", baselineIds: activeTools, result });
      } catch {
        failure = "router_error";
      }
      const status = result?.status ?? (failure ? "unavailable" : "no_match");
      failure = stopCategory() ?? failure;
      if (status === "unavailable") noteFallback(state, `tools: unavailable (${failure ?? "jev"})`);
      record(state, { runId: state.runId, decisionId, kind: "route_tools", outcome: toolOutcome(status), durationMs: deps.now() - started, source: `tools:${status}` });
      return result;
    };

    // C12: shares this task's gate and wait budget. Shadow: background, after tool routing.
    // On: reserved first and awaited by before_agent_start so the level is set before the turn.
    const effortMode = effectiveEffort(config.effort, state.mode);
    const effortClient = request("effort");
    const effortGate = () => reserveTask(state, effortMode !== "on");
    const effort = () => suggestEffort({ mode: effortMode, intent, client: effortClient, gate: effortGate, signal, decisionId: `dec_${deps.newId()}`, runId: state.runId,
      getThinkingLevel: () => api.getThinkingLevel(), setThinkingLevel: (level: EffortLevel) => api.setThinkingLevel(level), audit: state.audit, now: deps.now });

    const applied = effortMode === "on" ? effort() : undefined;
    const routed = routeTools();
    const flight: InFlight = {
      controller,
      done: Promise.allSettled(applied ? [applied, routed] : [routed.then(effort)]).then(() => {
        clearTimeout(timer);
        state.inflight.delete(flight);
      }),
    };
    state.inflight.add(flight);
    return { route: routed, effort: applied };
  }

  async function shutdown() {
    const state = session;
    if (!state || state.closed) return;
    state.closed = true;
    state.stop.abort("shutdown");
    for (const flight of state.inflight) flight.controller.abort("shutdown" satisfies StopReason);
    state.context.abort("shutdown");
    await Promise.allSettled([...state.inflight].map((flight) => flight.done));
    await gates.shutdown(state);
    await Promise.allSettled([state.context.settled(), state.compaction.settled()]);
    await Promise.allSettled([...state.pendingRecords]);
    await state.audit.flush();
    onShutdown();
  }

  function statusText(): string {
    const profileLine = profile.spec
      ? `OMP ${profile.version}: profile ${profile.spec.id} (events: ${profile.spec.events.join(", ")})`
      : `OMP ${profile.version ?? "unknown"}: no profile (${profile.reason}); all capabilities off`;
    const state = session;
    if (!state) return [`Jev: off (no session)`, profileLine].join("\n");
    const { loaded, mode } = state;
    const configLine =
      loaded.source === "invalid" ? `config: invalid (${loaded.reason}); forced off; file left unchanged: ${loaded.path}`
      : loaded.source === "file" ? `config: ${loaded.path}`
      : `config: defaults (no file at ${loaded.path})`;
    return [
      `Jev: ${mode} (this session)`,
      profileLine,
      configLine,
      ...(state.legacyConflict ? [`legacy conflict: ${state.legacyConflict}; forced off; /${LEGACY_COMMAND} and ${LEGACY_TOOL} not registered by pi-jev-harness`] : []),
      `legacy config: ${state.legacy.acceptance || state.legacy.autorun || state.legacy.toolGroups ? `mapped read-only from ${state.legacy.dir}` : "none"}`,
      ...state.stop.statusLines(mode),
      ...(mode !== "off" ? gates.statusLines(state) : []),
      loaded.config.outbound.taskIntent
        ? "outbound: task intent allowed (credential check on)"
        : "outbound: 任务意图出站未开启 (outbound.taskIntent=false; no Jev request is sent)",
      `路由：${mode === "off" ? "关闭" : mode === "on" && loaded.config.router.tools === "on" ? "应用" : "仅观察"}`,
      `router: tools ${loaded.config.router.tools} (applied only in mode on with router.tools on)`,
      capabilityLine(state),
      `Jev key: ${readJevKey(deps.env) ? "present" : "missing"}`,
      ...state.jev.statusLines(),
      `Jev debug: ${state.debug ? "on" : "off"} (this session; raw outbound task context when enabled)`,
      `Jev requests this session: ${state.requests}`,
      `tasks: ${state.tasks}; ${profile.spec?.stopEvent ?? "stop"} seen: ${state.stops}`,
      ...state.context.statusLines(mode),
      ...state.compaction.statusLines(mode),
      compactHandler === "registered"
        ? "session_before_compact: registered at startup (OMP speculative compaction disabled)"
        : "session_before_compact: not registered (compaction off at startup; turning it on needs an omp restart)",
      `Jev provider chain: last answered ${state.chain.lastAnswered ?? "none"}; fallbacks this session: ${state.chain.fallbacks}; last fallback: ${state.chain.lastReason ?? "none"}`,
      `fallback reasons (adapter/tool routing): ${state.fallbackReasons.length ? state.fallbackReasons.join("; ") : "none"}`,
      ...(duplicateLoads ? [`duplicate loads ignored: ${duplicateLoads}`] : []),
    ].join("\n");
  }

  /**
   * One line per session: every capability's effective state (session mode caps the capability's
   * own switch) and where that switch came from (`config` file, `default`, `env`, a legacy file).
   */
  function capabilityLine(state: SessionState): string {
    const { config } = state.loaded;
    const mode = state.mode;
    const cap = (feature: "off" | "shadow" | "on") => (mode === "off" ? "off" : mode === "shadow" && feature === "on" ? "shadow" : feature);
    const file = state.loaded.source === "file" ? "config" : state.loaded.source;
    const settings = ompContextSettings(state.loaded);
    const from = (name: string) => settings.sources[name] ?? file;
    const acceptance = state.stop.capability("acceptance");
    const autorun = state.stop.capability("autorun");
    const entries: Array<[string, string, string]> = [
      ["route", cap(config.router.tools), file],
      ["enforce", cap(config.harness.enforce.length ? "on" : "off"), file],
      ["approval", cap(config.approval.enabled ? "on" : "off"), file],
      ["acceptance", cap(acceptance.mode), acceptance.source],
      ["autorun", cap(autorun.mode), autorun.source],
      ["context", cap(config.context.request), from("request")],
      ["compaction", cap(settings.compaction), from("compaction")],
      ["proactive", cap(settings.proactive.mode), from("proactive.mode")],
      ["effort", effectiveEffort(config.effort, mode), file],
      ["plan", cap("on"), "tool"],
      ["jev", state.jev.source.kind, state.jev.source.kind === "legacy" ? state.jev.source.path : state.jev.source.kind === "config" ? "config" : "jev.url"],
    ];
    return `capabilities: ${entries.map(([name, value, source]) => `${name}=${value} (${source})`).join(", ")}`;
  }

  let pendingModeOff: Promise<void> | undefined;

  function setMode(value: OmpMode): string | undefined {
    if (!session) return "Jev: no active session";
    if (!profile.spec && value !== "off") return `Jev: ${profile.reason}; staying off`;
    if (session.legacyConflict && value !== "off") return `Jev: legacy conflict (${session.legacyConflict}); staying off`;
    if (session.loaded.source === "invalid" && value !== "off") return `Jev: config invalid (${session.loaded.reason}); staying off`;
    const state = session;
    const leaving = state.mode !== "off" && value === "off";
    state.mode = value;
    state.stop.setMode(value);
    if (value === "off") {
      for (const flight of state.inflight) flight.controller.abort("mode_off" satisfies StopReason);
      state.context.abort("mode_off");
      state.compaction.abort("mode_off");
    }
    pendingModeOff = value === "off" ? modeOffCleanup(state, leaving) : undefined;
    return undefined;
  }

  /** Async part of `/jev mode off`: L2 gate release, then jev_recall leaves the active set (L4). */
  async function modeOffCleanup(state: SessionState, leaving: boolean) {
    if (leaving) await gates.modeOff(state);
    try {
      const activeTools = port.getActiveTools();
      if (activeTools.includes(RECALL_TOOL)) await port.setActiveTools(activeTools.filter((name) => name !== RECALL_TOOL));
    } catch {
      noteFallback(state, "jev_recall: could not deactivate");
    }
  }

  async function command(args: string, ctx: OmpContext) {
    const out = runJevCommand(args, {
      status: statusText,
      setMode,
      debug: () => session?.debug,
      setDebug: (enabled) => {
        if (!session) return false;
        session.debug = enabled;
        return true;
      },
      capability: (name) => (session ? session.stop.capability(name) : undefined),
      setCapability: (name, mode) => (session ? (session.stop.setCapability(name, mode), true) : false),
      continuations: () => session?.stop.continuations(),
    });
    // L2/L4 mode-off cleanup (gates, context, compaction, jev_recall) finishes before the notice.
    await pendingModeOff;
    pendingModeOff = undefined;
    return ctx.ui.notify(out.text, out.level);
  }

  /** C6: advice only; the plan is returned, never dispatched. */
  function planTool(params: unknown, signal: AbortSignal | undefined) {
    const state = session;
    const config = state?.loaded.config;
    const decisionId = `dec_${deps.newId()}`;
    const client = state && config ? state.jev.client("plan", {
      fetch: (input, init) => { state.requests++; return deps.fetch(input, init); },
      now: deps.now, newId: () => `att_${deps.newId()}`, waitMs: config.budget.waitMs,
    }) : undefined;
    return runJevPlan(params, signal, {
      mode: state && !state.closed ? state.mode : "off", taskIntent: config?.outbound.taskIntent ?? false, client,
      maxRequests: config?.budget.maxRequestsPerTask ?? 0, waitMs: config?.budget.waitMs ?? 1, runId: state?.runId ?? `run_${deps.newId()}`,
      decisionId, audit: state?.audit, now: deps.now, secrets: state?.jev.secrets ?? [],
    });
  }

  /** Remembers the latest ctx for chain notices; a missing or odd ctx only disables them. */
  const track = (ctx: OmpContext | undefined) => {
    const state = session;
    if (!state || !ctx) return;
    let child = true;
    try { child = port.session(ctx).isChildSession; } catch { /* unknown: treat as child, no notice */ }
    state.ui = { ctx, child };
  };

  const active = () => {
    const state = session;
    return state && !state.closed && state.mode !== "off" ? state : undefined;
  };

  /** Handlers by event name; only the selected profile's names are registered. */
  const handlers: Record<string, (event: never, ctx: OmpContext) => unknown> = {
    session_start: async (_event: unknown, ctx: OmpContext) => {
      await startSession();
      track(ctx);
    },
    before_agent_start: (event: OmpBeforeAgentStartEvent, ctx: OmpContext) => {
      const state = active();
      if (!state) return undefined;
      // Child (subagent) sessions: no routing and no effort, as legacy autorun.
      track(ctx);
      if (port.session(ctx).isChildSession) return undefined;
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      // Host retry of the same task: no second route or apply.
      if (gates.isRetry(prompt)) return undefined;
      // Our own continuation turn is the same task: no reset, no second route or effort.
      if (state.stop.continuing(prompt)) return undefined;
      state.tasks++;
      state.taskUnits = 0;
      state.shadowUnits = 0;
      let started: { route: Promise<ToolRouteResult | undefined>; effort: Promise<unknown> | undefined } | undefined;
      state.context.startTask();
      state.stop.startTask(prompt);
      try {
        started = startShadow(state, event);
      } catch {
        noteFallback(state, "snapshot: host snapshot failed");
      }
      // T105 C1: only on + router.tools on is awaited (OMP awaits before_agent_start before the request).
      const gated = gates.startTask(state, prompt, ctx, started?.route);
      // T105 C1: only on + router.tools on awaits the route; C12 effort on awaits its level (OMP awaits before the request).
      const awaited = [
        ...(state.mode === "on" && state.loaded.config.router.tools === "on" ? [gated] : []),
        ...(started?.effort ? [started.effort] : []),
      ];
      return awaited.length ? Promise.all(awaited).then(() => undefined, () => undefined) : undefined;
    },
    // T105 C2/C3: enforce review, then human approval.
    tool_call: (event: OmpToolCallEvent, ctx: OmpContext) => {
      track(ctx);
      const state = active();
      return state ? gates.toolCall(state, event, ctx) : undefined;
    },
    tool_result: (_event: unknown, ctx: OmpContext) => {
      track(ctx);
      const state = active();
      if (state) gates.toolResult(state, ctx);
      return undefined;
    },
    message_end: (event: { message?: unknown }) => {
      gates.messageEnd(event.message);
      return undefined;
    },
    input: (event: { source?: unknown }) => {
      gates.input(event.source);
      return undefined;
    },
    // End-of-task boundary (T105 C4): only mode on may return a continuation; shadow assesses in
    // the background and returns undefined synchronously.
    session_stop: (event: OmpSessionStopEvent, ctx: OmpContext) => {
      track(ctx);
      const state = active();
      if (!state) return undefined;
      state.stops++;
      const work = state.stop.sessionStop(event, port.session(ctx), state.mode);
      if (state.mode === "on") return work;
      const tracked = work.then(() => true, () => false);
      state.pendingRecords.add(tracked);
      void tracked.finally(() => state.pendingRecords.delete(tracked));
      return undefined;
    },
    agent_before_settle: () => {
      const state = active();
      if (state) state.stops++;
      return undefined;
    },
    session_shutdown: async () => {
      await shutdown();
    },
    // T105 L4: C7 request reduction, C8 compaction, proactive compaction.
    context: async (event: OmpContextEvent, ctx: OmpContext) => {
      track(ctx);
      const state = active();
      const reduced = state ? await state.context.handle(event, ctx, state.mode) : undefined;
      return reduced?.messages ? port.contextResult(reduced.messages) : undefined;
    },
    session_before_compact: async (event: OmpSessionBeforeCompactEvent, ctx: OmpContext) => {
      track(ctx);
      const state = active();
      return state ? state.compaction.beforeCompact(event, ctx, state.mode) : undefined;
    },
    // L3 stop bookkeeping, L4 proactive compaction, then the L2 task end (budget/state release).
    agent_end: async (event: OmpAgentEndEvent, ctx: OmpContext) => {
      track(ctx);
      const state = active();
      if (!state) return undefined;
      // Each step isolated: one failing never skips the others.
      try { state.stop.agentEnd(event); } catch { noteFallback(state, "agent_end: stop bookkeeping failed"); }
      try { await state.compaction.agentEnd(event, ctx, state.mode); } catch { noteFallback(state, "agent_end: proactive compaction failed"); }
      try { return event.willContinue ? undefined : await gates.endTask(state); } catch { noteFallback(state, "agent_end: task end failed"); return undefined; }
    },
  };

  const canRegister = (name: string) => !(loadConflict && (LEGACY_TOOLS.has(name) || name === LEGACY_COMMAND));

  return {
    profile,
    port,
    canRegister,
    register() {
      lockReason = lockConflict(deps.readPluginsLock);
      loadConflict = lockReason ?? runtimeConflict(undefined, commandRows(), false, deps.packageRoot);
      // No profile: session_start only, to record the no_profile diagnostic; mode stays off.
      for (const name of profile.spec?.events ?? ["session_start"]) {
        const handler = handlers[name];
        if (handler) api.on(name, handler as (event: unknown, ctx: OmpContext) => unknown);
      }
      // No registration at all while a load-time legacy conflict is known.
      if (!loadConflict) api.registerMessageRenderer?.<JevDebugDetails>("jev-debug", (message, options) => {
        return message.details ? renderJevDebug(message.details, options.expanded) : undefined;
      });
      if (api.registerTool && !loadConflict && canRegister(RECALL_TOOL)) {
        port.registerTool(recallToolDefinition((params, ctx) => {
          const state = session;
          if (!state || state.closed) throw new Error("jev_recall: no active session");
          return state.context.recallTool(params, ctx);
        }));
        recallRegistered = true;
      }
      if (!loadConflict) {
        port.registerCommand(LEGACY_COMMAND, { description: OWN_COMMAND_DESCRIPTION, getArgumentCompletions: jevCompletions, handler: command });
        ownsCommand = true;
      }
      registerOmpTools(port, canRegister, {
        assess: async (tool, params, ctx) => {
          const state = active();
          if (!state) return assessOffResult(tool);
          const branch = (() => { try { return ctx.sessionManager.getBranch?.() ?? []; } catch { return []; } })();
          const messages = branch.flatMap((entry) => ((entry as { type?: unknown }).type === "message" ? [(entry as { message?: unknown }).message] : []));
          return state.stop.assessTool(tool, params, messages, state.mode);
        },
        route: async (params) => {
          const state = active();
          return state ? state.stop.routeTool(params, state.mode) : routeOffResult();
        },
      });
      // loadMode essential: OMP 18.3.5 mounts undeclared extension tools under xdev ("discoverable"),
      // so they never reach the model's top-level tool list. Like every tool of ours: nothing is
      // registered while a load-time legacy conflict is known.
      if (!loadConflict && canRegister(JEV_PLAN_TOOL)) api.registerTool?.({ name: JEV_PLAN_TOOL, label: "Jev Route Agent Planner", loadMode: "essential",
        description: "Derives and arbitrates subagent delegation topology (direct, single, parallel, dag) using Jev.",
        parameters: JEV_PLAN_PARAMETERS, execute: (_id, params, signal) => planTool(params, signal) });
    },
    noteDuplicateLoad() {
      duplicateLoads++;
      if (session && !session.closed) recordDuplicates(session);
    },
    statusText,
    shutdown,
    async settled() {
      const state = session;
      if (!state) return;
      await Promise.allSettled([...state.inflight].map((flight) => flight.done));
      await gates.settled();
      await Promise.allSettled([state.context.settled(), state.compaction.settled()]);
      await Promise.allSettled([...state.pendingRecords]);
      await state.audit.flush();
    },
    audit: () => session?.audit,
  };
}
