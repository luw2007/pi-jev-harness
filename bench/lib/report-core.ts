/**
 * Pure report computation for the paired bench (technical §13.2). The independent unit is the
 * task: repeats of a task are averaged inside the task first, then task-level paired differences
 * (arm − baseline) are summarised with a median and a fixed-seed bootstrap 95% interval.
 *
 * Denominators keep every run: failures, timeouts, refusals and missing products all count as
 * not completed. Unknown usage stays null and is reported with its coverage, never as zero.
 */
import { bootstrap, mean, median, quantile, type Interval } from "./stats.ts";
import { CATEGORY_LABELS, type BenchMeta, type Category, type ResultRecord } from "./types.ts";

/** Discussion non-inferiority margin for completion rate (technical §13.2). */
export const NON_INFERIORITY_MARGIN = 0.02;
/** Minimum independent tasks before a non-inferiority claim is even considered (§13.2 initial sample). */
export const MIN_TASKS = 30;

export interface ArmSummary {
  arm: string;
  runs: number;
  completed: number;
  completionRate: number | null;
  /** Raw outcome categories, including every failure kind. */
  outcomes: Record<string, number>;
  /** run.json said completed but the bench acceptance failed. */
  falseCompletions: number;
  /** Reverse mismatch: acceptance passed but run.json exists with a status other than completed. */
  passedNotCompleted: number;
  /** Runs with a readable run.json; mode off (arm A) writes none, so run.json-derived fields are unavailable there. */
  runJsonCoverage: { present: number; runs: number };
  /** Token sums from the Pi session logs; null when any run's figure is unknown. */
  inputTokens: number | null;
  outputTokens: number | null;
  durationP50: number | null;
  durationP95: number | null;
  /** Median duration of runs that did not pass acceptance. */
  timeToFailureP50: number | null;
  /** Sum of cost over all runs / completed runs; null when any run's cost is unknown or none completed. */
  costPerCompleted: number | null;
  costCoverage: { known: number; runs: number };
  invalidToolCallsMean: number | null;
  jevRequests: number | null;
  /** Model attempts (errored included) from Pi session logs; null when any run lacks a log. */
  modelAttempts: number | null;
}

/** Per-task, per-arm aggregate over repeats. */
export interface TaskArmCell {
  runs: number;
  completionRate: number;
  /** Median duration of passing runs; null when none passed. */
  durationCompleted: number | null;
  costPerCompleted: number | null;
  invalidToolCalls: number | null;
  /** Mean input+output tokens per run; null when any run's figure is unknown. */
  tokens: number | null;
}

export interface PairedMetric {
  metric: string;
  /** Per-task difference arm − baseline; tasks with a null side are excluded and counted. */
  diffs: { taskId: string; diff: number }[];
  excluded: number;
  interval: Interval;
}

export interface ArmComparison {
  arm: string;
  baseline: string;
  aa: boolean;
  metrics: PairedMetric[];
  byCategory: { category: string; label: string; completion: PairedMetric; duration: PairedMetric }[];
}

export interface Report {
  meta: BenchMeta | null;
  tasks: number;
  runs: number;
  baseline: string;
  arms: ArmSummary[];
  byCategory: { category: string; label: string; arms: ArmSummary[] }[];
  comparisons: ArmComparison[];
  limitations: string[];
}

const sumKnown = (values: readonly (number | null)[]): number | null =>
  values.length === 0 || values.some((v) => v === null) ? null : (values as number[]).reduce((a, b) => a + b, 0);

