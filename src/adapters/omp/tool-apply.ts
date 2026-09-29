/**
 * apply the routed tool bundle to the OMP host (session mode `on` + `router.tools: "on"`).
 *
 * Same rules as the Pi adapter (`../pi/host.ts` applyTools/restoreTools), through the host port:
 * - the routed bundle plus resident read/search/exec/Jev tools, intersected with the current host
 *   set (never re-enables a tool someone disabled); only removals are made and only those are owned;
 * - `await applyToolSet` (OMP `setActiveTools` is async) then read back; a mismatch restores;
 * - no bundle (Jev unavailable, withheld, no match) keeps the native tools;
 * - task end gives back only the owned removals that are still missing.
 * shadow never calls this module's writers; it records the would-apply suggestion only.
 */
import { applyToolSet, restoreOwnedTools, sameToolSet, type HostPort } from "../core/port.ts";
import { prepareToolExposure, type ToolRouteResult } from "../../router/index.ts";

/** OMP builtin read/search/exec tools and this adapter's own tools; kept whenever a bundle is applied. */
export const OMP_RESIDENT_TOOL_IDS: readonly string[] = [
  "read", "grep", "find", "glob", "ls", "bash",
  "jev_acceptance_gate", "foreman_assess", "jev_route", "jev_recall", "jev_plan",
];

type ToolPort = Pick<HostPort, "getActiveTools" | "setActiveTools">;

/** Tools this extension removed for the current task. */
export interface AppliedTools {
  baseline: string[];
  applied: string[];
  removed: string[];
}

export type ApplyOutcome =
  | { kind: "applied"; apply: AppliedTools }
  | { kind: "native_kept"; reason: string }
  | { kind: "mismatch"; restored: boolean };

export async function applyRoutedTools(port: ToolPort, result: ToolRouteResult | undefined): Promise<ApplyOutcome> {
  if (!result || result.status !== "selected") return { kind: "native_kept", reason: `no bundle (${result?.status ?? "unavailable"})` };
  let current: string[] | undefined;
  try {
    current = port.getActiveTools();
    const exposure = prepareToolExposure({ mode: "on", baselineIds: current, result, residentIds: OMP_RESIDENT_TOOL_IDS });
    const keep = new Set(exposure.activeIds);
    const target = current.filter((id) => keep.has(id));
    if (target.length === 0) return { kind: "native_kept", reason: "empty target" };
    const applied = await applyToolSet(port, current, target);
    if (!applied.ok) return { kind: "mismatch", restored: applied.restored };
    return { kind: "applied", apply: { baseline: current, applied: applied.readBack, removed: current.filter((id) => !keep.has(id)) } };
  } catch {
    if (current) {
      try { await port.setActiveTools(current); } catch { /* native_kept reported below */ }
    }
    return { kind: "native_kept", reason: "apply failed" };
  }
}

/** Shadow: what `on` would set; the host is not touched. */
export function wouldApply(baseline: readonly string[], result: ToolRouteResult | undefined): string[] | undefined {
  if (!result || result.status !== "selected") return undefined;
  const keep = new Set(prepareToolExposure({ mode: "on", baselineIds: baseline, result, residentIds: OMP_RESIDENT_TOOL_IDS }).activeIds);
  return baseline.filter((id) => keep.has(id));
}

/**
 * Task end: add back owned removals still missing. `external` when the host set differs from what
 * we applied (user/another extension changed it); owned tools are still given back.
 */
export async function restoreTools(port: ToolPort, apply: AppliedTools): Promise<{ restored: boolean; external: boolean }> {
  const current = port.getActiveTools();
  const external = !sameToolSet(current, apply.applied);
  if (!apply.removed.some((id) => !current.includes(id))) return { restored: false, external };
  await port.setActiveTools(restoreOwnedTools(current, apply.removed, apply.baseline));
  return { restored: true, external };
}
