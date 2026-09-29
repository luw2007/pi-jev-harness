/**
 * The real `CliDeps.createSession`: one Pi `AgentSession` via `createAgentSession()` with the
 * pi-jev extension loaded from its entry file, with its extensions bound (Pi emits `session_start`
 * only in `AgentSession.bindExtensions()`, as every Pi mode calls it). Imported only by
 * `src/cli.ts`; the Pi SDK is loaded lazily so `doctor`/`report`/`replay` never load it.
 */
import type { RunSession, RunSessionOptions } from "./context.ts";

export async function createPiSession({ cwd, env, extensionPath }: RunSessionOptions): Promise<RunSession> {
  // Every loaded copy of the extension (this one, or one the user's Pi settings also list) reads
  // `process.env`, and the first copy to load owns the session. Setting the run variables here
  // makes whichever copy owns it write to the run directory the CLI will read. This process runs
  // exactly one session, so the mutation has no other reader.
  for (const key of ["PI_JEV_RUN_ID", "PI_JEV_RUNS_DIR"] as const) process.env[key] = env[key];
  const { DefaultResourceLoader, createAgentSession, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [extensionPath] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader });
  try {
    // Without this the extension never sees `session_start`, so the harness never runs.
    await session.bindExtensions({
      mode: "print",
      onError: (error) => process.stderr.write(`扩展错误（${error.extensionPath}，${error.event}）：${error.error}\n`),
    });
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}