function summarizeArm(arm: string, records: readonly ResultRecord[]): ArmSummary {
  const runs = records.filter((r) => r.arm === arm);
  const passed = runs.filter((r) => r.passed);
  const failed = runs.filter((r) => !r.passed);
  const outcomes: Record<string, number> = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const costs = runs.map((r) => r.usage?.costUsd.value ?? null);
  const known = costs.filter((c): c is number => c !== null);
  const costPerCompleted = passed.length > 0 && known.length === runs.length ? known.reduce((a, b) => a + b, 0) / passed.length : null;
  const invalid = runs.map((r) => r.invalidToolCalls);
  const jev = runs.map((r) => r.jevRequests);
  return {
    arm,
    runs: runs.length,
    completed: passed.length,
    completionRate: runs.length === 0 ? null : passed.length / runs.length,
    outcomes,
    falseCompletions: runs.filter((r) => r.runStatus === "completed" && !r.passed).length,
    passedNotCompleted: runs.filter((r) => r.passed && r.runStatus !== null && r.runStatus !== "completed").length,
    runJsonCoverage: { present: runs.filter((r) => r.runStatus !== null).length, runs: runs.length },
    inputTokens: sumKnown(runs.map((r) => r.usage?.input.value ?? null)),
    outputTokens: sumKnown(runs.map((r) => r.usage?.output.value ?? null)),
    durationP50: quantile(passed.map((r) => r.durationMs), 0.5),
    durationP95: quantile(passed.map((r) => r.durationMs), 0.95),
    timeToFailureP50: median(failed.map((r) => r.durationMs)),
    costPerCompleted,
    costCoverage: { known: known.length, runs: runs.length },
    invalidToolCallsMean: invalid.some((v) => v === null) ? null : mean(invalid as number[]),
    jevRequests: jev.some((v) => v === null) ? null : (jev as number[]).reduce((a, b) => a + b, 0),
    modelAttempts: runs.some((r) => r.modelAttempts == null) ? null : runs.reduce((a, r) => a + r.modelAttempts!, 0),
  };
}

export function taskArmCell(records: readonly ResultRecord[]): TaskArmCell {
  const passed = records.filter((r) => r.passed);
  const costs = records.map((r) => r.usage?.costUsd.value ?? null);
  const allKnown = costs.every((c) => c !== null);
  const invalid = records.map((r) => r.invalidToolCalls);
  return {
    runs: records.length,
    completionRate: records.length === 0 ? 0 : passed.length / records.length,
    durationCompleted: median(passed.map((r) => r.durationMs)),
    costPerCompleted: allKnown && passed.length > 0 ? (costs as number[]).reduce((a, b) => a + b, 0) / passed.length : null,
    invalidToolCalls: invalid.some((v) => v === null) ? null : mean(invalid as number[]),
    tokens: (() => {
      const t = records.map((r) => (r.usage?.input.value == null || r.usage?.output.value == null ? null : r.usage.input.value + r.usage.output.value));
      return t.some((v) => v === null) ? null : mean(t as number[]);
    })(),
  };
}

type CellMetric = (c: TaskArmCell) => number | null;

type Stat = (v: readonly number[]) => number | null;

/**
 * Completion is a difference in proportions: the mean of per-task differences (each task's rate
 * averaged over its repeats) with a bootstrap CI of that mean. The other metrics keep the median.
 */
const METRICS: { metric: string; get: CellMetric; stat: Stat }[] = [
  { metric: "completionRate", get: (c) => c.completionRate, stat: mean },
  { metric: "durationCompletedMs", get: (c) => c.durationCompleted, stat: median },
  { metric: "costPerCompletedUsd", get: (c) => c.costPerCompleted, stat: median },
  { metric: "invalidToolCalls", get: (c) => c.invalidToolCalls, stat: median },
  { metric: "tokensPerRun", get: (c) => c.tokens, stat: median },
];

/** Paired task-level differences arm − baseline for one metric. */
export function pairedMetric(metric: string, get: CellMetric, taskIds: readonly string[], cells: Map<string, TaskArmCell>, arm: string, baseline: string, seed: number, stat: Stat = median): PairedMetric {
  const diffs: { taskId: string; diff: number }[] = [];
  let excluded = 0;
  for (const taskId of taskIds) {
    const a = cells.get(`${taskId}\u0000${arm}`);
    const b = cells.get(`${taskId}\u0000${baseline}`);
    const x = a ? get(a) : null;
    const y = b ? get(b) : null;
    if (x === null || y === null) excluded++;
    else diffs.push({ taskId, diff: x - y });
  }
  return { metric, diffs, excluded, interval: bootstrap(diffs.map((d) => d.diff), stat, seed) };
}

