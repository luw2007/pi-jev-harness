// Read side of the context archive, for the `jev_recall` tool. Validation of the handle and
// the integrity check live in spill.ts; this module only fixes the tool name and the contract:
// the caller passes a handle string produced by `spillNotice`, never a path, and the result is
// the archived bytes or a typed error. Nothing is executed or re-run.
import { isAbsolute } from "node:path";
import { recallPayload, type RecallFailureReason, type SpillFs } from "./spill.ts";

/** Tool name the adapter registers; results of this tool are never reduced again. */
export const RECALL_TOOL_NAME = "jev_recall";

export interface RecallRequest {
  /** Untrusted tool argument; only `spill:<sessionId>:<sha256>` is accepted. */
  handle: unknown;
  /** Session of the calling agent; a handle of another session is rejected. */
  sessionId: string;
  /** Archive root configured by the adapter (absolute). Never taken from the model. */
  dir: string;
  fs?: SpillFs;
}

export type RecallErrorReason = RecallFailureReason | "invalid_dir";

export type RecallOutcome =
  | { ok: true; content: string }
  | { ok: false; reason: RecallErrorReason; detail?: string };

export async function recall(request: RecallRequest): Promise<RecallOutcome> {
  if (typeof request.dir !== "string" || !isAbsolute(request.dir)) return { ok: false, reason: "invalid_dir" };
  if (typeof request.handle !== "string") return { ok: false, reason: "invalid_handle" };
  return recallPayload(request.dir, request.handle, {
    sessionId: request.sessionId,
    ...(request.fs ? { fs: request.fs } : {}),
  });
}
