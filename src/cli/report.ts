/**
 * `pi-jev report`: offline view of one run's products, or of the local telemetry aggregate.
 * A run directory is complete only when `run.json` exists (convention); without it the
 * products are reported incomplete and nothing else is shown. Reads only.
 */
import { join } from "node:path";
import { loadConfig } from "../adapters/pi/config.ts";
import { RUN_FILES, TASK_STATUSES, TASK_STATUS_LABELS, type RunJson, type TaskStatus, type UsageTotal } from "../harness/index.ts";
import { routingLine } from "../harness/run-artifacts.ts";
import { runReport } from "../telemetry/index.ts";
import { AUDIT_NA_NOTE, auditDirFor, runAuditReport, type AuditReport } from "../telemetry/audit.ts";
import type { FileReport } from "../telemetry/index.ts";
import { CliError, readOptional, resolveRunTarget, type CliDeps } from "./context.ts";

const VERIFICATION_LABELS: Record<string, string> = { passed: "通过", failed: "失败", unavailable: "不可用", not_run: "未运行" };
const CHANGE_LABELS: Record<string, string> = { added: "新增", modified: "修改", deleted: "删除" };
const COMPLETION_LABELS: Record<string, string> = { passed: "通过", incomplete: "未通过", blocked: "阻塞", unavailable: "不可用", not_assessed: "未进行" };

/** One line for `run.json.completion`; null when the run recorded none. */
export function completionLine(completion: RunJson["completion"]): string | null {
  if (!completion) return null;
  const label = COMPLETION_LABELS[completion.status] ?? completion.status;
  const verdict = completion.status === "not_assessed"
    ? label
    : `${label}（${completion.status}，${completion.assessment}）；允许结束：${completion.stopAllowed ? "是" : "否"}`;
  return `完成验收：${verdict}；续跑 ${completion.continuations?.used ?? 0}/${completion.continuations?.max ?? 0}`;
}

export interface LoadedRun {
  dir: string;
  /** Raw `run.json` text, printed verbatim by `--json`. */
  text: string;
  run: RunJson;
  /** `任务：` line of `summary.md`; null when the summary is missing or has no such line. */
  task: string | null;
  summaryPresent: boolean;
}

/** Read `run.json` (required) and `summary.md` (optional). Missing `run.json` is a CliError. */
export async function loadRun(arg: string, deps: CliDeps): Promise<LoadedRun> {
  const { dir } = await resolveRunTarget(arg, deps);
  const text = await readOptional(join(dir, RUN_FILES.run));
  if (text === null) throw new CliError(`产物不完整：${dir} 中没有 ${RUN_FILES.run}（运行未写完或已被删除），无法报告。`);
  let run: RunJson;
  try {
    run = JSON.parse(text) as RunJson;
  } catch {
    throw new CliError(`${join(dir, RUN_FILES.run)} 不是有效 JSON。`);
  }
  if (run === null || typeof run !== "object" || run.schemaVersion !== 1 || !(TASK_STATUSES as readonly unknown[]).includes(run.status))
    throw new CliError(`${join(dir, RUN_FILES.run)} 的 schemaVersion 或 status 无法识别。`);
  const summary = await readOptional(join(dir, RUN_FILES.summary));
  const task = summary?.split("\n").find((line) => line.startsWith("任务："))?.slice("任务：".length) ?? null;
  return { dir, text, run, task, summaryPresent: summary !== null };
}

function figure(total: UsageTotal | undefined, show: (n: number) => string): string {
  if (!total || total.value === null) return total && total.sources > 0 ? `未知（${total.known}/${total.sources} 个来源有数据）` : "未知";
  return show(total.value);
}

