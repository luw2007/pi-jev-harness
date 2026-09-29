/**
 * `jev_route` for OMP: the Jev tool-routing suggestion for an intent, same contract as
 * the Pi tool (`../pi/host.ts` routeTool). Suggestion only: nothing is executed, applied or
 * switched (no setActiveTools, no setModel). Per task: the same intent + candidate set reuses the
 * earlier result (no extra request); every request passes the outbound gate (outbound.taskIntent,
 * credential scan) and the per-call request budget, and waits at most `budget.waitMs`.
 */
import type { JevClient } from "../../jev/index.ts";
import { prepareToolExposure, routeToolsForTask, snapshotToolCatalog, type ToolRouteResult } from "../../router/index.ts";
import type { TelemetryInput, TelemetryOutcome, TelemetrySource } from "../../telemetry/index.ts";
import { sameToolSet, type HostToolResult } from "../core/port.ts";
import { containsCredential, createJevToolRouter, truncateIntent, type LoadedConfig } from "./shared.ts";
import { hostToolsFromOmp } from "./tools.ts";
import type { OmpToolInfo } from "./types.ts";

export const ROUTE_TOOL = "jev_route";
const ROUTE_NOTE = "仅返回工具路由建议：没有执行任何任务或工具，也没有因此改变工具集合或模型。";

export const ROUTE_PARAMETERS = {
  type: "object",
  properties: {
    intent: { type: "string", description: "The task intent to route. The same text as an earlier call in this task reuses its routing decision." },
    candidates: { type: "array", items: { type: "string" }, description: "Optional: tool names to choose from. Default: every active tool." },
  },
  required: ["intent"],
  additionalProperties: false,
} as const;

interface Outcome {
  status: ToolRouteResult["status"];
  result?: ToolRouteResult;
  failure?: string;
  withheld?: TelemetrySource;
}

export interface RouteDeps {
  config: LoadedConfig["config"];
  runId: string;
  /** Every Jev key of the session (`JevAccess.secrets`) when the capability has a usable provider; undefined = none. */
  secrets: readonly string[] | undefined;
  /** Jev client whose fetch is already budget-bound by the caller, or undefined without a key. */
  jev(): JevClient | undefined;
  getAllTools(): OmpToolInfo[];
  getActiveTools(): string[];
  now(): number;
  newId(): string;
  record(event: TelemetryInput): void;
}

export interface OmpRouteTool {
  startTask(): void;
  execute(params: unknown, active: boolean): Promise<HostToolResult>;
}

function toolOutcome(status: ToolRouteResult["status"]): TelemetryOutcome {
  if (status === "selected") return "ok";
  if (status === "withheld") return "withheld";
  if (status === "unavailable") return "unavailable";
  return "skipped";
}

function reasonOf(outcome: Outcome): string {
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

function summary(outcome: Outcome) {
  const result = outcome.result;
  return {
    status: outcome.withheld ?? outcome.status,
    toolIds: result?.toolIds ?? [],
    rootIds: result && "rootIds" in result ? result.rootIds : [],
    prerequisiteIds: result && "prerequisiteIds" in result ? result.prerequisiteIds : [],
    droppedIds: result?.droppedIds ?? [],
    ...(outcome.status === "selected" && !outcome.withheld ? {} : { reason: reasonOf(outcome) }),
    appliedToHost: false,
  };
}

const text = (body: Record<string, unknown>): HostToolResult => ({ content: [{ type: "text", text: JSON.stringify(body) }], details: body });

/** `jev_route` result while the adapter is off or has no session. */
export function routeOffResult(): HostToolResult {
  return text({ executed: false, note: ROUTE_NOTE, status: "unavailable", reason: "Jev 处于 off，未发送请求", tools: null });
}

export function createOmpRouteTool(deps: RouteDeps): OmpRouteTool {
  const { config } = deps;
  let cache: Array<{ intent: string; candidates: string[] | undefined; outcome: Promise<Outcome> }> = [];

  async function route(intent: string, candidates: string[] | undefined): Promise<Outcome> {
    const decisionId = `dec_${deps.newId()}`;
    // Per call: each jev_route call has its own request allowance.
    let reserved = 0;
    const gate = () => reserved < config.budget.maxRequestsPerTask && ++reserved > 0;
    const withheld: TelemetrySource | undefined = !config.outbound.taskIntent ? "outbound:not_authorized"
      : containsCredential(intent, deps.secrets) ? "outbound:credential_detected" : undefined;
    if (withheld) {
      deps.record({ runId: deps.runId, decisionId, kind: "route_tools", outcome: "withheld", durationMs: 0, source: withheld });
      return { status: "withheld", withheld };
    }
    const started = deps.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("wait_budget"), config.budget.waitMs);
    const client = deps.jev();
    let failure: string | undefined = client ? undefined : "no_key";
    let result: ToolRouteResult | undefined;
    try {
      const active = deps.getActiveTools();
      const catalog = snapshotToolCatalog(hostToolsFromOmp(deps.getAllTools(), active));
      const router = client
        ? createJevToolRouter(client, decisionId, gate, (category) => { failure = category; })
        : { source: "jev" as const, review: async () => null };
      result = intent.trim()
        ? await routeToolsForTask({ catalog, intent, candidateRootIds: candidates ?? catalog.availableIds, policy: config.tools, router,
            dependencies: {}, maxBundleTools: config.tools.maxBundleTools, maxBundleSchemaBytes: config.tools.maxBundleSchemaBytes, signal: controller.signal })
        : undefined;
      if (result) prepareToolExposure({ mode: "shadow", baselineIds: active, result });
    } catch {
      failure = "router_error";
    } finally {
      clearTimeout(timer);
    }
    const status = result?.status ?? (failure ? "unavailable" : "no_match");
    if (controller.signal.aborted) failure = "wait_budget";
    deps.record({ runId: deps.runId, decisionId, kind: "route_tools", outcome: toolOutcome(status), durationMs: deps.now() - started, source: `tools:${status}` });
    return { status, ...(result ? { result } : {}), ...(status === "unavailable" ? { failure: failure ?? "jev" } : {}) };
  }

  return {
    startTask() {
      cache = [];
    },
    async execute(params, active) {
      if (!active) return routeOffResult();
      if (config.router.tools === "off") return text({ executed: false, note: ROUTE_NOTE, reused: false, tools: { status: "off", reason: "router.tools=off，未发请求" } });
      const input = (params ?? {}) as { intent?: unknown; candidates?: unknown };
      const intent = truncateIntent(typeof input.intent === "string" ? input.intent : "");
      const candidates = Array.isArray(input.candidates) ? input.candidates.filter((id): id is string => typeof id === "string") : undefined;
      const hit = cache.find((entry) => entry.intent.trim() === intent.trim()
        && (entry.candidates === undefined ? candidates === undefined : candidates !== undefined && sameToolSet(entry.candidates, candidates)));
      const outcome = hit?.outcome ?? route(intent, candidates);
      if (!hit) cache.push({ intent, candidates, outcome });
      return text({ executed: false, note: ROUTE_NOTE, reused: hit !== undefined, tools: summary(await outcome) });
    },
  };
}
