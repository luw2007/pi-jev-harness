/**
 * `pi-jev report <run> --export <file>`: shareable view of one run (product §9.2, technical §11).
 * Built from `run.json` and `receipts.jsonl` by allow-list: only ids, statuses, counts, change
 * paths, verification binaries with exit codes, usage, and reason labels are copied. Task text,
 * command arguments, tool arguments, tool outputs, file contents and digests never enter it; the
 * home directory becomes `~`; any string that trips the adapter's credential scan is replaced.
 * Free-text reasons are cut to their label before the first colon (the detail may quote code,
 * commands or reviewer text).
 */
import { access, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { containsCredential, loadConfig, readJevKey } from "../adapters/pi/config.ts";
import { createJevAccess } from "../adapters/shared/jev-access.ts";
import {
  EXECUTION_STATUSES,
  RUN_FILES,
  VERIFICATION_STATUSES,
  TASK_STATUS_LABELS,
  type ExecutionStatus,
  type RunUsage,
  type TaskStatus,
  type UsageTotal,
  type VerificationStatus,
} from "../harness/index.ts";
import { CliError, readOptional, type CliDeps } from "./context.ts";
import type { LoadedRun } from "./report.ts";

export const SHARE_EXPORT_SCHEMA = "pi-jev-share-export-v1" as const;
/** Replaces any string the credential scan flags. */
export const REDACTED = "[已移除：疑似凭据]";
const MAX_LABEL_CHARS = 120;

export interface ShareExport {
  schema: typeof SHARE_EXPORT_SCHEMA;
  exportedAt: string;
  runId: string;
  status: TaskStatus;
  statusLabel: string;
  /** Home directory replaced with `~`. */
  workspace: string;
  /** Earliest start / latest end over recorded tool evidence (ISO 8601); null when none. */
  timestamps: { firstActionAt: string | null; lastActionAt: string | null };
  /** Workspace-relative paths and change kinds; no contents or digests. */
  changes: { path: string; change: string }[];
  /** `binary` is the first word of the check command (arguments and env assignments dropped). */
  verification: { binary: string; status: string; exitCodes: (number | null)[] }[];
  verificationWaived: string | null;
  /** `value` is null whenever any source is unknown; never zero-filled. */
  usage: Record<keyof RunUsage, UsageTotal>;
  decisions: {
    receipts: number;
    /** Lines of `receipts.jsonl` that were not a readable receipt. */
    unreadableLines: number;
    execution: Record<ExecutionStatus, number>;
    verification: Record<VerificationStatus, number>;
    jevRequests: number;
    jevResponses: number;
  };
  /** Labels of block/failure/fallback reasons from `run.json` and receipts, with counts. */
  fallbackReasons: { label: string; count: number }[];
  remaining: { label: string; count: number }[];
  /** Run products are written only while the adapter is in shadow mode. */
  harness: { mode: "shadow"; enforcedBlocks: number };
  omitted: string[];
}

const OMITTED = ["凭据", "任务正文", "源码与文件内容", "工具参数与命令参数", "原始工具输出", "摘要与完整性哈希", "本机 home 路径（替换为 ~）"];

function scrubber(deps: CliDeps, task: string | null, secrets?: readonly string[]): (text: string) => string {
  const key = secrets ?? readJevKey(deps.env);
  const home = deps.home.replace(/\/+$/, "");
  return (text) => {
    let out = home.length > 1 ? text.split(home).join("~") : text;
    if (task !== null && task.trim().length > 0) out = out.split(task).join("[任务正文已移除]");
    return containsCredential(out, key) || containsCredential(text, key) ? REDACTED : out;
  };
}

/** Text before the first colon (ASCII or full-width), trimmed and bounded. */
function label(text: string): string {
  const head = text.split(/[:：]/, 1)[0]!.trim();
  return head.length > MAX_LABEL_CHARS ? `${head.slice(0, MAX_LABEL_CHARS)}…` : head;
}

/** Split receipt notes on "; " outside parentheses: "validation failed (shadow; not blocked)" stays one note. */
export function splitNotes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "（") depth++;
    else if ((c === ")" || c === "）") && depth > 0) depth--;
    else if (depth === 0 && c === ";" && text[i + 1] === " ") {
      parts.push(text.slice(start, i));
      start = i + 2;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** First word of a command that is not an `NAME=value` assignment, without its directory. */
export function commandBinary(command: string): string {
  const word = command.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
  return basename(word) || "(未知)";
}

function tally(labels: string[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of labels) if (l.length > 0) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, count]) => ({ label: l, count }));
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

