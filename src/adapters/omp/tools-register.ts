/**
 * Registration of this adapter's OMP tools: `jev_route`, `jev_acceptance_gate`,
 * `foreman_assess`. Registered once after ownership is checked (at load if OMP exposes its
 * registries, otherwise at `session_start`). A legacy conflict leaves shared names to the
 * legacy plugin. Results use the Pi completion contract (`CompletionResult` as JSON text and
 * details). A host without `registerTool` gets none.
 */
import { ACCEPTANCE_TOOL, FOREMAN_TOOL } from "../core/lifecycle.ts";
import type { HostPort, HostToolResult } from "../core/port.ts";
import { ROUTE_PARAMETERS, ROUTE_TOOL } from "./route.ts";
import type { OmpContext } from "./types.ts";

export const ASSESS_PARAMETERS = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Optional: the answer you are about to give the user (question tasks are judged on it). Treated as an untrusted claim.",
    },
  },
  additionalProperties: false,
} as const;

export interface OmpToolHandlers {
  assess(tool: string, params: unknown, ctx: OmpContext): Promise<HostToolResult>;
  route(params: unknown): Promise<HostToolResult>;
}

/** Names actually registered. */
export function registerOmpTools(port: HostPort<OmpContext>, canRegister: (name: string) => boolean, handlers: OmpToolHandlers): string[] {
  const tools = [
    {
      name: ACCEPTANCE_TOOL,
      label: "Jev acceptance gate",
      description:
        "Light completion check for question or implementation tasks. Judges host evidence (changed files, check results, the answer); returns completionStatus (passed / incomplete / blocked / unavailable), stopAllowed and concrete gaps. Shares one assessment per checkpoint with the automatic check.",
      parameters: ASSESS_PARAMETERS,
      loadMode: "essential" as const,
      execute: (_id: string, params: unknown, _signal: AbortSignal | undefined, _update: unknown, ctx: OmpContext) => handlers.assess(ACCEPTANCE_TOOL, params, ctx),
    },
    {
      name: FOREMAN_TOOL,
      label: "Jev foreman checkpoint",
      description:
        "Milestone checkpoint for long multi-step tasks: ten foreman dimensions over host evidence; returns the same completion contract. Shares one assessment per checkpoint with the automatic check.",
      parameters: ASSESS_PARAMETERS,
      loadMode: "essential" as const,
      execute: (_id: string, params: unknown, _signal: AbortSignal | undefined, _update: unknown, ctx: OmpContext) => handlers.assess(FOREMAN_TOOL, params, ctx),
    },
    {
      name: ROUTE_TOOL,
      label: "Jev route",
      description:
        "Returns the Jev tool-routing suggestion for a task intent: the tool bundle (roots and prerequisites). Suggestion only: nothing is executed or switched. The same intent in this task reuses its earlier routing (no extra request).",
      parameters: ROUTE_PARAMETERS,
      loadMode: "essential" as const,
      execute: (_id: string, params: unknown) => handlers.route(params),
    },
  ];
  const registered: string[] = [];
  for (const tool of tools) {
    if (!canRegister(tool.name)) continue;
    try {
      port.registerTool(tool);
      registered.push(tool.name);
    } catch {
      // Host without registerTool: the adapter runs without its tools.
    }
  }
  return registered;
}
