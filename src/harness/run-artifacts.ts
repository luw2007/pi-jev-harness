/**
 * Run products (technical §11.1, product §8–§9): `summary.md`, `run.json`, `receipts.jsonl`, and
 * retained `artifacts/`. Every file is written to a private temp file and renamed into place, so
 * a failed write never leaves a partial file. Task status is independent of process exit.
 *
 * `run.json` is always written last and marks the set as complete: readers decide whether a run
 * directory holds finished products by whether `run.json` exists, never by the other files. A
 * directory that already holds `run.json` is refused unless the caller asks to replace it; a
 * replacement deletes the old `run.json` first, so a rewrite failing midway leaves no marker.
 */
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../vendor/jev-harness/src/audit/receipt.ts";
import { COMPLETION_STATUSES, type AssessmentKind, type CompletionStatus } from "./completion.ts";
import type { EvidenceArtifact, FileChange } from "./evidence.ts";
import type { ReceiptUsage, SealedRuntimeReceipt, VerificationStatus } from "./receipt.ts";

export const TASK_STATUSES = ["completed", "incomplete", "blocked", "cancelled", "failed", "verification_unavailable"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** User-visible labels from product §8. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  completed: "已完成",
  incomplete: "已结束，仍未完成",
  blocked: "已阻塞",
  cancelled: "已取消",
  failed: "执行失败",
  verification_unavailable: "已结束，完成验收不可用",
};
const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  passed: "通过",
  failed: "失败",
  unavailable: "不可用",
  not_run: "未运行",
};
const CHANGE_LABELS: Record<FileChange["change"], string> = { added: "新增", modified: "修改", deleted: "删除" };

export const RUN_FILES = { summary: "summary.md", run: "run.json", receipts: "receipts.jsonl", artifacts: "artifacts" } as const;
export const RUN_JSON_SCHEMA_VERSION = 1 as const;

export interface RunVerification {
  name: string;
  status: VerificationStatus;
  /** toolCallIds of the evidence backing this check. */
  evidenceRefs: string[];
}

/**
 * One usage figure summed over its sources. `value` is null unless every source reported it
 * (`known === sources`); a partial sum is never shown, and missing values are never zero.
 */
export interface UsageTotal {
  value: number | null;
  /** Coverage: sources that reported this figure, out of all usage sources in the run. */
  known: number;
  sources: number;
}

export interface RunUsage {
  input: UsageTotal;
  output: UsageTotal;
  cacheRead: UsageTotal;
  cacheWrite: UsageTotal;
  costUsd: UsageTotal;
}

const USAGE_FIELDS = {
  input: "inputTokens",
  output: "outputTokens",
  cacheRead: "cacheReadTokens",
  cacheWrite: "cacheWriteTokens",
  costUsd: "costUsd",
} as const satisfies Record<keyof RunUsage, keyof ReceiptUsage>;

/**
 * Sum provider usage over every model call of a run. Each entry is one source; null means the
 * provider reported no usage for that call. With no sources at all every figure is unknown.
 */
export function summarizeUsage(sources: readonly (ReceiptUsage | null)[]): RunUsage {
  const total = (field: keyof ReceiptUsage): UsageTotal => {
    const values = sources.map((s) => s?.[field] ?? null).filter((v): v is number => v !== null);
    const known = values.length;
    const value = known > 0 && known === sources.length ? values.reduce((a, b) => a + b, 0) : null;
    return { value, known, sources: sources.length };
  };
  return {
    input: total(USAGE_FIELDS.input),
    output: total(USAGE_FIELDS.output),
    cacheRead: total(USAGE_FIELDS.cacheRead),
    cacheWrite: total(USAGE_FIELDS.cacheWrite),
    costUsd: total(USAGE_FIELDS.costUsd),
  };
}

/**
 * Structured completion state (technical §7.2–§7.3): the last completion assessment and the
 * continuation budget. `not_assessed` (with null stopAllowed / assessment) when no checkpoint ran.
 */
export interface RunCompletion {
  status: CompletionStatus | "not_assessed";
  stopAllowed: boolean | null;
  assessment: AssessmentKind | null;
  continuations: { used: number; max: number };
}

const COMPLETION_LABELS: Record<RunCompletion["status"], string> = {
  passed: "通过",
  incomplete: "未通过",
  blocked: "阻塞",
  unavailable: "不可用",
  not_assessed: "未进行",
};

