/**
 * Translation between Pi host objects and tool-router inputs. The Jev-backed chooser is host-neutral
 * and lives in ../shared/tools.ts; it is re-exported here so Pi imports stay unchanged.
 */
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { HostTool } from "../../router/index.ts";
import { RECALL_TOOL } from "./context.ts";
import { ACCEPTANCE_TOOL, FOREMAN_TOOL } from "./lifecycle.ts";

export * from "../shared/tools.ts";

/** The host's model type (`Model<Api>` from pi-ai), as exposed on the extension context. */
export type PiModel = NonNullable<ExtensionContext["model"]>;

/** Pi tools as router host tools; availability is the host's current active set. */
export function hostToolsFromPi(all: readonly ToolInfo[], active: readonly string[]): HostTool[] {
  const activeSet = new Set(active);
  return all.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    schema: tool.parameters,
    source: tool.sourceInfo?.source ?? "unknown",
    available: activeSet.has(tool.name),
  }));
}

// ---- applying a routed tool bundle in mode `on` -------------------------------------------

/** `jev_route` compatibility tool name. */
export const ROUTE_TOOL = "jev_route";

/**
 * This extension's own tools (product §4.1: the model may call them on demand). They stay resident
 * when a routed bundle is applied and are recorded as resident, never as routed tools. `jev_recall`
 * only while it is active (context reduction effectively on).
 */
export const JEV_TOOL_IDS: readonly string[] = [ACCEPTANCE_TOOL, FOREMAN_TOOL, ROUTE_TOOL, RECALL_TOOL];

/**
 * The host's execution/check tool. Completion needs check evidence and a continuation asks for
 * "补验证", so removing it would make implementation tasks structurally uncompletable.
 * Pi 0.87.1 marks no tool as the shell on `ToolInfo`; its builtin `bash` is the only exec tool.
 * Upgrade when a host exposes such a marker: derive this list from it.
 */
export const EXEC_TOOL_IDS: readonly string[] = ["bash"];

/**
 * Tools kept exposed whenever a routed bundle is applied (technical §6.2, product §7.1): Pi's
 * read/search builtins, the exec tool, and this extension's own tools; routed roots and
 * prerequisites are added on top. Only tools already active stay; names the host has not
 * registered-and-enabled are dropped by `prepareToolExposure`.
 */
export const RESIDENT_TOOL_IDS: readonly string[] = ["read", "grep", "find", "ls", ...EXEC_TOOL_IDS, ...JEV_TOOL_IDS];

/** Resident names for the status line: host tools by name, this extension's own tools as `jev_*`. */
export function residentLabel(resident: readonly string[]): string {
  const host = resident.filter((id) => !JEV_TOOL_IDS.includes(id));
  return [...host, ...(host.length < resident.length ? ["jev_*"] : [])].join(",");
}

/**
 * Host-declared prerequisites for Pi builtins: `edit` replaces exact text, so it needs `read`.
 * Only pairs whose tools are all registered-and-available are declared, so a missing builtin never
 * turns into a `dependency_unregistered` gap.
 */
const BUILTIN_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = { edit: ["read"] };

export function hostDependencies(availableIds: readonly string[]): Record<string, string[]> {
  const available = new Set(availableIds);
  return Object.fromEntries(Object.entries(BUILTIN_DEPENDENCIES)
    .filter(([id, needs]) => available.has(id) && needs.every((need) => available.has(need)))
    .map(([id, needs]) => [id, [...needs]]));
}

export { sameToolSet } from "../core/port.ts";

export { restoreOwnedTools } from "../core/port.ts";
