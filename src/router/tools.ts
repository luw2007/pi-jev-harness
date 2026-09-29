import {
  CLARIFICATION_ID,
  assembleToolBundle,
  createCatalog,
  routeTools,
} from "../../vendor/jev-harness/src/routing/index.ts";
import { freeze } from "../../vendor/jev-harness/src/routing/catalog.ts";
import type {
  Catalog,
  RoutingPolicy,
  RoutingReceipt,
  ToolDefinition,
  ToolDependencies,
  ToolInputSchema,
  ToolRouter,
} from "../../vendor/jev-harness/src/routing/index.ts";

export type { Catalog, RoutingPolicy, RoutingReceipt, ToolDependencies, ToolRouter };

/** One tool as the host actually registered it. Only these tools can enter a catalog. */
export interface HostTool {
  name: string;
  description: string;
  /** The schema the host would expose to the model; JSON-serializable. */
  schema: unknown;
  /** Registration origin, e.g. "builtin" or an extension name. */
  source: string;
  /** Registered but currently disabled tools keep `available: false`. */
  available: boolean;
  kind?: "tool" | "subagent";
  /** Host-supplied relative per-tool estimate for H's cost ranking; defaults to 1. */
  estimatedCostUnits?: number;
}

export interface CatalogEntry {
  id: string;
  kind: "tool" | "subagent";
  source: string;
  available: boolean;
  /** Detached JSON copy of the host schema. */
  schema: unknown;
  /** UTF-8 bytes of `JSON.stringify(schema)`. */
  schemaBytes: number;
  /**
   * "exact": the H catalog carries this schema verbatim.
   * "opaque": the schema is outside H's closed subset; the H catalog carries an empty
   * closed object while `schema` above remains the one the host exposes.
   */
  routingSchema: "exact" | "opaque";
}

export interface RejectedHostTool {
  name: string;
  reason: "invalid_id" | "duplicate" | "invalid_schema" | "invalid_descriptor";
}

export interface ToolCatalog {
  /** H catalog used for routing. */
  catalog: Catalog;
  entries: readonly CatalogEntry[];
  /** Registered and currently available ids, in registration order. */
  availableIds: readonly string[];
  /** Host tools that could not enter the catalog under their own name. */
  rejected: readonly RejectedHostTool[];
}

const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const OPAQUE_SCHEMA: ToolInputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
const encoder = new TextEncoder();

function acceptsSchema(definition: ToolDefinition): boolean {
  try {
    createCatalog([definition]);
    return true;
  } catch {
    return false;
  }
}

/** Build a catalog from the host's registered tools only; never renames or invents ids. */
export function snapshotToolCatalog(hostTools: readonly HostTool[]): ToolCatalog {
  const definitions: ToolDefinition[] = [];
  const entries: CatalogEntry[] = [];
  const rejected: RejectedHostTool[] = [];
  const seen = new Set<string>();
  for (const tool of hostTools) {
    const name = String(tool?.name);
    if (!TOOL_ID.test(name) || name === CLARIFICATION_ID) { rejected.push({ name, reason: "invalid_id" }); continue; }
    if (seen.has(name)) { rejected.push({ name, reason: "duplicate" }); continue; }
    let serialized: string | undefined;
    try { serialized = JSON.stringify(tool.schema); } catch { serialized = undefined; }
    if (serialized === undefined) { rejected.push({ name, reason: "invalid_schema" }); continue; }
    const schema: unknown = JSON.parse(serialized);
    const kind = tool.kind ?? "tool";
    const base = { id: name, kind, description: tool.description, estimatedCostUnits: tool.estimatedCostUnits ?? 1 };
    let definition: ToolDefinition = { ...base, inputSchema: schema as ToolInputSchema };
    let routingSchema: CatalogEntry["routingSchema"] = "exact";
    if (!acceptsSchema(definition)) {
      definition = { ...base, inputSchema: OPAQUE_SCHEMA };
      routingSchema = "opaque";
      if (!acceptsSchema(definition)) { rejected.push({ name, reason: "invalid_descriptor" }); continue; }
    }
    seen.add(name);
    definitions.push(definition);
    entries.push({ id: name, kind, source: String(tool.source), available: tool.available === true, schema,
      schemaBytes: encoder.encode(serialized).byteLength, routingSchema });
  }
  return freeze({
    catalog: createCatalog(definitions),
    entries,
    availableIds: entries.filter(entry => entry.available).map(entry => entry.id),
    rejected,
  });
}

