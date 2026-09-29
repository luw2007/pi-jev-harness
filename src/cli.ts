#!/usr/bin/env node
/**
 * `pi-jev` CLI. `run` starts one Pi session with the pi-jev extension in an explicit workspace and
 * waits for it to settle. `doctor`, `report`, and `replay` read local state only; none starts a
 * task, calls a provider or Jev, or re-runs a recorded action. The only files they write are
 * `doctor`'s removed-at-once probe files and the files named by `report --export/--export-md`.
 *
 * Exit codes describe whether the command itself did its job, not whether the task succeeded:
 * - 0: the command succeeded (for `run` and `report`, `run.json` says the task is `completed`;
 *   for `replay`, no receipt is a mismatch — cannot_verify still exits 0 and is listed in the output;
 *   `doctor` exits 0 even when a check warns or fails, including a Pi version other than the pinned
 *   one or an expected tool that is not registered).
 * - 1: the command could not run: bad usage (including a `run` task starting with `/`), missing workspace or other input, incomplete run
 *   products (no `run.json`; `run` reports status `artifacts_missing`), a Pi session that failed
 *   to start or errored (including every model request failing: `sessionError` carries the
 *   provider error, credentials scrubbed), a `run` whose `run.json` status is `failed`,
 *   `report --export` refusing an existing file without `--force` or failing to write, or an
 *   internal error.
 * - 2: `run` or `report` read `run.json`, and its task status is anything but `completed`
 *   (incomplete, blocked, cancelled, failed, verification_unavailable; `run` exits 1 for failed).
 *   `report --export` keeps this rule: the export was written, and the code still reports the task
 *   status. A `run` aborted by `--max-time` is never `completed`: a `completed` run.json is
 *   reported as `cancelled`. Also `run` with status `native_off`: the adapter's effective mode is
 *   off, so it recorded no run products by design.
 * - 3: `replay` found at least one receipt that is a mismatch.
 * - 130: a second SIGINT/SIGTERM during `run`. The first one aborts the session, waits up to 10 s
 *   for the adapter to write the cancelled `run.json`, prints the normal result and exits 2
 *   (1 when no `run.json` was written in time).
 *
 * The task outcome itself is `run.json.status`; a process may exit normally while the task is
 * incomplete, blocked, or its acceptance unavailable. Scripts read the status, not just `$?`.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli/main.ts";
import { createPiSession } from "./cli/pi-session.ts";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  harnessRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  execFile: (command, args) => execFileSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  createSession: createPiSession,
  signals: {
    subscribe(handler) {
      const on = (signal: NodeJS.Signals) => handler(signal as "SIGINT" | "SIGTERM");
      process.on("SIGINT", on);
      process.on("SIGTERM", on);
      return () => {
        process.off("SIGINT", on);
        process.off("SIGTERM", on);
      };
    },
    exit: (code) => process.exit(code),
  },
});