/**
 * How tool routing ended for the task (product §7.5, §8): `off` (not configured), `observed`
 * (shadow suggestion only; the host set was unchanged), `applied` (the routed tool set was put on
 * the host and read back), `fallback` (native tools kept; `reason` says why), or
 * `external_change_kept` (the user or another extension changed the tools afterwards and it was kept).
 */
export const ROUTING_OUTCOMES = ["off", "observed", "applied", "fallback", "external_change_kept"] as const;
export type RoutingOutcomeKind = (typeof ROUTING_OUTCOMES)[number];

export interface RoutingOutcome {
  outcome: RoutingOutcomeKind;
  reason?: string;
  /** Tool names: the suggestion when observed, the active set read back when applied. */
  tools?: string[];
  /** Tools kept exposed by residency (read/search, the exec tool, this extension's own tools) when applied. */
  resident?: string[];
}

/** Tool routing only: model routing was removed (model selection is magpie's). */
export interface RunRouting {
  tools: RoutingOutcome;
}

const ROUTING_LABELS: Record<RoutingOutcomeKind, string> = {
  off: "关闭",
  observed: "仅观察",
  applied: "已应用",
  fallback: "已回退",
  external_change_kept: "外部改动已保留",
};

function routingPart(r: RoutingOutcome): string {
  const detail = [
    ...(r.reason ? [r.reason] : []),
    ...(r.outcome === "applied" && r.tools?.length ? [r.tools.join(",")] : []),
    ...(r.resident?.length ? [`常驻：${r.resident.join(",")}`] : []),
  ];
  return `${ROUTING_LABELS[r.outcome] ?? r.outcome}${detail.length ? `（${detail.join("；")}）` : ""}`;
}

/** One `路由：` line for summary.md and `pi-jev report`. */
export function routingLine(routing: RunRouting): string {
  return `路由：工具 ${routingPart(routing.tools)}`;
}

/** Explicit statement that a completed run needs no verification (for example a Q&A task). */
export interface VerificationWaiver {
  reason: string;
}

export interface RunRecord {
  runId: string;
  task: string;
  status: TaskStatus;
  workspace: string;
  changes: FileChange[];
  verification: RunVerification[];
  /**
   * Required for `completed` unless some verification passed and none is failed, unavailable,
   * or not_run. Shown in `summary.md`.
   */
  verificationWaiver?: VerificationWaiver;
  /** Workspace paths already changed before the task started; never counted in `changes` on their own. */
  preexistingChanges?: string[];
  /** Completion assessment and continuation state; omitted by callers without a controller. */
  completion?: RunCompletion;
  /** Tool routing outcome of the task; omitted by callers without routing. */
  routing?: RunRouting;
  /** Blocking, failure, cancellation, or stop reasons. */
  reasons: string[];
  /** Requirements still open (incomplete / verification_unavailable). */
  remaining: string[];
  receipts: SealedRuntimeReceipt[];
  artifacts: EvidenceArtifact[];
  /** Build with `summarizeUsage`; figures with any unknown source are null. */
  usage: RunUsage;
}

export interface RunJson {
  schemaVersion: typeof RUN_JSON_SCHEMA_VERSION;
  runId: string;
  status: TaskStatus;
  workspace: string;
  changes: FileChange[];
  verification: RunVerification[];
  verificationWaiver?: VerificationWaiver;
  preexistingChanges?: string[];
  completion?: RunCompletion;
  routing?: RunRouting;
  reasons: string[];
  remaining: string[];
  usage: RunUsage;
  report: { dir: string; summary: string; receipts: string; artifacts: string[] };
}

/** Subset of `node:fs/promises` used by the writer; injectable for tests. */
export interface RunArtifactsFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; mode: number; flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  /** Existence check for `run.json`; `node:fs/promises` `access` is used when omitted. */
  access?(path: string): Promise<void>;
}