export interface RouteToolsForTaskOptions {
  catalog: ToolCatalog;
  intent: string;
  /**
   * Root candidates Jev may choose from; ids that are unregistered or unavailable are dropped and
   * reported. Prerequisites are validated against the host's full `catalog.availableIds` instead.
   */
  candidateRootIds: readonly string[];
  policy: RoutingPolicy;
  router: ToolRouter;
  /** Host-declared prerequisites, completed after routing. */
  dependencies: ToolDependencies;
  /** Limit on the whole dependency-complete bundle, not only routed roots. */
  maxBundleTools: number;
  /** Limit on the summed host schema bytes of the whole bundle. */
  maxBundleSchemaBytes: number;
  signal?: AbortSignal;
}

export type BundleGap =
  | { reason: "dependency_unavailable"; ids: readonly string[] }
  | { reason: "dependency_unregistered" | "dependency_cycle" | "invalid_dependencies"; detail: string }
  | { reason: "too_many_tools"; actual: number; limit: number }
  | { reason: "schema_too_large"; actual: number; limit: number };

interface RouteCommon {
  /** Original H receipt; never rewritten. */
  receipt: RoutingReceipt;
  /** Requested candidate ids that were not registered-and-available. */
  droppedIds: readonly string[];
  /** Every registered-and-available id in the snapshot. */
  hostAvailableIds: readonly string[];
}

export type ToolRouteResult = RouteCommon & (
  | { status: "selected"; toolIds: readonly string[]; rootIds: readonly string[]; prerequisiteIds: readonly string[]; schemaBytes: number }
  | { status: "withheld"; toolIds: readonly []; rootIds: readonly string[]; prerequisiteIds: readonly string[]; gaps: readonly BundleGap[] }
  | { status: "needs_clarification" | "no_match" | "unavailable"; toolIds: readonly []; reason: string }
);

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw Error(`${name} must be a positive integer.`);
  return value;
}

/**
 * Route roots with H, then explicitly complete prerequisites and check whole-bundle limits.
 * Jev only sees `candidateRootIds`; prerequisites may be any registered-and-available host tool.
 */
