/** Shared shapes for bench tasks, arms, and per-run result records. */

export const CATEGORIES = ["read_explain", "small_fix", "feature", "multi_file", "long_context"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  read_explain: "定向读解释",
  small_fix: "小修复",
  feature: "新增功能",
  multi_file: "多文件",
  long_context: "长上下文",
};

/** Fixed repository start: a directory under bench/fixtures, or a git repo at a fixed commit. */
export type RepoSource = { fixture: string } | { git: string; commit: string };

export interface BenchTask {
  id: string;
  category: Category;
  repo: RepoSource;
  prompt: string;
  /** argv run by the bench in the workspace copy after the run ends; exit 0 = accepted. */
  acceptance: string[];
  /** Budget for the whole `pi-jev run`, in seconds. Acceptance has its own fixed timeout. */
  timeoutSec: number;
  /** Set by the loader: directory of the task file; `{taskDir}` in acceptance argv expands to it. */
  taskDir?: string;
}

export interface BenchArm {
  id: string;
  label: string;
  /** Written as `<HOME>/.pi/agent/pi-jev-harness/config.json` for this arm. */
  config: Record<string, unknown>;
  /** Extra environment for this arm's runs. */
  env?: Record<string, string>;
  /** The arm is the paired baseline (exactly one arm). */
  baseline?: boolean;
  /** This arm duplicates another arm (A/A noise baseline). */
  aaOf?: string;
  /** Present when the product cannot express this arm today; run.ts refuses it. */
  unsupported?: string;
  note?: string;
}

/**
 * Outcome keeps the raw category. `timeout`/`session_error`/`artifacts_missing`/`spawn_error` come
 * from the CLI or the bench; the rest is `run.json.status`. Nothing is dropped from denominators.
 */
export type Outcome =
  | "completed"
  | "incomplete"
  | "blocked"
  | "cancelled"
  | "failed"
  | "verification_unavailable"
  | "artifacts_missing"
  | "native_off"
  | "timeout"
  | "session_error"
  | "spawn_error";

export interface UsageFigure {
  value: number | null;
  known: number;
  sources: number;
}

export interface ResultRecord {
  taskId: string;
  category: string;
  arm: string;
  rep: number;
  /** Position of this arm within its pair group (task, rep). */
  order: number;
  startedAt: string;
  /** `run.json.status` (overridden to `cancelled` when the CLI reports cancellation), or null when there is no readable run.json. */
  runStatus: string | null;
  outcome: Outcome;
  cliExit: number | null;
  timedOut: boolean;
  sessionError: string | null;
  acceptance: { exit: number | null; timedOut: boolean; durationMs: number };
  /** Acceptance command exited 0; the bench's completion criterion. */
  passed: boolean;
  /** From task submission (spawn of `pi-jev run`) to the end of the acceptance command. */
  durationMs: number;
  /** From the Pi session log (all arms); null when no log exists. Figures may be null (unknown), never 0 for unknown. */
  usage: { costUsd: UsageFigure; input: UsageFigure; output: UsageFigure } | null;
  /** run.json usage vs the session log, when run.json exists (mode off writes none). */
  usageCrossCheck?: { runJsonInput: number | null; runJsonOutput: number | null; match: boolean | null } | null;
  /** Tool results with `isError` in the Pi session log; null when no log exists. */
  invalidToolCalls: number | null;
  /** Physical requests seen by the bench's fake Jev during this run; null with real Jev. */
  jevRequests: number | null;
  /** Assistant messages in the Pi session log, errored attempts included; null when no log was found. */
  modelAttempts?: number | null;
  modelErrors?: number | null;
  /** Session-log lines that were not valid JSON (skipped). */
  malformedLogLines?: number | null;
  runDir: string;
}

export interface BenchMeta {
  startedAt: string;
  seed: number;
  repeat: number;
  concurrency: number;
  model: string;
  jev: "fake" | "real";
  piRetry?: boolean;
  /** The model block has pricing; false means every cost figure is unavailable. */
  costAvailable?: boolean;
  arms: BenchArm[];
  tasks: { id: string; category: string }[];
}
