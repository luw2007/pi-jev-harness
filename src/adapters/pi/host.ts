/**
 * Pi host adapter: off / shadow / on.
 *
 * shadow observes: it snapshots the host at `before_agent_start`, runs the tool router
 * asynchronously against Jev, and records the result in telemetry. It never calls
 * setActiveTools/setModel/setThinkingLevel, never edits the prompt, and returns nothing that
 * changes host behavior. off sends no Jev request at all. Model routing is not handled here in
 * any mode: model selection is magpie's, and the adapter never observes or suggests a model.
 *
 * on (per session, `/jev mode on`) changes behavior only through capabilities that are enabled
 * in config and whose gate is validated: enforced review kinds (`harness.enforce`), bounded
 * continuation (`harness.continuation.enabled`) and tool routing (`router.tools: "on"`, see the
 * block below). Everything else behaves exactly as in shadow.
 *
 * In shadow and on the action harness (`./harness.ts`) also sees `tool_call`, `tool_result`,
 * `message_end`, `input` (a user message while streaming), `agent_before_settle` (completion
 * checkpoint and the only place a continuation may be returned) and `agent_settled` (closing
 * only); it blocks a tool only for kinds listed in `harness.enforce`. The compatibility tools
 * `jev_acceptance_gate` / `foreman_assess` share the automatic checkpoint assessment.
 *
 * Request-level context reduction (`./context.ts`) is a separate switch (`context.request`):
 * shadow observes on the `context` event, on (session mode on AND `context.request` on) may return
 * reduced messages. Summary replacement stays off (no `session_before_compact` handler).
 * `jev_recall` is registered whenever `context.request` is not off, but it is in the model's active
 * tool set only while reduction is effectively on: shadow and off never change the tool set (E5).
 */
import { createJevAccess, type JevAccess } from "../shared/jev-access.ts";
import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { SpillFs } from "../../context/index.ts";
import type { JevAttempt, JevClient } from "../../jev/index.ts";
import { prepareToolExposure, routeToolsForTask, snapshotToolCatalog, type ToolRouteResult } from "../../router/index.ts";
import type { RoutingOutcome, RunRouting } from "../../harness/run-artifacts.ts";
import {
  createTelemetryWriter,
  TELEMETRY_ID_PATTERNS,
  type TelemetryInput,
  type TelemetryOutcome,
  type TelemetrySource,
  type TelemetryWriter,
} from "../../telemetry/index.ts";
import {
  containsCredential,
  loadConfig as loadConfigFile,
  readJevKey,
  type AdapterMode,
  type LoadedConfig,
} from "./config.ts";
import { createPiContextHook, RECALL_PARAMETERS, RECALL_TOOL, type PiContextHook } from "./context.ts";
import { applyToolSet } from "../core/port.ts";
import { createPiHarness, type PiHarness } from "./harness.ts";
import { createPiPort } from "./port.ts";
import { ACCEPTANCE_TOOL, FOREMAN_TOOL, unavailableCompletion } from "./lifecycle.ts";
import {
  createJevToolRouter,
  hostDependencies,
  hostToolsFromPi,
  JEV_TOOL_IDS,
  RESIDENT_TOOL_IDS,
  residentLabel,
  ROUTE_TOOL,
  restoreOwnedTools,
  sameToolSet,
  truncateIntent,
  type RequestGate,
} from "./tools.ts";

export interface HostDeps {
  env: Readonly<Record<string, string | undefined>>;
  loadConfig: () => Promise<LoadedConfig>;
  fetch: typeof fetch;
  now: () => number;
  /** Lowercase UUID; telemetry IDs are `run_`/`dec_`/`att_` plus this value. */
  newId: () => string;
  createTelemetry: (dir: string) => TelemetryWriter;
  /** Archive filesystem for context spill/recall; tests inject failures. Default node:fs. */
  contextFs?: SpillFs;
}

export function defaultHostDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  const env = overrides.env ?? process.env;
  return {
    env,
    loadConfig: () => loadConfigFile({ env }),
    fetch: globalThis.fetch,
    now: Date.now,
    newId: randomUUID,
    createTelemetry: (dir) => createTelemetryWriter({ dir, now: Date.now }),
    ...overrides,
  };
}

/** Abort reasons we own; anything else is a Jev/transport failure category. */
type StopReason = "wait_budget" | "shutdown" | "mode_off";

interface InFlight {
  controller: AbortController;
  done: Promise<void>;
}

