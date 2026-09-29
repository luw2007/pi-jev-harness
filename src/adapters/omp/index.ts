/**
 * OMP extension entry: `omp --extension src/adapters/omp/index.ts`.
 *
 * Off by default. Within one process only the first loaded copy registers; later copies register
 * nothing and are reported (telemetry diagnostic + `/jev status`). The claim is released on
 * `session_shutdown`; the same API object never registers twice, even after that. The claim symbol differs from the Pi adapter's so the two never collide.
 */
import { createOmpHost, defaultOmpHostDeps, type OmpHost, type OmpHostDeps } from "./host.ts";
import type { OmpExtensionAPI } from "./types.ts";

const CLAIM = Symbol.for("pi-jev-harness.adapter.omp");
/** Every OMP API object this process ever registered on; shared by all loaded copies. */
const REGISTERED = Symbol.for("pi-jev-harness.adapter.omp.registered");

interface Claim {
  host: OmpHost;
}

type ClaimRegistry = { [CLAIM]?: Claim; [REGISTERED]?: WeakSet<object> };

export function createExtension(overrides: Partial<OmpHostDeps> = {}, registry: ClaimRegistry = globalThis as ClaimRegistry) {
  return function piJevHarnessOmp(api: OmpExtensionAPI): void {
    // Each API object registers at most once, even after the session claim was released.
    const registered = (registry[REGISTERED] ??= new WeakSet());
    const existing = registry[CLAIM];
    if (existing || registered.has(api)) {
      existing?.host.noteDuplicateLoad();
      return;
    }
    registered.add(api);
    const claim: Claim = {
      host: createOmpHost(api, defaultOmpHostDeps(overrides), () => {
        if (registry[CLAIM] === claim) delete registry[CLAIM];
      }),
    };
    registry[CLAIM] = claim;
    claim.host.register();
  };
}

export default createExtension();