export async function routeToolsForTask(options: RouteToolsForTaskOptions): Promise<ToolRouteResult> {
  const { catalog, intent, policy, router, dependencies, signal } = options;
  const maxTools = positiveLimit(options.maxBundleTools, "maxBundleTools");
  const maxBytes = positiveLimit(options.maxBundleSchemaBytes, "maxBundleSchemaBytes");
  const hostAvailable = new Set(catalog.availableIds);
  const requested = Array.from(new Set(options.candidateRootIds));
  const candidates = requested.filter(id => hostAvailable.has(id));
  const common = { droppedIds: requested.filter(id => !hostAvailable.has(id)), hostAvailableIds: [...catalog.availableIds] };

  const receipt = await routeTools(catalog.catalog, { intent, availableIds: candidates }, policy, router, signal);
  if (receipt.outcome !== "selected") return freeze({ ...common, receipt, status: receipt.outcome, toolIds: [] as const, reason: receipt.reason });

  // H's bundle treats the request's options (the roots) as the available set. Hand it a derived
  // view whose options are the host's full available set; the returned receipt stays the original.
  const hostView: RoutingReceipt = { ...receipt, request: { ...receipt.request, options: [
    ...receipt.catalog.filter(tool => hostAvailable.has(tool.id)).map(({ id, kind, description }) => ({ id, kind, description })),
    ...receipt.request.options.filter(option => option.kind === "fallback"),
  ] } };
  let bundle;
  try {
    bundle = assembleToolBundle(hostView, dependencies, { signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid tool dependencies.";
    const reason = /cycle/i.test(detail) ? "dependency_cycle" as const : /catalog/i.test(detail) ? "dependency_unregistered" as const : "invalid_dependencies" as const;
    return freeze({ ...common, receipt, status: "withheld", toolIds: [] as const, rootIds: [...receipt.selectedIds], prerequisiteIds: [], gaps: [{ reason, detail }] });
  }
  if (signal?.aborted) return freeze({ ...common, receipt, status: "unavailable", toolIds: [] as const, reason: "Routing cancelled before tool exposure; no tools selected." });
  if (bundle.status !== "ready")
    return freeze({ ...common, receipt, status: "withheld", toolIds: [] as const, rootIds: bundle.rootIds, prerequisiteIds: bundle.prerequisiteIds,
      gaps: [{ reason: "dependency_unavailable", ids: bundle.blockedIds }] });

  const toolIds = bundle.context.state.loadedIds;
  const bytesById = new Map(catalog.entries.map(entry => [entry.id, entry.schemaBytes]));
  const schemaBytes = toolIds.reduce((sum, id) => sum + bytesById.get(id)!, 0);
  const gaps: BundleGap[] = [];
  if (toolIds.length > maxTools) gaps.push({ reason: "too_many_tools", actual: toolIds.length, limit: maxTools });
  if (schemaBytes > maxBytes) gaps.push({ reason: "schema_too_large", actual: schemaBytes, limit: maxBytes });
  if (gaps.length)
    return freeze({ ...common, receipt, status: "withheld", toolIds: [] as const, rootIds: bundle.rootIds, prerequisiteIds: bundle.prerequisiteIds, gaps });
  return freeze({ ...common, receipt, status: "selected", toolIds: [...toolIds], rootIds: bundle.rootIds, prerequisiteIds: bundle.prerequisiteIds, schemaBytes });
}

export type ToolExposureMode = "off" | "shadow" | "on";

export interface PrepareToolExposureOptions {
  mode: ToolExposureMode;
  /** Tool set currently exposed by the host. */
  baselineIds: readonly string[];
  result: ToolRouteResult;
  /** Tools that stay exposed in `on` mode (e.g. read/search); unregistered ids are dropped. */
  residentIds?: readonly string[];
}

export interface ToolExposure {
  mode: ToolExposureMode;
  /** The tool set the host should expose. */
  activeIds: readonly string[];
  /** True when `on` could not use a selected bundle and kept the baseline. */
  fallback: boolean;
  /** Shadow-only recommendation; never applied. */
  suggestion?: { status: ToolRouteResult["status"]; toolIds: readonly string[]; addedIds: readonly string[]; removedIds: readonly string[] };
  /** Resident ids ignored because they are not registered-and-available. */
  droppedResidentIds: readonly string[];
}

/** off/shadow keep the baseline; on exposes the selected bundle plus resident tools. */
export function prepareToolExposure({ mode, baselineIds, result, residentIds = [] }: PrepareToolExposureOptions): ToolExposure {
  if (mode !== "off" && mode !== "shadow" && mode !== "on") throw Error("Unknown tool exposure mode; choose off, shadow or on.");
  const baseline = [...baselineIds];
  const hostAvailable = new Set(result.hostAvailableIds);
  const residents = Array.from(new Set(residentIds));
  const droppedResidentIds = residents.filter(id => !hostAvailable.has(id));
  const bundleIds = result.status === "selected" ? [...new Set([...result.toolIds, ...residents.filter(id => hostAvailable.has(id))])] : [];
  if (mode === "off") return freeze({ mode, activeIds: baseline, fallback: false, droppedResidentIds });
  if (mode === "shadow") {
    const base = new Set(baseline), proposed = new Set(bundleIds);
    return freeze({ mode, activeIds: baseline, fallback: false, droppedResidentIds,
      suggestion: { status: result.status, toolIds: bundleIds, addedIds: bundleIds.filter(id => !base.has(id)), removedIds: baseline.filter(id => !proposed.has(id)) } });
  }
  if (result.status !== "selected") return freeze({ mode, activeIds: baseline, fallback: true, droppedResidentIds });
  return freeze({ mode, activeIds: bundleIds, fallback: false, droppedResidentIds });
}