interface SessionState {
  runId: string;
  loaded: LoadedConfig;
  /** single-url unless `jev.providers` is configured (no legacy mapping under Pi). */
  jev: JevAccess;
  mode: AdapterMode;
  telemetry: TelemetryWriter;
  pendingRecords: Set<Promise<boolean>>;
  inflight: Set<InFlight>;
  /** Physical Jev requests dispatched in this session. */
  requests: number;
  fallbackReasons: string[];
  closed: boolean;
  harness: PiHarness;
  /** Request-level context reduction (`context` event) and `jev_recall`. */
  context: PiContextHook;
  // ---- per-task routing and tool apply ----
  /** Routing of the current user task; shared by the automatic route, the tool apply and `jev_route`. */
  task?: TaskRouting;
  /** Tool-routing outcome of the latest task, for `/jev status`. */
  toolState: ToolState;
}

// ---- per-task routing and tool apply ----

/** One tool-routing run: the router result, or why there is none. */
interface ToolOutcome {
  status: ToolRouteResult["status"];
  result?: ToolRouteResult;
  /** Jev/transport failure category when `status` is unavailable. */
  failure?: string;
  /** Set when the request never left the machine (outbound scope). */
  withheld?: TelemetrySource;
}

/** Tools this extension removed for the current task (the only changes it owns). */
interface ToolApply {
  decisionId: string;
  /** Active tools right before the apply, in host order. */
  baseline: string[];
  /** Active tools read back after the apply. */
  applied: string[];
  removed: string[];
  /** Tools kept active by residency (read/search, the exec tool, this extension's own tools). */
  resident: string[];
  external: boolean;
}

interface TaskRouting {
  decisionId: string;
  intent: string;
  /** Why the automatic route was not sent; `jev_route` checks its own intent separately. */
  withheld?: TelemetrySource;
  client?: JevClient;
  /** Per-task physical request budget, shared by the automatic route and `jev_route`. */
  gate: RequestGate;
  allTools: ToolInfo[];
  activeTools: string[];
  /** Undefined when `router.tools` is off. */
  tools: Promise<ToolOutcome | undefined>;
  apply?: ToolApply;
  /** Routing outcomes of this task; the harness writes a copy into run.json. */
  routing: RunRouting;
}

type ToolState =
  | { kind: "idle" }
  | { kind: "applied"; tools: number; prerequisites: number; resident: string[]; restored: boolean }
  | { kind: "fallback"; reason: string }
  | { kind: "external" };

/** Parameters of `jev_route` (plain JSON Schema, like the assessment tools). */
const ROUTE_PARAMETERS = {
  type: "object",
  properties: {
    intent: { type: "string", description: "The task intent to route. The same text as the current user task reuses its routing decision." },
    candidates: { type: "array", items: { type: "string" }, description: "Optional: tool names to choose from. Default: every active tool." },
  },
  required: ["intent"],
  additionalProperties: false,
} as const;

export { ROUTE_TOOL };
const ROUTE_NOTE = "仅返回工具路由建议：没有执行任何任务或工具，也没有因此改变工具集合或模型。";
/** Model routing line in `/jev status` (model selection is magpie's). */
export const MODEL_ROUTING_LINE = "模型路由：由 magpie 负责（harness 不处理）";

function toolFallbackReason(outcome: ToolOutcome | undefined): string {
  if (!outcome) return "未路由";
  if (outcome.withheld === "outbound:not_authorized") return "任务意图出站未开启";
  if (outcome.withheld === "outbound:credential_detected") return "任务含凭据，未发请求";
  const result = outcome.result;
  switch (outcome.status) {
    case "unavailable": return `路由不可用：${outcome.failure ?? "jev"}`;
    case "withheld": return `工具包超出限制：${result && result.status === "withheld" ? result.gaps.map((gap) => gap.reason).join(",") : "unknown"}`;
    case "needs_clarification": return "需要澄清，未选工具";
    case "no_match": return "无匹配工具";
    default: return outcome.status;
  }
}

const MAX_FALLBACK_REASONS = 5;
const CONTEXT_OFF_NO_SESSION = "jev_recall：没有活动会话，上下文裁剪未启用";

/**
 * Parameters of the compatibility assessment tools. Plain JSON Schema, which Pi validates like a
 * TypeBox schema; `typebox` is not a direct dependency of this package.
 */
const ASSESS_PARAMETERS = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Optional: the answer you are about to give the user (question tasks are judged on it). Treated as an untrusted claim.",
    },
  },
  additionalProperties: false,
} as const;

function answerOf(params: unknown): string | undefined {
  const answer = (params as { answer?: unknown } | null)?.answer;
  return typeof answer === "string" && answer.trim() ? answer : undefined;
}
function toolOutcome(status: ToolRouteResult["status"]): TelemetryOutcome {
  if (status === "selected") return "ok";
  if (status === "withheld") return "withheld";
  if (status === "unavailable") return "unavailable";
  return "skipped";
}