export function computeReport(records: readonly ResultRecord[], meta: BenchMeta | null, seed = meta?.seed ?? 1): Report {
  const armIds = meta?.arms.map((a) => a.id) ?? [...new Set(records.map((r) => r.arm))];
  // The baseline is declared in meta.json (from arms.json), never inferred from record order.
  const baseline = meta?.arms.find((a) => a.baseline)?.id;
  if (baseline === undefined) throw new Error("meta.json must declare exactly one baseline arm (baseline: true)");
  const costAvailable = meta?.costAvailable !== false;
  const aaArms = new Set(meta?.arms.filter((a) => a.aaOf !== undefined).map((a) => a.id) ?? []);
  const taskIds = [...new Set(records.map((r) => r.taskId))].sort();
  const categoryOf = new Map(records.map((r) => [r.taskId, r.category]));
  const cells = new Map<string, TaskArmCell>();
  for (const taskId of taskIds)
    for (const arm of armIds) {
      const rs = records.filter((r) => r.taskId === taskId && r.arm === arm);
      if (rs.length > 0) cells.set(`${taskId}\u0000${arm}`, taskArmCell(rs));
    }
  const categories = [...new Set(records.map((r) => r.category))].sort();
  const label = (c: string) => CATEGORY_LABELS[c as Category] ?? c;
  const comparisons: ArmComparison[] = armIds
    .filter((arm) => arm !== baseline)
    .map((arm) => ({
      arm,
      baseline,
      aa: aaArms.has(arm),
      metrics: METRICS.filter((x) => costAvailable || x.metric !== "costPerCompletedUsd").map(({ metric, get, stat }) => pairedMetric(metric, get, taskIds, cells, arm, baseline, seed, stat)),
      byCategory: categories.map((category) => {
        const ids = taskIds.filter((t) => categoryOf.get(t) === category);
        return {
          category,
          label: label(category),
          completion: pairedMetric("completionRate", METRICS[0]!.get, ids, cells, arm, baseline, seed, mean),
          duration: pairedMetric("durationCompletedMs", METRICS[1]!.get, ids, cells, arm, baseline, seed),
        };
      }),
    }));

  const limitations: string[] = [];
  const noRunJson = armIds.filter((a) => records.some((r) => r.arm === a) && records.filter((r) => r.arm === a).every((r) => r.runStatus === null));
  if (noRunJson.length > 0)
    limitations.push(
      `臂 ${noRunJson.join("、")} 没有 run.json（mode off 不写 run.json，结果类别为 native_off）：run.json 状态、“错误宣称完成”、run.json 用量交叉核对对这些臂不可用，不参与比较；工具失败、token、模型请求数对所有臂都取自 Pi 会话日志。`,
    );
  const mismatched = records.filter((r) => r.usageCrossCheck?.match === false).length;
  if (mismatched > 0) limitations.push(`${mismatched} 次运行的 run.json 用量与 Pi 会话日志不一致（以会话日志为准）。`);
  limitations.push(`独立任务数 ${taskIds.length}；同一任务的重复运行先在任务内平均，不计为独立样本。`);
  for (const c of comparisons.filter((c) => !c.aa)) {
    const iv = c.metrics[0]!.interval;
    // Gate on paired tasks (both arms have a result), not on every task seen.
    const paired = c.metrics[0]!.diffs.length;
    const supported = paired >= MIN_TASKS && iv.lo !== null && iv.lo > -NON_INFERIORITY_MARGIN;
    limitations.push(
      supported
        ? `${c.arm} 相对 ${c.baseline}：完成率差值 95% 区间下界 ${fmtPct(iv.lo)} 高于 -2 个百分点（仍需结合 A/A 噪声判断）。`
        : `${c.arm} 相对 ${c.baseline}：样本不足以支持 2 个百分点非劣结论（成对任务数 ${paired}，完成率差值区间 ${fmtInterval(iv, fmtPct)}）。`,
    );
  }
  if (aaArms.size === 0) limitations.push("本次没有 A/A 重复臂，无法给出噪声基线；差值的实际意义无法与随机波动区分。");
  const allRuns = records.length;
  const knownCost = records.filter((r) => r.usage?.costUsd.value != null).length;
  if (!costAvailable) limitations.push("模型配置没有单价，费用不可用：只报告 token 总量，不做费用比较。");
  else if (knownCost < allRuns) limitations.push(`费用覆盖率 ${knownCost}/${allRuns} 次运行；缺失的费用记为未知，涉及的“每完成任务费用”为空，不能得出省钱结论。`);

  return {
    meta,
    tasks: taskIds.length,
    runs: allRuns,
    baseline,
    arms: armIds.map((a) => summarizeArm(a, records)),
    byCategory: categories.map((category) => ({
      category,
      label: label(category),
      arms: armIds.map((a) => summarizeArm(a, records.filter((r) => r.category === category))),
    })),
    comparisons,
    limitations,
  };
}

