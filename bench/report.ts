#!/usr/bin/env node
/**
 * `node bench/report.ts <out-dir>`: read `results.jsonl` + `meta.json` written by bench/run.ts,
 * print the Markdown report, and write `report.md` and `report.json` next to them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { computeReport, renderBenchErrors, renderReport } from "./lib/report-core.ts";
import type { BenchMeta, ResultRecord } from "./lib/types.ts";

const dir = process.argv[2];
if (!dir || process.argv.length !== 3) {
  process.stderr.write("usage: node bench/report.ts <out-dir>\n");
  process.exit(1);
}
const out = resolve(dir);
const text = await readFile(join(out, "results.jsonl"), "utf8");
const records = text
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as ResultRecord);
let meta: BenchMeta | null = null;
try {
  meta = JSON.parse(await readFile(join(out, "meta.json"), "utf8")) as BenchMeta;
} catch {
  meta = null;
}
let benchErrors: string[] = [];
try {
  benchErrors = (await readFile(join(out, "bench-errors.txt"), "utf8")).split("\n");
} catch {
  benchErrors = [];
}
const report = computeReport(records, meta);
// Runs that failed inside the bench have no outcome: listed in their own section, never in metrics.
const section = renderBenchErrors(benchErrors, records, meta);
const md = section.length > 0 ? `${renderReport(report)}\n${section.join("\n")}\n` : renderReport(report);
await writeFile(join(out, "report.md"), md);
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(md);
