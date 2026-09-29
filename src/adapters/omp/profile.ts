/**
 * OMP capability profile. OMP 18.3.5 established the event contract used by this adapter;
 * later stable OMP versions inherit that profile. Versions below the minimum, prereleases, and
 * unreadable versions select no profile so the adapter does not guess at an incompatible API.
 */
import type { OmpExtensionAPI } from "./types.ts";

export type OmpProfileId = "session_stop" | "settle";

export interface OmpProfileSpec {
  id: OmpProfileId;
  /** The one end-of-task event of this profile. */
  stopEvent: "session_stop" | "agent_before_settle";
  /** Every event the adapter registers under this profile. */
  events: readonly string[];
}

export interface OmpProfile {
  version: string | undefined;
  spec: OmpProfileSpec | undefined;
  /** Why no profile was selected; present only when `spec` is undefined. */
  reason?: string;
}

/** Minimum OMP version whose event contract is compatible with this adapter. */
export const MINIMUM_OMP_VERSION = "18.3.5";

const SESSION_STOP_PROFILE: OmpProfileSpec = {
  id: "session_stop",
  stopEvent: "session_stop",
  events: ["session_start", "before_agent_start", "session_stop", "session_shutdown", "tool_call", "tool_result", "message_end", "input", "context", "agent_end"],
  // session_before_compact is registered by the host at session start only when compaction is on.
};

function parseStableVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function detectProfile(api: OmpExtensionAPI): OmpProfile {
  let raw: unknown;
  try {
    raw = api.pi?.VERSION;
  } catch {
    raw = undefined;
  }
  if (typeof raw !== "string" || raw.length === 0) return { version: undefined, spec: undefined, reason: "OMP version unreadable (pi.VERSION missing)" };
  const version = parseStableVersion(raw);
  if (!version) return { version: raw, spec: undefined, reason: `OMP ${raw} is not a stable semantic version` };
  const minimum = parseStableVersion(MINIMUM_OMP_VERSION)!;
  if (compareVersions(version, minimum) < 0)
    return { version: raw, spec: undefined, reason: `OMP ${raw} is below minimum supported version ${MINIMUM_OMP_VERSION}` };
  return { version: raw, spec: SESSION_STOP_PROFILE };
}