export const fmtPct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmtMs = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(1)}s`);
const fmtUsd = (v: number | null) => (v === null ? "未知" : `$${v.toFixed(4)}`);
const fmtNum = (v: number | null) => (v === null ? "未知" : v.toFixed(2));
export const fmtInterval = (iv: Interval, f: (v: number | null) => string) =>
  iv.lo === null ? `${f(iv.estimate)} [区间不可得，n=${iv.n}]` : `${f(iv.estimate)} [${f(iv.lo)}, ${f(iv.hi)}]`;

const fmtInt = (v: number | null) => (v === null ? "未知" : String(v));

const FORMAT: Record<string, (v: number | null) => string> = {
  completionRate: fmtPct,
  durationCompletedMs: fmtMs,
  costPerCompletedUsd: fmtUsd,
  invalidToolCalls: fmtNum,
  tokensPerRun: fmtNum,
};
const METRIC_LABELS: Record<string, string> = {
  completionRate: "完成率（成对差值均值）",
  durationCompletedMs: "完成任务耗时（中位）",
  costPerCompletedUsd: "每完成任务费用（中位）",
  invalidToolCalls: "无效工具调用（中位）",
  tokensPerRun: "每次运行 token（输入+输出，中位）",
};

function armTable(arms: readonly ArmSummary[], costAvailable: boolean): string[] {
  const rows = [
    "| 臂 | 运行数 | 完成 | 完成率 | 原始结果类别 | 错误宣称完成（run.json 覆盖） | 验收通过但 run.json 未完成 | 耗时 p50 | 耗时 p95 | time-to-failure p50 | 输入 token | 输出 token | 每完成任务费用 | 费用覆盖 | 无效工具调用 | Jev 请求 | 模型请求（含失败） |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const a of arms) {
    const fc = a.runJsonCoverage.present === 0 ? `不可用（0/${a.runs}）` : `${a.falseCompletions}（${a.runJsonCoverage.present}/${a.runs}）`;
    const pnc = a.runJsonCoverage.present === 0 ? "不可用" : String(a.passedNotCompleted);
    const cost = costAvailable ? fmtUsd(a.costPerCompleted) : "不可用";
    const cov = costAvailable ? `${a.costCoverage.known}/${a.costCoverage.runs}` : "—";
    rows.push(
      `| ${a.arm} | ${a.runs} | ${a.completed} | ${fmtPct(a.completionRate)} | ${Object.entries(a.outcomes).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} | ${fc} | ${pnc} | ${fmtMs(a.durationP50)} | ${fmtMs(a.durationP95)} | ${fmtMs(a.timeToFailureP50)} | ${fmtInt(a.inputTokens)} | ${fmtInt(a.outputTokens)} | ${cost} | ${cov} | ${fmtNum(a.invalidToolCallsMean)} | ${a.jevRequests ?? "—"} | ${a.modelAttempts ?? "—"} |`,
    );
  }
  return rows;
}

export function renderReport(report: Report): string {
  const m = report.meta;
  const costAvailable = m?.costAvailable !== false;
  const lines = ["# pi-jev 成对提效试验报告", ""];
  if (m) lines.push(`开始：${m.startedAt}；主模型：${m.model}；Jev：${m.jev}；种子：${m.seed}；重复：${m.repeat}；并发：${m.concurrency}；费用：${costAvailable ? "按模型单价" : "不可用"}`, "");
  lines.push(`任务 ${report.tasks} 个，运行 ${report.runs} 次；成对基线臂：${report.baseline}。完成 = bench 在副本中执行的验收命令退出码为 0 且未超时；run.json 状态另列。`, "");
  lines.push("## 各臂汇总", "", ...armTable(report.arms, costAvailable), "");
  lines.push("## 成对差值（按独立任务聚合；完成率用均值，其余用中位数；bootstrap 95% 区间）", "");
  for (const c of report.comparisons) {
    lines.push(`### ${c.arm} − ${c.baseline}${c.aa ? "（A/A 噪声基线）" : ""}`, "", "| 指标 | 差值 [95% 区间] | 成对任务数 | 排除任务数（一侧为空） |", "| --- | --- | --- | --- |");
    for (const p of c.metrics) lines.push(`| ${METRIC_LABELS[p.metric]} | ${fmtInterval(p.interval, FORMAT[p.metric]!)} | ${p.diffs.length} | ${p.excluded} |`);
    lines.push("", "按类别：", "", "| 类别 | 完成率差值（均值） | 耗时差值（中位） |", "| --- | --- | --- |");
    for (const g of c.byCategory) lines.push(`| ${g.label} | ${fmtInterval(g.completion.interval, fmtPct)} | ${fmtInterval(g.duration.interval, fmtMs)} |`);
    lines.push("");
  }
  lines.push("## 按类别的各臂汇总", "");
  for (const g of report.byCategory) lines.push(`### ${g.label}`, "", ...armTable(g.arms, costAvailable), "");
  lines.push("## 限制", "", ...report.limitations.map((l) => `- ${l}`), "");
  return lines.join("\n");
}

