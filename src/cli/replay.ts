/**
 * `pi-jev replay`: offline check of each recorded receipt with `replayReceipt`. Executes nothing:
 * no tool, command, provider, or Jev call. The trusted current state never comes from the
 * receipt under check (technical §5); each bound field has one independent source:
 *
 * | Field | Source |
 * | --- | --- |
 * | `runId` | `run.json` of the run directory |
 * | `snapshot` | recomputed from the current workspace when its version is `WORKSPACE_SNAPSHOT_VERSION` |
 * | `outputs.<toolCallId>` | recomputed from the retained artifact when the output was one text block |
 * | `sessionId`, `branchId`, `generation`, `actionId`, `request`, `response`, `authorizationRef`, `execution`, `verification` | only the `--trusted` file |
 *
 * A field with no source is left out, so `replayReceipt` reports it as cannot_verify.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { canonicalJson } from "../../vendor/jev-harness/src/audit/receipt.ts";
import { outputDigest } from "../harness/evidence.ts";
import { RUN_FILES, replayReceipt, type ReplayOutcome, type RunJson, type TrustedCurrent } from "../harness/index.ts";
import { CliError, readOptional, resolveRunTarget, type CliDeps } from "./context.ts";

/**
 * Snapshot of the run's changed files in the current workspace: sha256 over canonical JSON of
 * `{ <path from run.json changes>: <sha256 of the file bytes> | null }` (null = absent).
 */
export const WORKSPACE_SNAPSHOT_VERSION = "pi-jev-workspace-files-v1";

/** Host-exported trusted state; fields a workspace, run.json, or artifact provides are ignored here. */
export interface TrustedFile {
  sessionId?: string;
  branchId?: string;
  generation?: number;
  /** Per action: presence confirms the actionId; values override the run-level ones above. */
  actions?: Record<string, Omit<TrustedCurrent, "runId" | "actionId" | "snapshot" | "outputs">>;
}

export interface ReceiptReplay {
  line: number;
  actionId: string | null;
  outcome: ReplayOutcome;
}

