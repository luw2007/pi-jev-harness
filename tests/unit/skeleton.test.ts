import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { VERSION as rootVersion } from "../../src/index.ts";
import { VERSION as routerVersion } from "../../src/router/index.ts";
import { VERSION as harnessVersion } from "../../src/harness/index.ts";

test("three package entrypoints export the same VERSION", () => {
  assert.equal(rootVersion, routerVersion);
  assert.equal(rootVersion, harnessVersion);
});

test("pi-jev --version exits successfully", () => {
  const output = execFileSync(process.execPath, ["src/cli.ts", "--version"], {
    encoding: "utf8",
  });

  assert.equal(output.trim(), rootVersion);
});