const BENCH_ERROR = /^(\S+) rep (\d+) arm (\S+): (.*)$/;

/**
 * "bench 内部失败" section from `<out>/bench-errors.txt` lines. These runs have no outcome, so they
 * stay out of every metric; they are listed here, and any task/arm pair left with fewer recorded
 * repeats than planned gets a visible warning.
 */
export function renderBenchErrors(errors: readonly string[], records: readonly ResultRecord[], meta: BenchMeta | null): string[] {
  const lines = errors.map((l) => l.trim()).filter((l) => l.length > 0);
  const partial: string[] = [];
  if (meta)
    for (const t of meta.tasks)
      for (const a of meta.arms) {
        const n = records.filter((r) => r.taskId === t.id && r.arm === a.id).length;
        if (n < meta.repeat) partial.push(`- ⚠ 任务 ${t.id} / 臂 ${a.id}：只记录了 ${n}/${meta.repeat} 次重复，任务内平均覆盖的重复次数少于计划。`);
      }
  if (lines.length === 0 && partial.length === 0) return [];
  const out = ["## bench 内部失败", "", "以下运行在 bench 内部失败，没有结果类别，不进入任何指标；列出以免被静默丢弃。", ""];
  const groups = new Map<string, string[]>();
  const other: string[] = [];
  for (const l of lines) {
    const m = BENCH_ERROR.exec(l);
    if (!m) other.push(l);
    else {
      const key = `任务 ${m[1]} / 臂 ${m[3]}`;
      groups.set(key, [...(groups.get(key) ?? []), `rep ${m[2]}：${m[4]}`]);
    }
  }
  for (const [key, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) out.push(`### ${key}`, "", ...items.map((i) => `- ${i}`), "");
  if (other.length > 0) out.push("### 其他", "", ...other.map((i) => `- ${i}`), "");
  if (partial.length > 0) out.push("### 重复不完整", "", ...partial, "");
  return out;
}
