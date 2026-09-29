/** Command dispatch for `pi-jev`; exit codes are documented in `src/cli.ts`. */
import { parseArgs } from "node:util";
import { VERSION } from "../index.ts";
import { CliError, type CliDeps } from "./context.ts";
import { doctor, renderDoctor } from "./doctor.ts";
import { writeShareExport } from "./export.ts";
import { loadRun, renderRun, renderTelemetry, telemetryReport } from "./report.ts";
import { renderReplay, replay } from "./replay.ts";
import { renderRunResult, runTask } from "./run.ts";

export const EXIT = { ok: 0, error: 1, notCompleted: 2, mismatch: 3 } as const;

const USAGE = [
  "用法：",
  "  pi-jev --version",
  "  pi-jev run [--cwd <目录>] [--json] [--max-time <时长，如 90s、10m、1h>] [--] <任务...>",
  "    任务以 - 开头时，先写 --（如 pi-jev run -- \"--verbose 参数失效\"）；任务不能以 / 开头。",
  "  pi-jev doctor [--json]",
  "  pi-jev report <run-id|path> [--json]",
  "  pi-jev report <run-id|path> [--export <file.json>] [--export-md <file.md>] [--force]",
  "    分享导出：不含凭据、任务正文、源码、工具参数与原始输出，home 路径写成 ~；已存在的文件需 --force 才覆盖",
  "  pi-jev report --telemetry [dir] [--json]",
  "  pi-jev replay <run-id|path|receipts.jsonl> [--trusted <file.json>] [--json]",
].join("\n");

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function dispatch(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version") {
    deps.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (command === "run") {
    const outcome = await runTask(rest, deps);
    deps.out(outcome.json ? json(outcome.result) : renderRunResult(outcome));
    const { status, sessionError } = outcome.result;
    if (sessionError !== null || status === "artifacts_missing" || status === "failed") return EXIT.error;
    return status === "completed" ? EXIT.ok : EXIT.notCompleted;
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      telemetry: { type: "boolean" },
      trusted: { type: "string" },
      export: { type: "string" },
      "export-md": { type: "string" },
      force: { type: "boolean" },
    },
  });
  const exporting = values.export !== undefined || values["export-md"] !== undefined;
  const exportFlags = exporting || values.force === true;
  switch (command) {
    case "doctor": {
      if (positionals.length > 0 || values.telemetry || values.trusted !== undefined || exportFlags) break;
      const report = await doctor(deps);
      deps.out(values.json ? json(report) : renderDoctor(report));
      return EXIT.ok;
    }
    case "report": {
      if (values.trusted !== undefined) break;
      if (exportFlags && (!exporting || values.telemetry || values.json)) break;
      if (values.telemetry) {
        if (positionals.length > 1) break;
        const result = await telemetryReport(positionals[0], deps);
        deps.out(values.json ? json(result.audit ? { ...result.report, audit: result.audit } : result.report) : renderTelemetry(result));
        return EXIT.ok;
      }
      if (positionals.length !== 1) break;
      const loaded = await loadRun(positionals[0]!, deps);
      if (exporting) {
        const written = await writeShareExport(loaded, { json: values.export, md: values["export-md"], force: values.force === true }, deps);
        deps.out(written.map((path) => `已导出分享报告：${path}\n`).join(""));
      } else deps.out(values.json ? loaded.text : renderRun(loaded));
      return loaded.run.status === "completed" ? EXIT.ok : EXIT.notCompleted;
    }
    case "replay": {
      if (positionals.length !== 1 || values.telemetry || exportFlags) break;
      const report = await replay(positionals[0]!, deps, values.trusted);
      deps.out(values.json ? json(report) : renderReplay(report));
      return report.counts.mismatch > 0 ? EXIT.mismatch : EXIT.ok;
    }
  }
  deps.err(`${USAGE}\n`);
  return EXIT.error;
}

/** Run one CLI invocation; returns the process exit code. Never throws. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    if (error instanceof CliError) deps.err(`${error.message}\n`);
    else if (error instanceof TypeError && (error as { code?: unknown }).code?.toString().startsWith("ERR_PARSE_ARGS")) deps.err(`${error.message}\n${USAGE}\n`);
    else deps.err(`pi-jev 内部错误：${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  }
}