export interface WriteRunArtifactsOptions {
  /** Overwrite a directory that already holds `run.json`; default false (refuse). */
  replace?: boolean;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ARTIFACT_REF = /^artifacts\/[a-f0-9]{64}\.txt$/;

/** Default run directory: `<home>/.pi/agent/pi-jev-harness/runs/<run-id>/`. */
export function defaultRunDir(homeDir: string, runId: string): string {
  return join(homeDir, ".pi", "agent", "pi-jev-harness", "runs", runId);
}

function validate(run: RunRecord): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(run.runId) || run.runId === "." || run.runId === "..") throw Error("runId must be a safe path segment.");
  if (!(TASK_STATUSES as readonly string[]).includes(run.status)) throw Error(`Unknown task status ${String(run.status)}.`);
  if (run.status === "completed" && run.verification.some((v) => v.status === "failed" || v.status === "unavailable"))
    throw Error("A run with failed or unavailable verification cannot be completed.");
  const waiver = run.verificationWaiver;
  if (waiver !== undefined && (waiver === null || typeof waiver.reason !== "string" || waiver.reason.trim().length === 0))
    throw Error("verificationWaiver needs a non-empty reason.");
  if (run.status === "completed" && waiver === undefined &&
      (!run.verification.some((v) => v.status === "passed") || run.verification.some((v) => v.status !== "passed")))
    throw Error("A completed run needs at least one passed verification and none failed, unavailable, or not_run, or a verificationWaiver.");
  if ((run.status === "blocked" || run.status === "failed") && run.reasons.length === 0) throw Error(`A ${run.status} run needs a reason.`);
  if (run.preexistingChanges !== undefined &&
      (!Array.isArray(run.preexistingChanges) || !run.preexistingChanges.every((p) => typeof p === "string" && p.length > 0)))
    throw Error("preexistingChanges must be a list of non-empty paths.");
  if (run.completion !== undefined) validateCompletion(run.completion);
  if (run.routing !== undefined) validateRouting(run.routing);
  for (const artifact of run.artifacts) if (!ARTIFACT_REF.test(artifact.ref)) throw Error(`Invalid artifact ref ${artifact.ref}.`);
  for (const sealed of run.receipts) if (sealed.receipt.runId !== run.runId) throw Error("Receipt belongs to another run.");
  for (const key of Object.keys(USAGE_FIELDS) as (keyof RunUsage)[]) {
    const { value, known, sources } = run.usage[key];
    if (!Number.isSafeInteger(known) || !Number.isSafeInteger(sources) || known < 0 || known > sources)
      throw Error(`Malformed usage coverage for ${key}.`);
    if ((value === null) !== (known === 0 || known < sources) || (value !== null && !(Number.isFinite(value) && value >= 0)))
      throw Error(`Usage ${key} must be null exactly when a source is unknown.`);
  }
}

function validateCompletion(c: RunCompletion): void {
  const assessed = c.status !== "not_assessed";
  if (assessed && !(COMPLETION_STATUSES as readonly string[]).includes(c.status)) throw Error(`Unknown completion status ${String(c.status)}.`);
  if (assessed ? typeof c.stopAllowed !== "boolean" || (c.assessment !== "acceptance" && c.assessment !== "foreman")
      : c.stopAllowed !== null || c.assessment !== null)
    throw Error("Completion stopAllowed and assessment are set exactly when an assessment ran.");
  const { used, max } = c.continuations ?? {};
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(max) || used! < 0 || max! < 0 || used! > max!)
    throw Error("Completion continuations need 0 <= used <= max.");
}

function validateRouting(r: RunRouting): void {
  const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  for (const part of [r?.tools])
    if (part === null || typeof part !== "object" || !(ROUTING_OUTCOMES as readonly unknown[]).includes(part.outcome) ||
        (part.reason !== undefined && typeof part.reason !== "string") || !strings(part.tools) || !strings(part.resident))
      throw Error("Routing needs a tools outcome from ROUTING_OUTCOMES.");
}

export function buildRunJson(dir: string, run: RunRecord): RunJson {
  return {
    schemaVersion: RUN_JSON_SCHEMA_VERSION,
    runId: run.runId,
    status: run.status,
    workspace: run.workspace,
    changes: run.changes,
    verification: run.verification,
    ...(run.verificationWaiver ? { verificationWaiver: run.verificationWaiver } : {}),
    ...(run.preexistingChanges ? { preexistingChanges: run.preexistingChanges } : {}),
    ...(run.completion ? { completion: run.completion } : {}),
    ...(run.routing ? { routing: run.routing } : {}),
    reasons: run.reasons,
    remaining: run.remaining,
    usage: run.usage,
    report: {
      dir,
      summary: RUN_FILES.summary,
      receipts: RUN_FILES.receipts,
      artifacts: [...new Set(run.artifacts.map((a) => a.ref))].sort(),
    },
  };
}

