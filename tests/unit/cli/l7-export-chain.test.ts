/** the share export scrubs every configured Jev chain key, not only TYPESAFE_API_KEY. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REDACTED, writeShareExport } from "../../../src/cli/export.ts";
import type { LoadedRun } from "../../../src/cli/report.ts";
import type { RunJson } from "../../../src/harness/index.ts";

test("export redacts a chain provider key (keyEnv) found in a reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "l7-export-"));
  try {
    const secret = "plainchainvalue0123456789";
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ jev: { providers: [{ id: "alpha", url: "https://alpha.example.invalid/v1", model: "m", identity: "none", timeoutMs: 1000, keyEnv: "ALPHA_KEY" }] } }));
    const run = { schemaVersion: 1, runId: "run_l7", status: "incomplete", workspace: "/w", changes: [], verification: [], reasons: [`leaked ${secret}`], remaining: [], usage: {} } as unknown as RunJson;
    const loaded: LoadedRun = { dir, text: "", run, task: null, summaryPresent: false };
    const out = join(dir, "x.json");
    await writeShareExport(loaded, { json: out, force: false }, { env: { ALPHA_KEY: secret }, home: "/nohome", cwd: dir, configPath, harnessRoot: "/", out: () => {}, err: () => {}, execFile: () => "" });
    const text = await readFile(out, "utf8");
    assert.ok(!text.includes(secret));
    assert.ok(text.includes(REDACTED));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
