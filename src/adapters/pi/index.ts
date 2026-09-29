/**
 * Pi extension entry: `pi --extension src/adapters/pi/index.ts`.
 *
 * The factory starts no timers, processes or sockets. Within one process only the first
 * loaded copy registers; later copies are detected, registered nowhere, and reported to the
 * owner (telemetry diagnostic + `/jev status`). The claim is released on `session_shutdown`
 * so a runtime reload registers again.
 *
 * The single owner registers everything through `PiHost.register()`: routing on
 * `before_agent_start`, the action harness (`./harness.ts`) on `tool_call`, `tool_result`,
 * `message_end`, `input`, `agent_before_settle` and `agent_settled`, and the compatibility tools
 * `jev_acceptance_gate` / `foreman_assess`; request-level context reduction on `context`
 * (`./context.ts`) and `jev_recall` (registered at the first session whose `context.request` is
 * not off). A duplicate copy registers none of them, so no tool
 * call is checked or blocked twice and no checkpoint is assessed twice.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiHost, defaultHostDeps, type HostDeps, type PiHost } from "./host.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.pi");

interface Claim {
  host: PiHost;
}

type ClaimRegistry = { [CLAIM]?: Claim };

export function createExtension(overrides: Partial<HostDeps> = {}, registry: ClaimRegistry = globalThis as ClaimRegistry) {
  return function piJevHarness(pi: ExtensionAPI): void {
    const existing = registry[CLAIM];
    if (existing) {
      existing.host.noteDuplicateLoad();
      return;
    }
    const claim: Claim = {
      host: createPiHost(pi, defaultHostDeps(overrides), () => {
        if (registry[CLAIM] === claim) delete registry[CLAIM];
      }),
    };
    registry[CLAIM] = claim;
    claim.host.register();
  };
}

export default createExtension();
