export const VERSION = "0.0.0";

// T051: model routing (models.ts, window.ts, types.ts) was removed; model selection is magpie's.

export { prepareToolExposure, routeToolsForTask, snapshotToolCatalog } from "./tools.ts";
export type {
  BundleGap,
  CatalogEntry,
  HostTool,
  PrepareToolExposureOptions,
  RejectedHostTool,
  RouteToolsForTaskOptions,
  ToolCatalog,
  ToolExposure,
  ToolExposureMode,
  ToolRouteResult,
} from "./tools.ts";
export type { Catalog, RoutingPolicy, RoutingReceipt, ToolDependencies, ToolRouter } from "./tools.ts";