export interface ReplayReport {
  dir: string;
  receipts: string;
  runJson: boolean;
  trustedFile: string | null;
  /** Why the workspace snapshot could not be recomputed; null when it was. */
  snapshotUnavailable: string | null;
  results: ReceiptReplay[];
  counts: Record<ReplayOutcome["status"], number>;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Recompute the workspace snapshot, or explain why it cannot be. Reads files only. */
export async function workspaceSnapshot(workspace: string, paths: readonly string[]): Promise<{ digest: string } | { reason: string }> {
  const files: Record<string, string | null> = {};
  for (const path of paths) {
    const rel = normalize(path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return { reason: `变更路径 ${path} 不在工作区内` };
    try {
      files[path] = sha256(await readFile(join(workspace, rel)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { reason: `无法读取 ${path}：${code ?? String(error)}` };
      files[path] = null;
    }
  }
  return { digest: sha256(canonicalJson(files)) };
}

async function readTrusted(path: string): Promise<TrustedFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`无法读取可信状态文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError(`可信状态文件 ${path} 必须是 JSON 对象。`);
  return parsed as TrustedFile;
}

const TRUSTED_ACTION_KEYS = ["sessionId", "branchId", "generation", "request", "response", "authorizationRef", "execution", "verification"] as const;

/** Only the fields the trusted file is the source for; runId, snapshot, and outputs come from elsewhere. */
function pickTrusted(entry: object | undefined): Partial<TrustedCurrent> {
  if (entry === undefined || entry === null || typeof entry !== "object") return {};
  return Object.fromEntries(TRUSTED_ACTION_KEYS.filter((key) => Object.hasOwn(entry, key)).map((key) => [key, (entry as Record<string, unknown>)[key]]));
}

type Artifacts = (ref: string) => Promise<string | null>;

/** Output digests recomputable from retained artifacts; an output of several blocks cannot be rebuilt from its text. */
async function artifactOutputs(receipt: unknown, readArtifact: Artifacts): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  const evidence = (receipt as { execution?: { evidence?: unknown } } | null)?.execution?.evidence;
  if (!Array.isArray(evidence)) return outputs;
  for (const e of evidence) {
    const blocks = e?.output?.blocks;
    if (typeof e?.toolCallId !== "string" || typeof e?.artifactRef !== "string" || !Array.isArray(blocks)) continue;
    if (blocks.length !== 1 || blocks[0]?.type !== "text") continue;
    const text = await readArtifact(e.artifactRef);
    if (text === null) continue;
    const mimeType = blocks[0].mimeType;
    outputs[e.toolCallId] = outputDigest([{ type: "text", text, ...(typeof mimeType === "string" ? { mimeType } : {}) }]);
  }
  return outputs;
}

/** Replay every line of the receipts file. `deps.execFile` is never used. */
export async function replay(arg: string, deps: CliDeps, trustedPath?: string): Promise<ReplayReport> {
  const target = await resolveRunTarget(arg, deps);
  const text = await readOptional(target.receipts);
  if (text === null) throw new CliError(`找不到收据文件：${target.receipts}`);
  const runText = await readOptional(join(target.dir, RUN_FILES.run));
  let run: RunJson | null = null;
  if (runText !== null) {
    try {
      run = JSON.parse(runText) as RunJson;
    } catch {
      run = null;
    }
  }
  const trusted = trustedPath ? await readTrusted(trustedPath) : {};

  let snapshot: { digest: string } | { reason: string };
  if (run === null) snapshot = { reason: runText === null ? "产物不完整：没有 run.json，无法定位工作区" : "run.json 不是有效 JSON" };
  else if (typeof run.workspace !== "string" || !Array.isArray(run.changes)) snapshot = { reason: "run.json 缺少 workspace 或 changes" };
  else snapshot = await workspaceSnapshot(run.workspace, run.changes.map((c) => c.path));

  const readArtifact: Artifacts = (ref) => (/^artifacts\/[a-f0-9]{64}\.txt$/.test(ref) ? readOptional(join(target.dir, ref)) : Promise.resolve(null));
  const results: ReceiptReplay[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let receipt: Record<string, unknown> | null = null;
    try {
      receipt = (JSON.parse(line) as { receipt?: Record<string, unknown> }).receipt ?? null;
    } catch {
      receipt = null;
    }
    const actionId = typeof receipt?.actionId === "string" ? receipt.actionId : null;
    const perAction = actionId !== null && trusted.actions && Object.hasOwn(trusted.actions, actionId) ? trusted.actions[actionId]! : undefined;
    const current: TrustedCurrent = {
      ...(trusted.sessionId !== undefined ? { sessionId: trusted.sessionId } : {}),
      ...(trusted.branchId !== undefined ? { branchId: trusted.branchId } : {}),
      ...(trusted.generation !== undefined ? { generation: trusted.generation } : {}),
      ...pickTrusted(perAction),
      ...(perAction !== undefined ? { actionId: actionId! } : {}),
      ...(run !== null && typeof run.runId === "string" ? { runId: run.runId } : {}),
      ...("digest" in snapshot && (receipt?.snapshot as { version?: unknown } | undefined)?.version === WORKSPACE_SNAPSHOT_VERSION
        ? { snapshot: { digest: snapshot.digest, version: WORKSPACE_SNAPSHOT_VERSION } }
        : {}),
      outputs: await artifactOutputs(receipt, readArtifact),
    };
    results.push({ line: i + 1, actionId, outcome: replayReceipt(line, current) });
  }
  const counts = { match: 0, mismatch: 0, cannot_verify: 0 };
  for (const r of results) counts[r.outcome.status]++;
  return {
    dir: target.dir,
    receipts: target.receipts,
    runJson: run !== null,
    trustedFile: trustedPath ?? null,
    snapshotUnavailable: "reason" in snapshot ? snapshot.reason : null,
    results,
    counts,
  };
}

export function renderReplay(r: ReplayReport): string {
  const lines = [
    `收据：${r.receipts}`,
    "离线核对，不执行任何动作。",
    ...(r.runJson ? [] : ["产物不完整：没有可读的 run.json，runId 与工作区快照无法核对。"]),
    ...(r.snapshotUnavailable && r.runJson ? [`工作区快照无法重算：${r.snapshotUnavailable}`] : []),
    r.trustedFile ? `可信状态文件：${r.trustedFile}` : "未提供 --trusted：sessionId、branchId、generation、actionId 等绑定没有可信来源，将报告为 cannot_verify。",
    "",
  ];
  if (r.results.length === 0) lines.push("没有收据。");
  const notes = new Set<string>();
  for (const { line, actionId, outcome } of r.results) {
    lines.push(`#${line} ${actionId ?? "（无法读取 actionId）"}：${outcome.status}`);
    if (outcome.status === "mismatch") for (const reason of outcome.reasons) lines.push(`  - 不一致：${reason}`);
    if (outcome.status === "cannot_verify") lines.push(`  - 缺少可信来源：${outcome.missing.join("、")}`);
    for (const note of outcome.notes ?? []) notes.add(note);
  }
  lines.push("", `合计：match ${r.counts.match}，mismatch ${r.counts.mismatch}，cannot_verify ${r.counts.cannot_verify}`);
  if (notes.size > 0) lines.push("", "说明", ...[...notes].map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}