/** Human-readable summary in the product §9.1 layout; only facts from the run record. */
export function renderSummary(run: RunRecord): string {
  const lines = [`任务：${run.task}`, `状态：${TASK_STATUS_LABELS[run.status]}`, `运行编号：${run.runId}`, `工作区：${run.workspace}`, "", "改动"];
  if (run.changes.length === 0) lines.push("- 无文件改动。");
  for (const c of run.changes) lines.push(`- ${CHANGE_LABELS[c.change]}：${c.path}`);
  if (run.preexistingChanges && run.preexistingChanges.length > 0)
    lines.push("", "任务开始前已有改动（不计入本次改动）", ...run.preexistingChanges.map((p) => `- ${p}`));
  lines.push("", "验证");
  if (run.verification.length === 0 && !run.verificationWaiver) lines.push("- 没有执行验证。");
  for (const v of run.verification) lines.push(`- ${v.name}：${VERIFICATION_LABELS[v.status]}`);
  if (run.verificationWaiver) lines.push(`- 无需验证：${run.verificationWaiver.reason}`);
  if (run.completion) {
    const c = run.completion;
    const verdict = c.status === "not_assessed"
      ? "完成验收：未进行"
      : `完成验收：${COMPLETION_LABELS[c.status]}（${c.status}，${c.assessment}）；允许结束：${c.stopAllowed ? "是" : "否"}`;
    lines.push("", "完成验收", `- ${verdict}；自动续跑：已用 ${c.continuations.used}/${c.continuations.max}`);
  }
  if (run.routing) lines.push("", routingLine(run.routing));
  if (run.reasons.length > 0) lines.push("", "原因", ...run.reasons.map((r) => `- ${r}`));
  if (run.remaining.length > 0) lines.push("", "剩余项", ...run.remaining.map((r) => `- ${r}`));
  const figure = ({ value, known, sources }: UsageTotal, show: (n: number) => string): string =>
    value !== null ? show(value) : sources === 0 ? "未知" : `未知（${known}/${sources} 个来源有数据）`;
  const u = run.usage;
  lines.push(
    "",
    `用量：输入 ${figure(u.input, String)}，输出 ${figure(u.output, String)}，缓存读 ${figure(u.cacheRead, String)}，` +
      `缓存写 ${figure(u.cacheWrite, String)}，费用 ${figure(u.costUsd, (n) => `$${n}`)}`,
  );
  lines.push("", `更多依据：${RUN_FILES.run}、${RUN_FILES.receipts}`);
  return `${lines.join("\n")}\n`;
}

async function writeAtomic(fs: RunArtifactsFs, path: string, data: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    await fs.chmod(temp, FILE_MODE);
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function privateDir(fs: RunArtifactsFs, path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: DIR_MODE });
  await fs.chmod(path, DIR_MODE);
}

async function exists(fs: RunArtifactsFs, path: string): Promise<boolean> {
  try {
    await (fs.access ? fs.access(path) : nodeFs.access(path));
    return true;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Write the run products into `dir` (create with 0700; files 0600). `run.json` is written last,
 * so its presence marks a complete set. Rejects on the first failure. A `dir` already holding
 * `run.json` is refused unless `options.replace`; replacing deletes the old `run.json` before
 * writing anything else.
 */
export async function writeRunArtifacts(
  dir: string,
  run: RunRecord,
  fs: RunArtifactsFs = nodeFs,
  options: WriteRunArtifactsOptions = {},
): Promise<RunJson> {
  validate(run);
  const runJson = buildRunJson(dir, run);
  const runPath = join(dir, RUN_FILES.run);
  if (options.replace === true) await fs.rm(runPath, { force: true });
  else if (await exists(fs, runPath))
    throw Error(`Run directory ${dir} already holds ${RUN_FILES.run}; pass { replace: true } to overwrite it.`);
  await privateDir(fs, dir);
  if (run.artifacts.length > 0) {
    await privateDir(fs, join(dir, RUN_FILES.artifacts));
    const written = new Set<string>();
    for (const artifact of run.artifacts) {
      if (written.has(artifact.ref)) continue;
      written.add(artifact.ref);
      await writeAtomic(fs, join(dir, artifact.ref), artifact.text);
    }
  }
  await writeAtomic(fs, join(dir, RUN_FILES.receipts), run.receipts.map((r) => `${canonicalJson(r)}\n`).join(""));
  await writeAtomic(fs, join(dir, RUN_FILES.summary), renderSummary(run));
  await writeAtomic(fs, runPath, `${JSON.stringify(runJson, null, 2)}\n`);
  return runJson;
}
