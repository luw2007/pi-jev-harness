import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

type Source = {
  id: string;
  name: string;
  url: string;
  pinned_commit: string;
  current_head: string | null;
  license: string;
  license_path: string | null;
  vendored: boolean;
  notes: string;
  files: unknown[];
  digest: { source: string; target: string; sha256_source: string; sha256_target: string }[];
  adaptations: unknown[];
};

const requiredFields = [
  "id",
  "name",
  "url",
  "pinned_commit",
  "current_head",
  "license",
  "license_path",
  "vendored",
  "notes",
  "files",
  "digest",
  "adaptations",
] as const;

const sources = JSON.parse(
  readFileSync(new URL("../../third_party/sources.json", import.meta.url), "utf8"),
) as Source[];

test("source ledger records complete, pinned source metadata", () => {
  for (const source of sources) {
    for (const field of requiredFields) {
      assert.ok(field in source, `${source.id} is missing ${field}`);
    }

    assert.match(source.pinned_commit, /^[0-9a-f]{40}$/);
    assert.equal(typeof source.vendored, "boolean");
    assert.ok(Array.isArray(source.files));
    assert.ok(Array.isArray(source.digest));
    assert.ok(Array.isArray(source.adaptations));
  }
});

test("MIT sources retain copied licenses", () => {
  for (const source of sources) {
    if (source.license === "MIT") {
      assert.ok(source.license_path, `${source.id} must declare a license path`);
      assert.ok(existsSync(resolve(source.license_path)), `${source.id} license is missing`);
    }
  }
});

test("vendored sources match their recorded digests and ship a license", () => {
  for (const source of sources.filter((s) => s.vendored)) {
    assert.ok(source.files.length > 0, `${source.id} vendored but files is empty`);
    assert.ok(source.digest.length > 0, `${source.id} vendored but digest is empty`);
    const vendorRoots = new Set<string>();
    for (const entry of source.digest) {
      const target = resolve(entry.target);
      assert.ok(existsSync(target), `${source.id}: ${entry.target} is missing`);
      const actual = createHash("sha256").update(readFileSync(target)).digest("hex");
      assert.equal(actual, entry.sha256_target, `${source.id}: ${entry.target} digest mismatch`);
      vendorRoots.add(entry.target.split("/").slice(0, 2).join("/"));
    }
    for (const root of vendorRoots) {
      assert.ok(existsSync(resolve(root, "LICENSE")), `${source.id}: ${root}/LICENSE is missing`);
    }
  }
});

test("R (license unknown) is never vendored", () => {
  const r = sources.find((s) => s.id === "R");
  assert.ok(r, "R must be recorded");
  assert.equal(r.vendored, false);
});
