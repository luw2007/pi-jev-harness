/**
 * verifier regression: the real `createPiSession` must leave the session with its extensions
 * bound (Pi's `session_start` emitted), as every Pi mode does via `session.bindExtensions()`.
 * Without it the pi-jev adapter never starts a session and `pi-jev run` can never find run.json.
 * Offline: real Pi SDK, temp agent dir, no prompt, no model request.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiSession } from "../../../src/cli/pi-session.ts";

test("T031: createPiSession returns a session whose extensions saw session_start", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-session-"));
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, runId: process.env.PI_JEV_RUN_ID, runsDir: process.env.PI_JEV_RUNS_DIR };
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "ws");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd);
    const marker = join(root, "session_start.txt");
    const extension = join(root, "probe.ts");
    await writeFile(extension, `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_start", () => appendFileSync(${JSON.stringify(marker)}, "x")); }\n`);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const session = await createPiSession({ cwd, env: { PI_JEV_RUN_ID: "t031", PI_JEV_RUNS_DIR: join(root, "runs") }, extensionPath: extension });
    try {
      assert.equal(await readFile(marker, "utf8").catch(() => ""), "x", "session_start reached the extension before the task is prompted");
    } finally {
      session.dispose();
    }
  } finally {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["PI_JEV_RUN_ID", saved.runId], ["PI_JEV_RUNS_DIR", saved.runsDir]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
