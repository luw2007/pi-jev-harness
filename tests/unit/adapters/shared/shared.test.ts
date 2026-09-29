import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as shared from "../../../../src/adapters/shared/index.ts";
import * as piConfig from "../../../../src/adapters/pi/config.ts";
import * as piTools from "../../../../src/adapters/pi/tools.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SHARED_DIR = join(ROOT, "src/adapters/shared");
const HOST_PACKAGE = /^@earendil-works\//;

/** Every import/export-from/side-effect/dynamic import specifier, flagged as type-only when erased at runtime. */
function specifiers(source: string): { specifier: string; typeOnly: boolean }[] {
  const out: { specifier: string; typeOnly: boolean }[] = [];
  const fromClause = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(fromClause)) out.push({ specifier: match[3]!, typeOnly: Boolean(match[2]) });
  for (const match of source.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) out.push({ specifier: match[1]!, typeOnly: false });
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) out.push({ specifier: match[1]!, typeOnly: false });
  return out;
}

/** Transitive graph from every file in src/adapters/shared, following relative specifiers. */
function runtimeHostImports(): { files: string[]; offenders: string[] } {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = readdirSync(SHARED_DIR).filter((name) => name.endsWith(".ts")).map((name) => join(SHARED_DIR, name));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, typeOnly } of specifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else if (HOST_PACKAGE.test(specifier) && !typeOnly) offenders.push(`${file.slice(ROOT.length + 1)} -> ${specifier}`);
    }
  }
  return { files: [...seen], offenders };
}

test("specifier scanner treats only `import type`/`export type` as erased", () => {
  const found = specifiers([
    'import type { A } from "@earendil-works/pi-coding-agent";',
    'import { type B } from "@earendil-works/pi-coding-agent";',
    'import {\n  c,\n  d,\n} from "@earendil-works/pi-ai";',
    'export * from "./x.ts";',
    'import "@earendil-works/side";',
    'const m = await import("@earendil-works/dyn");',
  ].join("\n"));
  assert.deepEqual(found, [
    { specifier: "@earendil-works/pi-coding-agent", typeOnly: true },
    { specifier: "@earendil-works/pi-coding-agent", typeOnly: false },
    { specifier: "@earendil-works/pi-ai", typeOnly: false },
    { specifier: "./x.ts", typeOnly: false },
    { specifier: "@earendil-works/side", typeOnly: false },
    { specifier: "@earendil-works/dyn", typeOnly: false },
  ]);
});

test("src/adapters/shared has no runtime import of a Pi package, transitively", () => {
  const { files, offenders } = runtimeHostImports();
  assert.ok(files.some((file) => file.endsWith("src/jev/index.ts")), "graph follows into shared dependencies");
  assert.deepEqual(offenders, []);
});

test("importing the shared entry never resolves a Pi package at runtime", () => {
  const hook = `export async function resolve(specifier, context, next) {
    if (/^@earendil-works\\//.test(specifier)) throw new Error("host package resolved: " + specifier);
    return next(specifier, context);
  }`;
  const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});`;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(register)}`,
    "--input-type=module", "-e", `const m = await import(${JSON.stringify(join(SHARED_DIR, "index.ts"))}); console.log(Object.keys(m).sort().join(","));`,
  ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), Object.keys(shared).sort().join(","));
});

test("shared entry exports exactly the host-neutral config and tool-chooser API (T051: no model chooser)", () => {
  assert.deepEqual(Object.keys(shared).sort(), [
    "MODEL_ROUTING_IGNORED_NOTE", "containsCredential", "createJevToolRouter", "defaultConfig", "loadConfig", "readJevKey", "truncateIntent",
  ]);
  for (const name of ["containsCredential", "createJevToolRouter", "defaultConfig", "loadConfig", "readJevKey", "truncateIntent"] as const) {
    assert.equal(typeof shared[name], "function", name);
  }
});

test("Pi adapter modules re-export the same shared implementations", () => {
  assert.equal(piConfig.loadConfig, shared.loadConfig);
  assert.equal(piConfig.defaultConfig, shared.defaultConfig);
  assert.equal(piConfig.containsCredential, shared.containsCredential);
  assert.equal(piConfig.readJevKey, shared.readJevKey);
  assert.equal(piTools.createJevToolRouter, shared.createJevToolRouter);
  assert.equal(piTools.truncateIntent, shared.truncateIntent);
});