interface ReceiptLike {
  request?: unknown;
  response?: unknown;
  execution?: { status?: unknown; reason?: unknown; evidence?: { toolCallId?: unknown; exitCode?: unknown; startedAt?: unknown; endedAt?: unknown }[] };
  verification?: { status?: unknown };
}

/** Build the share export. Pure apart from the clock; reads nothing beyond its arguments. */
export function buildShareExport(loaded: LoadedRun, receiptsText: string | null, deps: CliDeps, now = new Date(), secrets?: readonly string[]): ShareExport {
  const scrub = scrubber(deps, loaded.task, secrets);
  const { run } = loaded;
  const decisions: ShareExport["decisions"] = {
    receipts: 0,
    unreadableLines: 0,
    execution: zero(EXECUTION_STATUSES),
    verification: zero(VERIFICATION_STATUSES),
    jevRequests: 0,
    jevResponses: 0,
  };
  const exitCodes = new Map<string, number | null>();
  const reasonLabels: string[] = (run.reasons ?? []).map(label);
  let first: number | null = null;
  let last: number | null = null;
  for (const line of (receiptsText ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    let receipt: ReceiptLike | undefined;
    try {
      receipt = (JSON.parse(line) as { receipt?: ReceiptLike }).receipt;
    } catch {
      receipt = undefined;
    }
    if (receipt === null || typeof receipt !== "object") {
      decisions.unreadableLines++;
      continue;
    }
    decisions.receipts++;
    if (receipt.request != null) decisions.jevRequests++;
    if (receipt.response != null) decisions.jevResponses++;
    const exec = receipt.execution;
    if ((EXECUTION_STATUSES as readonly unknown[]).includes(exec?.status)) decisions.execution[exec!.status as ExecutionStatus]++;
    const verified = receipt.verification?.status;
    if ((VERIFICATION_STATUSES as readonly unknown[]).includes(verified)) decisions.verification[verified as VerificationStatus]++;
    if (typeof exec?.reason === "string") reasonLabels.push(...splitNotes(exec.reason).map(label));
    for (const e of Array.isArray(exec?.evidence) ? exec.evidence : []) {
      if (typeof e?.toolCallId === "string") exitCodes.set(e.toolCallId, Number.isInteger(e.exitCode) ? (e.exitCode as number) : null);
      if (typeof e?.startedAt === "number" && Number.isFinite(e.startedAt)) first = first === null ? e.startedAt : Math.min(first, e.startedAt);
      if (typeof e?.endedAt === "number" && Number.isFinite(e.endedAt)) last = last === null ? e.endedAt : Math.max(last, e.endedAt);
    }
  }
  const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const;
  const usage = Object.fromEntries(
    usageKeys.map((k) => {
      const t = run.usage?.[k];
      return [k, { value: typeof t?.value === "number" ? t.value : null, known: t?.known ?? 0, sources: t?.sources ?? 0 }];
    }),
  ) as ShareExport["usage"];
  return {
    schema: SHARE_EXPORT_SCHEMA,
    exportedAt: now.toISOString(),
    runId: scrub(run.runId),
    status: run.status,
    statusLabel: TASK_STATUS_LABELS[run.status],
    workspace: scrub(run.workspace),
    timestamps: { firstActionAt: iso(first), lastActionAt: iso(last) },
    changes: (Array.isArray(run.changes) ? run.changes : []).map((c) => ({ path: scrub(c.path), change: c.change })),
    verification: (Array.isArray(run.verification) ? run.verification : []).map((v) => ({
      binary: scrub(commandBinary(v.name)),
      status: v.status,
      exitCodes: (v.evidenceRefs ?? []).map((ref) => exitCodes.get(ref) ?? null),
    })),
    verificationWaived: run.verificationWaiver ? scrub(label(run.verificationWaiver.reason)) : null,
    usage,
    decisions,
    fallbackReasons: tally(reasonLabels.map(scrub)),
    remaining: tally((run.remaining ?? []).map((r) => scrub(label(r)))),
    harness: { mode: "shadow", enforcedBlocks: decisions.execution.blocked },
    omitted: OMITTED,
  };
}

const figure = (t: UsageTotal) => (t.value === null ? `未知（${t.known}/${t.sources}）` : String(t.value));

export function renderShareMarkdown(x: ShareExport): string {
  const lines = [
    `# pi-jev 运行报告 ${x.runId}`,
    "",
    `- 状态：${x.statusLabel}（${x.status}）`,
    `- 工作区：${x.workspace}`,
    `- 时间：${x.timestamps.firstActionAt ?? "未知"} 至 ${x.timestamps.lastActionAt ?? "未知"}`,
    `- 导出时间：${x.exportedAt}`,
    "",
    "## 改动",
    ...(x.changes.length ? x.changes.map((c) => `- ${c.change}：${c.path}`) : ["- 无文件改动。"]),
    "",
    "## 验证",
    ...(x.verification.length
      ? x.verification.map((v) => `- ${v.binary}：${v.status}（退出码 ${v.exitCodes.map((c) => (c === null ? "未知" : c)).join("、") || "无"}）`)
      : ["- 没有执行验证。"]),
    ...(x.verificationWaived ? [`- 无需验证：${x.verificationWaived}`] : []),
    "",
    "## 用量",
    `- 输入 ${figure(x.usage.input)}，输出 ${figure(x.usage.output)}，缓存读 ${figure(x.usage.cacheRead)}，缓存写 ${figure(x.usage.cacheWrite)}，费用 ${x.usage.costUsd.value === null ? figure(x.usage.costUsd) : `$${x.usage.costUsd.value}`}`,
    "",
    "## 决策",
    `- 收据 ${x.decisions.receipts}（无法读取的行 ${x.decisions.unreadableLines}），Jev 请求 ${x.decisions.jevRequests}，响应 ${x.decisions.jevResponses}`,
    `- 执行：${Object.entries(x.decisions.execution).map(([k, n]) => `${k} ${n}`).join("，")}`,
    `- 验证：${Object.entries(x.decisions.verification).map(([k, n]) => `${k} ${n}`).join("，")}`,
    ...(x.fallbackReasons.length ? ["", "## 阻塞、失败与回退原因", ...x.fallbackReasons.map((r) => `- ${r.label}（${r.count}）`)] : []),
    ...(x.remaining.length ? ["", "## 剩余项", ...x.remaining.map((r) => `- ${r.label}（${r.count}）`)] : []),
    "",
    `已排除：${x.omitted.join("、")}。`,
  ];
  return `${lines.join("\n")}\n`;
}

export interface ExportTargets {
  json?: string;
  md?: string;
  force: boolean;
}

/** Write the export files; refuses existing files unless `force`. Returns the written paths. */
export async function writeShareExport(loaded: LoadedRun, targets: ExportTargets, deps: CliDeps): Promise<string[]> {
  const files: [string, (x: ShareExport) => string][] = [];
  if (targets.json !== undefined) files.push([resolve(deps.cwd, targets.json), (x) => `${JSON.stringify(x, null, 2)}\n`]);
  if (targets.md !== undefined) files.push([resolve(deps.cwd, targets.md), renderShareMarkdown]);
  if (files.length === 2 && files[0]![0] === files[1]![0]) throw new CliError("--export 与 --export-md 不能写同一个文件。");
  if (!targets.force)
    for (const [path] of files)
      if (await access(path).then(() => true, () => false)) throw new CliError(`导出文件已存在：${path}（使用 --force 覆盖）`);
  // Every Jev key the config may use (TYPESAFE_API_KEY plus chain keyEnv/keyFile keys).
  const config = (await loadConfig({ home: deps.home, ...(deps.configPath ? { path: deps.configPath } : {}), env: deps.env })).config;
  const secrets = createJevAccess({ config, env: deps.env }).secrets;
  const exported = buildShareExport(loaded, await readOptional(join(loaded.dir, RUN_FILES.receipts)), deps, new Date(), secrets);
  for (const [path, render] of files) {
    try {
      await writeFile(path, render(exported), { encoding: "utf8", flag: targets.force ? "w" : "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new CliError(`导出文件已存在：${path}（使用 --force 覆盖）`);
      throw new CliError(`无法写入导出文件 ${path}：${code ?? String(error)}`);
    }
  }
  return files.map(([path]) => path);
}