export interface PiHost {
  /** Register handlers and the `/jev` command on `pi`. Call once per runtime. */
  register(): void;
  /** Another copy of the extension tried to load into this process. */
  noteDuplicateLoad(): void;
  statusText(): string;
  /** Idempotent: cancel in-flight requests and flush telemetry. */
  shutdown(): Promise<void>;
  /** Resolves when every shadow decision started so far has been recorded. */
  settled(): Promise<void>;
}

export function createPiHost(pi: ExtensionAPI, deps: HostDeps, onShutdown: () => void = () => {}): PiHost {
  // Host access through the port; event wiring (`pi.on`) stays Pi-specific.
  const port = createPiPort(pi);
  let session: SessionState | undefined;
  let duplicateLoads = 0;
  let duplicatesRecorded = 0;
  let recallRegistered = false;

  // task events carry the run.json runId when the telemetry schema accepts it
  // (`run_<uuid>`: every generated id and `pi-jev run`'s injected id). A custom PI_JEV_RUN_ID and
  // later tasks' `<id>-<n>` do not fit it; those keep the session id (upgrade: widen the schema).
  const record = (state: SessionState, event: TelemetryInput) => {
    const taskRunId = state.harness.currentRunId();
    const runId = taskRunId !== undefined && TELEMETRY_ID_PATTERNS.runId.test(taskRunId) ? taskRunId : state.runId;
    const pending = state.telemetry.record({ ...event, runId });
    state.pendingRecords.add(pending);
    void pending.finally(() => state.pendingRecords.delete(pending));
  };

  const recordDuplicates = (state: SessionState) => {
    for (; duplicatesRecorded < duplicateLoads; duplicatesRecorded++)
      record(state, { runId: state.runId, decisionId: `dec_${deps.newId()}`, kind: "diagnostic", outcome: "skipped", durationMs: 0, source: "adapter:duplicate_load" });
  };

  const noteFallback = (state: SessionState, reason: string) => {
    state.fallbackReasons = [...state.fallbackReasons.filter((r) => r !== reason), reason].slice(-MAX_FALLBACK_REASONS);
  };

  const abortAll = (state: SessionState, reason: StopReason) => {
    for (const flight of state.inflight) flight.controller.abort(reason);
  };

  async function startSession() {
    const loaded = await deps.loadConfig();
    const injected = loaded.config.harness.runId;
    const runId = injected !== undefined && TELEMETRY_ID_PATTERNS.runId.test(injected) ? injected : `run_${deps.newId()}`;
    const jev = createJevAccess({ config: loaded.config, env: deps.env });
    const state: SessionState = {
      runId,
      loaded,
      jev,
      mode: loaded.source === "invalid" ? "off" : loaded.config.mode,
      telemetry: deps.createTelemetry(loaded.config.telemetryDir),
      pendingRecords: new Set(),
      inflight: new Set(),
      requests: 0,
      fallbackReasons: loaded.source === "invalid" ? [`config: ${loaded.reason}`] : [],
      closed: false,
      toolState: { kind: "idle" },
      harness: createPiHarness({
        jev,
        config: loaded.config,
        mode: loaded.source === "invalid" ? "off" : loaded.config.mode,
        env: deps.env,
        fetch: deps.fetch,
        now: deps.now,
        newId: deps.newId,
        onJevRequest: () => {
          state.requests++;
        },
        onJevAttempt: (attempt) =>
          record(state, { runId: state.runId, decisionId: attempt.decisionId, attemptId: attempt.attemptId, kind: "jev_attempt",
            outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}` }),
        onDecision: (kind, decisionId, outcome, durationMs) => record(state, { runId: state.runId, decisionId, kind, outcome, durationMs }),
      }),
      context: createPiContextHook({
        jev,
        config: loaded.config,
        runId,
        env: deps.env,
        fetch: deps.fetch,
        now: deps.now,
        newId: deps.newId,
        onJevRequest: () => {
          state.requests++;
        },
        record: (event) => record(state, event),
        onFallback: (reason) => noteFallback(state, `context: ${reason}`),
        ...(deps.contextFs ? { fs: deps.contextFs } : {}),
      }),
    };
    session = state;
    recordDuplicates(session);
  }

  const stopCategory = (signal: AbortSignal) => (signal.aborted && typeof signal.reason === "string" ? (signal.reason as StopReason) : undefined);

  /** Outbound scope (§9.2/§11): text leaves the machine only when enabled and free of credentials. */
  function outboundBlock(state: SessionState, text: string): TelemetrySource | undefined {
    return !state.loaded.config.outbound.taskIntent ? "outbound:not_authorized"
      : containsCredential(text, state.jev.secrets) ? "outbound:credential_detected"
      : undefined;
  }

  /** the `route` chain; Pi stays single-url unless `jev.providers` is configured. */
  function jevClient(state: SessionState): JevClient | undefined {
    const { config } = state.loaded;
    return state.jev.client("route", {
      fetch: (input, init) => {
        state.requests++;
        return deps.fetch(input, init);
      },
      now: deps.now,
      newId: () => `att_${deps.newId()}`,
      waitMs: config.budget.waitMs,
      onAttempt: (attempt: JevAttempt) =>
        record(state, { runId: state.runId, decisionId: attempt.decisionId, attemptId: attempt.attemptId, kind: "jev_attempt",
          outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}` }),
    });
  }


  /** A cancellable unit of Jev work bounded by `budget.waitMs`; shutdown and `mode off` abort it. */
  function openFlight(state: SessionState): { signal: AbortSignal; close(work: Promise<unknown>): void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("wait_budget" satisfies StopReason), state.loaded.config.budget.waitMs);
    return {
      signal: controller.signal,
      close(work) {
        const flight: InFlight = {
          controller,
          done: work.then(() => undefined, () => undefined).finally(() => {
            clearTimeout(timer);
            state.inflight.delete(flight);
          }),
        };
        state.inflight.add(flight);
      },
    };
  }

  /** One tool route against the task's snapshot; always records one `route_tools` event. */
  async function routeToolsFor(state: SessionState, task: Pick<TaskRouting, "client" | "gate" | "allTools" | "activeTools">,
    decisionId: string, intent: string, candidateRootIds: readonly string[] | undefined, signal: AbortSignal): Promise<ToolOutcome> {
    const { config } = state.loaded;
    const started = deps.now();
    let failure: string | undefined = task.client ? undefined : "no_key";
    let result: ToolRouteResult | undefined;
    try {
      const catalog = snapshotToolCatalog(hostToolsFromPi(task.allTools, task.activeTools));
      const router = task.client
        ? createJevToolRouter(task.client, decisionId, task.gate, (category) => { failure = category; })
        : { source: "jev" as const, review: async () => null };
      result = intent.trim()
        ? await routeToolsForTask({ catalog, intent, candidateRootIds: candidateRootIds ?? catalog.availableIds, policy: config.tools, router,
            dependencies: hostDependencies(catalog.availableIds), maxBundleTools: config.tools.maxBundleTools,
            maxBundleSchemaBytes: config.tools.maxBundleSchemaBytes, signal })
        : undefined;
      // Shadow suggestion only; `activeIds` is the unchanged baseline and is never applied here.
      if (result) prepareToolExposure({ mode: "shadow", baselineIds: task.activeTools, result });
    } catch {
      failure = "router_error";
    }
    const status = result?.status ?? (failure ? "unavailable" : "no_match");
    failure = stopCategory(signal) ?? failure;
    if (status === "unavailable") noteFallback(state, `tools: unavailable (${failure ?? "jev"})`);
    record(state, { runId: state.runId, decisionId, kind: "route_tools", outcome: toolOutcome(status),
      durationMs: deps.now() - started, source: `tools:${status}` });
    return { status, ...(result ? { result } : {}), ...(status === "unavailable" ? { failure: failure ?? "jev" } : {}) };
  }

  /** Synchronous snapshot, then asynchronous routing; the returned promises settle within `budget.waitMs`. */
  function startRouting(state: SessionState, event: BeforeAgentStartEvent, routing: RunRouting): TaskRouting {
    const { config } = state.loaded;
    const decisionId = `dec_${deps.newId()}`;
    const intent = truncateIntent(event.prompt);
    let reserved = 0;
    const gate = () => reserved < config.budget.maxRequestsPerTask && ++reserved > 0;
    const client = jevClient(state);
    const allTools = port.getAllTools();
    const activeTools = port.getActiveTools();
    const base = { decisionId, intent, client, gate, allTools, activeTools, routing };

    // Nothing about the prompt is recorded; a withheld route sends no Jev request.
    const withheld = outboundBlock(state, event.prompt);
    if (withheld) {
      if (withheld === "outbound:credential_detected") noteFallback(state, "outbound: credential detected; Jev request withheld");
      const toolsOn = config.router.tools !== "off";
      if (toolsOn) record(state, { runId: state.runId, decisionId, kind: "route_tools", outcome: "withheld", durationMs: 0, source: withheld });
      if (toolsOn) routing.tools = { outcome: "fallback", reason: toolFallbackReason({ status: "withheld", withheld }) };
      return { ...base, withheld, tools: Promise.resolve(toolsOn ? { status: "withheld", withheld } : undefined) };
    }

    const flight = openFlight(state);
    const tools = config.router.tools === "off" ? Promise.resolve(undefined) : routeToolsFor(state, base, decisionId, intent, undefined, flight.signal);
    // Observed outcomes first; an apply in `on` (awaiting the same promise later) overwrites them.
    void tools.then((outcome) => {
      if (outcome) routing.tools = outcome.status === "selected" && outcome.result
        ? { outcome: "observed", tools: [...outcome.result.toolIds] }
        : { outcome: "fallback", reason: toolFallbackReason(outcome) };
    });
    flight.close(tools);
    return { ...base, tools };
  }

  const recordApply = (state: SessionState, decisionId: string, outcome: TelemetryOutcome, source: TelemetrySource) =>
    record(state, { runId: state.runId, decisionId, kind: "route_tools", outcome, durationMs: 0, source });

  /** Routing record at task start: `off` for a disabled router, `observed` until an outcome arrives. */
  function initialRouting(state: SessionState): RunRouting {
    const off = state.loaded.config.router.tools === "off";
    const tools: RoutingOutcome = { outcome: off ? "off" : "observed" };
    return { tools };
  }

  const toolsApplied = (state: SessionState) => state.mode === "on" && state.loaded.config.router.tools === "on";

  /**
   * Mode `on` + `router.tools: "on"`: apply the routed bundle (roots + prerequisites + resident
   * read/search/recovery tools) through `pi.setActiveTools`, once per user task, and verify it by
   * reading `pi.getActiveTools` back. Only removals from the current host set are made, and only
   * those are owned. No bundle, a stale task or a read-back mismatch keeps/restores native tools.
   */
  async function applyTools(state: SessionState, task: TaskRouting): Promise<void> {
    const outcome = await task.tools;
    if (state.closed || state.task !== task || !toolsApplied(state)) return;
    const nativeKept = (reason: string) => {
      noteFallback(state, `tools: native tools kept (${reason})`);
      recordApply(state, task.decisionId, "fallback", "tools:native_kept");
      state.toolState = { kind: "fallback", reason };
      task.routing.tools = { outcome: "fallback", reason };
    };
    const result = outcome?.result;
    if (!result || result.status !== "selected") return nativeKept(toolFallbackReason(outcome));
    let current: string[] | undefined;
    try {
      current = port.getActiveTools();
      const exposure = prepareToolExposure({ mode: "on", baselineIds: current, result, residentIds: RESIDENT_TOOL_IDS });
      const keep = new Set(exposure.activeIds);
      // Based on the current host set: never re-enable a tool someone disabled meanwhile.
      const target = current.filter((id) => keep.has(id));
      if (target.length === 0) return nativeKept("工具集合在应用前已变化");
      const removed = current.filter((id) => !keep.has(id));
      // Only our own call ran since `current` was read (same synchronous step on Pi): a mismatch puts it back as it was.
      const applied = await applyToolSet(port, current, target);
      const readBack = applied.readBack;
      if (!applied.ok) {
        const restored = applied.restored;
        noteFallback(state, `tools: apply read-back mismatch; ${restored ? "restored" : "restore unverified"}`);
        recordApply(state, task.decisionId, "fallback", "tools:apply_mismatch");
        state.toolState = { kind: "fallback", reason: restored ? "生效校验不一致，已恢复" : "生效校验不一致，恢复未确认" };
        task.routing.tools = { outcome: "fallback", reason: state.toolState.reason };
        return;
      }
      // Resident tools (read/search, the exec tool, our own tools) are recorded apart from the routed ones.
      const resident = RESIDENT_TOOL_IDS.filter((id) => target.includes(id));
      task.apply = { decisionId: task.decisionId, baseline: current, applied: readBack, removed, resident, external: false };
      recordApply(state, task.decisionId, "ok", "tools:applied");
      state.toolState = { kind: "applied", tools: target.filter((id) => !JEV_TOOL_IDS.includes(id)).length, prerequisites: result.prerequisiteIds.length, resident, restored: false };
      task.routing.tools = { outcome: "applied", tools: [...readBack], resident: [...resident] };
    } catch {
      if (current) {
        try { port.setActiveTools(current); } catch { /* reported below */ }
      }
      nativeKept("应用失败");
    }
  }

  /** A read-back that differs from what we set means the user or another extension changed tools: keep it. */
  function checkExternal(state: SessionState, task: TaskRouting | undefined = state.task) {
    const apply = task?.apply;
    if (!apply || apply.external) return;
    let now: string[];
    try { now = port.getActiveTools(); } catch { return; }
    if (sameToolSet(now, apply.applied)) return;
    apply.external = true;
    recordApply(state, apply.decisionId, "skipped", "tools:external_change_kept");
    state.toolState = { kind: "external" };
    task!.routing.tools = { outcome: "external_change_kept", tools: [...now] };
  }

  /** Task end: add back only the tools this extension removed and that are still missing. */
  function restoreTools(state: SessionState, task: TaskRouting | undefined = state.task) {
    const apply = task?.apply;
    if (!task || !apply) return;
    checkExternal(state, task);
    task.apply = undefined;
    try {
      const current = port.getActiveTools();
      if (apply.removed.some((id) => !current.includes(id))) port.setActiveTools(restoreOwnedTools(current, apply.removed, apply.baseline));
      recordApply(state, apply.decisionId, "ok", "tools:restored");
      if (state.toolState.kind === "applied") state.toolState = { ...state.toolState, restored: true };
    } catch {
      noteFallback(state, "tools: restore at task end failed");
    }
  }

  /**
   * `jev_recall` is active only while context reduction is effectively on (session mode on AND
   * `context.request` on). Pi 0.87.1 activates a tool registered after load, so shadow/off take it
   * back out; only this one name is ever added or removed here.
   */
  function syncRecallTool(state: SessionState): void {
    if (!recallRegistered || state.closed) return;
    const want = state.mode === "on" && state.loaded.config.context.request === "on";
    try {
      const active = port.getActiveTools();
      const has = active.includes(RECALL_TOOL);
      if (want && !has) port.setActiveTools([...active, RECALL_TOOL]);
      else if (!want && has) port.setActiveTools(active.filter((id) => id !== RECALL_TOOL));
    } catch {
      noteFallback(state, "jev_recall: tool set update failed");
    }
  }

  function toolRoutingText(state: SessionState): string {
    const feature = state.loaded.config.router.tools;
    if (state.mode === "off" || feature === "off") return "关闭";
    if (!toolsApplied(state)) return "仅观察";
    const tool = state.toolState;
    switch (tool.kind) {
      case "idle": return "开启（尚无任务）";
      case "applied": return `已应用（${tool.tools} 个工具，${tool.prerequisites} 个前置${tool.resident.length ? `；常驻：${residentLabel(tool.resident)}` : ""}${tool.restored ? "；任务结束已恢复" : ""}）`;
      case "fallback": return `已回退（${tool.reason}）`;
      case "external": return "外部改动已保留";
    }
  }

  const routingLines = (state: SessionState) => [`工具路由：${toolRoutingText(state)}`, MODEL_ROUTING_LINE];

  function toolSummary(outcome: ToolOutcome | undefined, applied: boolean) {
    if (!outcome) return { status: "off", reason: "router.tools=off，未发请求" };
    const result = outcome.result;
    return {
      status: outcome.withheld ?? outcome.status,
      toolIds: result?.toolIds ?? [],
      rootIds: result && "rootIds" in result ? result.rootIds : [],
      prerequisiteIds: result && "prerequisiteIds" in result ? result.prerequisiteIds : [],
      droppedIds: result?.droppedIds ?? [],
      ...(outcome.status === "selected" && !outcome.withheld ? {} : { reason: toolFallbackReason(outcome) }),
      appliedToHost: applied,
    };
  }

  /**
   * `jev_route` compatibility tool: the tool decision for an
   * intent. The current task's routing is reused when the intent (and candidate set) is the same;
   * otherwise one new tool route runs against the task's snapshot and request budget. Never
   * applies anything.
   */
  async function routeTool(params: unknown): Promise<AgentToolResult<unknown>> {
    const input = (params ?? {}) as { intent?: unknown; candidates?: unknown };
    const intent = truncateIntent(typeof input.intent === "string" ? input.intent : "");
    const candidates = Array.isArray(input.candidates) ? input.candidates.filter((id): id is string => typeof id === "string") : undefined;
    const state = session;
    const task = state?.task;
    let body: Record<string, unknown>;
    if (!state || state.closed || state.mode === "off") {
      body = { executed: false, note: ROUTE_NOTE, status: "unavailable", reason: "Jev 处于 off，未发送请求", tools: null };
    } else if (!task) {
      body = { executed: false, note: ROUTE_NOTE, status: "unavailable", reason: "当前没有任务快照，未发送请求", tools: null };
    } else {
      checkExternal(state, task);
      const reused = intent.trim() === task.intent.trim() && (candidates === undefined || sameToolSet(candidates, task.activeTools));
      let tools: ToolOutcome | undefined;
      if (reused || state.loaded.config.router.tools === "off") {
        tools = await task.tools;
      } else {
        const decisionId = `dec_${deps.newId()}`;
        const withheld = outboundBlock(state, intent);
        if (withheld) {
          record(state, { runId: state.runId, decisionId, kind: "route_tools", outcome: "withheld", durationMs: 0, source: withheld });
          tools = { status: "withheld", withheld };
        } else {
          const flight = openFlight(state);
          const work = routeToolsFor(state, task, decisionId, intent, candidates, flight.signal);
          flight.close(work);
          tools = await work;
        }
      }
      body = { executed: false, note: ROUTE_NOTE, reused, tools: toolSummary(tools, reused && task.apply !== undefined) };
    }
    return { content: [{ type: "text", text: JSON.stringify(body) }], details: body };
  }

  async function shutdown(reason?: string) {
    const state = session;
    if (!state || state.closed) return;
    state.closed = true;
    restoreTools(state); // give back owned tool removals; never touches other tools
    abortAll(state, "shutdown");
    state.context.abort("shutdown");
    await state.harness.shutdown(reason);
    await state.context.settled();
    await Promise.allSettled([...state.inflight].map((flight) => flight.done));
    await Promise.allSettled([...state.pendingRecords]);
    onShutdown();
  }

  function statusText(): string {
    const state = session;
    if (!state) return "Jev: off (no session)";
    const { loaded, mode } = state;
    const configLine =
      loaded.source === "invalid" ? `config: invalid (${loaded.reason}); forced off; file left unchanged: ${loaded.path}`
      : loaded.source === "file" ? `config: ${loaded.path}`
      : `config: defaults (no file at ${loaded.path})`;
    return [
      `Jev: ${mode} (this session)`,
      configLine,
      ...(loaded.notes ?? []),
      loaded.config.outbound.taskIntent
        ? "outbound: task intent allowed (credential check on)"
        : "outbound: 任务意图出站未开启 (outbound.taskIntent=false; no Jev request is sent)",
      ...(mode === "on" ? ["on: 只有已配置且已通过门槛的能力改变行为；其余按 shadow 观察"] : []),
      ...routingLines(state),
      ...state.context.statusLines(mode),
      `Jev key: ${readJevKey(deps.env) ? "present" : "missing"}`,
      `Jev requests this session: ${state.requests}`,
      `fallback reasons: ${state.fallbackReasons.length ? state.fallbackReasons.join("; ") : "none"}`,
      ...state.harness.statusLines(mode),
      ...(duplicateLoads ? [`duplicate loads ignored: ${duplicateLoads}`] : []),
    ].join("\n");
  }

  async function command(args: string, ctx: ExtensionCommandContext) {
    const [sub, value, extra] = args.trim().split(/\s+/).filter(Boolean);
    if (!sub || (sub === "status" && !value)) return ctx.ui.notify(statusText(), "info");
    if (sub === "mode" && !extra && (value === "off" || value === "shadow" || value === "on")) {
      if (!session) return ctx.ui.notify("Jev: no active session", "warning");
      if (session.loaded.source === "invalid" && value !== "off")
        return ctx.ui.notify(`Jev: config invalid (${session.loaded.reason}); staying off`, "warning");
      session.mode = value;
      if (value !== "on") restoreTools(session); // only `on` keeps a routed tool set
      syncRecallTool(session);
      if (value === "off") {
        abortAll(session, "mode_off");
        session.context.abort("mode_off");
        session.harness.discard();
      }
      session.harness.setMode(value);
      // Only `on` needs the per-capability detail: it never means "everything enabled".
      const effective = value === "on" ? `; 实际生效：${capabilitySummary(session).join("；")}` : "";
      return ctx.ui.notify(`Jev: ${value} (this session)${effective}`, "info");
    }
    return ctx.ui.notify("Usage: /jev status | /jev mode off|shadow|on", "warning");
  }

  function capabilitySummary(state: SessionState): string[] {
    return [
      ...routingLines(state),
      ...state.context.statusLines(state.mode),
      ...state.harness.statusLines(state.mode).filter((line) => /^(强制评审|完成验收|续跑)：/.test(line)),
    ];
  }

  /** Compatibility tool result: the `CompletionResult` contract as JSON text and as details. */
  async function assessTool(tool: string, answer: string | undefined): Promise<AgentToolResult<unknown>> {
    const state = session;
    const result = !state || state.closed || state.mode === "off"
      ? unavailableCompletion(tool === FOREMAN_TOOL ? "foreman" : "acceptance", "完成评估不可用：Jev 处于 off，未发送请求")
      : await state.harness.assessTool(tool, answer);
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  }

  return {
    register() {
      pi.on("session_start", async () => {
        await startSession();
        // Registered only once context reduction is configured; Pi 0.87.1 activates a tool
        // registered after load (`refreshTools`). A later session with context off gets an error.
        if (!recallRegistered && session?.loaded.config.context.request !== "off") {
          recallRegistered = true;
          pi.registerTool({
            name: RECALL_TOOL,
            label: "Jev recall",
            description:
              "Read back a tool result that request-level context reduction moved out of context in this session. Pass the handle from its \"[jev spill: …]\" notice. Read-only: it returns the archived text exactly and never re-runs anything; paths and handles of other sessions are rejected.",
            parameters: RECALL_PARAMETERS,
            execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
              const state = session;
              if (!state) throw new Error(CONTEXT_OFF_NO_SESSION);
              return state.context.recallTool(params, ctx);
            },
          });
        }
        if (session) syncRecallTool(session);
      });
      pi.on("before_agent_start", (event, ctx) => {
        const state = session;
        if (!state || state.closed || state.mode === "off") return undefined;
        restoreTools(state); // a task that never settled gives back its tools first
        state.context.startTask();
        const routing = initialRouting(state);
        try {
          state.harness.startTask(event.prompt, ctx, routing);
        } catch {
          noteFallback(state, "harness: task start failed");
        }
        state.task = undefined;
        try {
          state.task = startRouting(state, event, routing);
        } catch {
          noteFallback(state, "snapshot: host snapshot failed");
          if (routing.tools.outcome !== "off") routing.tools = { outcome: "fallback", reason: "宿主快照失败" };
        }
        // mode on + router.tools on waits for the tool route (bounded by budget.waitMs) and
        // applies it before the first provider request; everything else returns immediately.
        if (toolsApplied(state)) {
          if (state.task) return applyTools(state, state.task).then(() => undefined);
          state.toolState = { kind: "fallback", reason: "宿主快照失败" };
        }
        return undefined;
      });
      // The harness decides; in shadow (no enforced kind) this always resolves to undefined.
      pi.on("tool_call", async (event, ctx) => {
        const state = session;
        if (!state || state.closed || state.mode === "off") return undefined;
        checkExternal(state);
        return state.harness.toolCall(event, ctx);
      });
      pi.on("tool_result", (event, ctx) => {
        const state = session;
        if (state && !state.closed && state.mode !== "off") state.harness.toolResult(event, ctx);
        return undefined;
      });
      pi.on("message_end", (event, ctx) => {
        const state = session;
        if (state && !state.closed && state.mode !== "off") state.harness.messageEnd(event, ctx);
        return undefined;
      });
      // A message typed while the agent streams is queued into the current task: void old decisions.
      // Idle input starts a new task through before_agent_start instead.
      pi.on("input", (event) => {
        const state = session;
        if (state && !state.closed && state.mode !== "off" && event.streamingBehavior !== undefined) state.harness.userMessage();
        return undefined;
      });
      // The only boundary that may return a continuation (Pi: one next provider request).
      pi.on("agent_before_settle", async (event, ctx) => {
        const state = session;
        if (!state || state.closed || state.mode === "off") return undefined;
        return state.harness.beforeSettle(event, ctx);
      });
      // Notification only: closes the record, never prompts again.
      pi.on("agent_settled", async () => {
        const state = session;
        if (state && !state.closed) restoreTools(state); // task end gives back owned removals
        if (state && !state.closed && state.mode !== "off") await state.harness.settle();
      });
      // Request-level context: shadow observes in the background, on may return reduced messages.
      pi.on("context", async (event, ctx) => {
        const state = session;
        if (!state || state.closed || state.mode === "off") return undefined;
        try {
          return await state.context.handle(event, ctx, state.mode);
        } catch {
          return undefined;
        }
      });
      pi.on("session_shutdown", async (event) => {
        await shutdown(event.reason);
      });
      pi.registerCommand("jev", {
        description: "Jev harness status and mode (off | shadow | on)",
        getArgumentCompletions: (prefix) =>
          ["status", "mode off", "mode shadow", "mode on"].filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item })),
        handler: command,
      });
      pi.registerTool({
        name: ACCEPTANCE_TOOL,
        label: "Jev acceptance gate",
        description:
          "Light completion check for question or implementation tasks. Judges host evidence (changed files, check results, the answer); returns completionStatus (passed / incomplete / blocked / unavailable), stopAllowed and concrete gaps. Shares one assessment per checkpoint with the automatic check.",
        parameters: ASSESS_PARAMETERS,
        execute: async (_toolCallId, params) => assessTool(ACCEPTANCE_TOOL, answerOf(params)),
      });
      pi.registerTool({
        name: FOREMAN_TOOL,
        label: "Jev foreman checkpoint",
        description:
          "Milestone checkpoint for long multi-step tasks: ten foreman dimensions over host evidence; returns the same completion contract. Shares one assessment per checkpoint with the automatic check.",
        parameters: ASSESS_PARAMETERS,
        execute: async (_toolCallId, params) => assessTool(FOREMAN_TOOL, answerOf(params)),
      });
      // ---- jev_route ----
      pi.registerTool({
        name: ROUTE_TOOL,
        label: "Jev route",
        description:
          "Returns the Jev tool-routing suggestion for a task intent: the tool bundle (roots and prerequisites). Suggestion only: nothing is executed. The current task's intent reuses the routing already done for it (no extra request).",
        parameters: ROUTE_PARAMETERS,
        execute: async (_toolCallId, params) => routeTool(params),
      });
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
      await state.context.settled();
      await state.harness.settled();
      await Promise.allSettled([...state.pendingRecords]);
    },
  };
}