export function renderRun(loaded: LoadedRun): string {
  const { run, dir } = loaded;
  const lines = [
    ...(loaded.task !== null ? [`任务：${loaded.task}`] : []),
    `状态：${TASK_STATUS_LABELS[run.status as TaskStatus]}（${run.status}）`,
    `运行编号：${run.runId}`,
    `工作区：${run.workspace}`,
    "",
    "改动",
  ];
  const changes = Array.isArray(run.changes) ? run.changes : [];
  if (changes.length === 0) lines.push("- 无文件改动。");
  for (const c of changes) lines.push(`- ${CHANGE_LABELS[c.change] ?? c.change}：${c.path}`);
  lines.push("", "验证");
  const checks = Array.isArray(run.verification) ? run.verification : [];
  if (checks.length === 0 && !run.verificationWaiver) lines.push("- 没有执行验证。");
  for (const v of checks) lines.push(`- ${v.name}：${VERIFICATION_LABELS[v.status] ?? v.status}`);
  if (run.verificationWaiver) lines.push(`- 无需验证：${run.verificationWaiver.reason}`);
  const completion = completionLine(run.completion);
  if (completion !== null) lines.push("", completion);
  if (run.routing?.tools) lines.push(routingLine({ tools: run.routing.tools }));
  const u = run.usage;
  lines.push(
    "",
    `用量：输入 ${figure(u?.input, String)}，输出 ${figure(u?.output, String)}，缓存读 ${figure(u?.cacheRead, String)}，` +
      `缓存写 ${figure(u?.cacheWrite, String)}，费用 ${figure(u?.costUsd, (n) => `$${n}`)}`,
  );
  if (run.reasons?.length) lines.push("", "阻塞或失败原因", ...run.reasons.map((r) => `- ${r}`));
  if (run.remaining?.length) lines.push("", "剩余项", ...run.remaining.map((r) => `- ${r}`));
  lines.push(
    "",
    `报告位置：${dir}`,
    `- ${RUN_FILES.summary}${loaded.summaryPresent ? "" : "（缺失）"}、${RUN_FILES.run}、${RUN_FILES.receipts}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Aggregate of the local telemetry directory; defaults to the configured `telemetryDir`. */
/** Telemetry aggregate plus the sibling audit directory (`<dir>/../audit`), when present. */
export async function telemetryReport(dir: string | undefined, deps: CliDeps): Promise<{ dir: string; report: FileReport; audit?: AuditReport }> {
  const target =
    dir ?? (await loadConfig({ home: deps.home, ...(deps.configPath ? { path: deps.configPath } : {}), env: deps.env })).config.telemetryDir;
  try {
    const report = await runReport(target);
    const audit = await runAuditReport(auditDirFor(target));
    return { dir: target, report, ...(audit ? { audit } : {}) };
  } catch (error) {
    throw new CliError(`无法读取 telemetry 目录 ${target}：${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}

function stat(n: number | null): string {
  return n === null ? "未知" : `${n}ms`;
}

export function renderTelemetry({ dir, report: r, audit }: { dir: string; report: FileReport; audit?: AuditReport }): string {
  const lines = [
    `telemetry 目录：${dir}（仅本地查看；只含类别、耗时、计数与已知用量，不含正文）`,
    `文件 ${r.files}，行 ${r.lines}，事件 ${r.events}，跳过 ${r.skipped}，去重 ${r.duplicatesDropped}`,
    `耗时：p50 ${stat(r.durationMs.p50)}，p90 ${stat(r.durationMs.p90)}，p99 ${stat(r.durationMs.p99)}`,
    `token 覆盖：${r.tokenCoverage.known}/${r.tokenCoverage.total}`,
  ];
  if (r.groups.length > 0) lines.push("", "按类别与结果");
  for (const g of r.groups) {
    const cost = g.costUsd.sum === null ? "未知" : `$${g.costUsd.sum}（${g.costUsd.known}/${g.costUsd.total} 有数据）`;
    lines.push(`- ${g.kind} / ${g.outcome}：${g.events} 次，p50 ${stat(g.durationMs.p50)}，费用 ${cost}`);
  }
  if (audit) {
    lines.push("", `审计（stop/route/autorun/approval）：文件 ${audit.files}，行 ${audit.lines}，接受 ${audit.accepted}，跳过 ${audit.skipped}`);
    for (const g of audit.groups) {
      const requests = g.requests.count === null ? "未知" : String(g.requests.count);
      const cache = g.cache.known === 0 ? "N/A" : `${g.cache.hits}/${g.cache.reads}`;
      const chars = g.characterReduction.known === 0 ? "N/A" : String(g.characterReduction.reducedCharacters);
      lines.push(`- ${g.plugin} / ${g.event} / ${g.mode} / ${g.outcome}：${g.events} 次，p50 ${stat(g.durationMs.p50)}，p95 ${stat(g.durationMs.p95)}，Jev 请求 ${requests}，缓存命中 ${cache}，字符缩减 ${chars}`);
    }
    if (audit.groups.every((g) => g.cache.known === 0 && g.characterReduction.known === 0)) lines.push(`注：${AUDIT_NA_NOTE}`);
  }
  return `${lines.join("\n")}\n`;
}
