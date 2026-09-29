/**
 * Harness wiring for the Pi adapter (technical §7.1–§7.3, §9.3, §11.1; product §8–§9). Active
 * while the adapter mode is shadow or on; off builds no envelope, sends no review and writes nothing.
 *
 * - `tool_call`: build a host-owned `ActionEnvelope` and validate it locally. read/search take the
 *   fast path; edit/create/overwrite are reviewed only after local validation passed and only when
 *   `outbound.taskIntent` allows data to leave the machine. The preimage text an edit review needs
 *   is read here, before the tool runs, and checked against the envelope digest.
 *   - not enforced (session mode shadow, or kind not in `harness.enforce`): the review runs in the
 *     background; the handler returns undefined, so Pi executes exactly what it would have executed
 *     without the harness. In shadow a kind listed in `harness.enforce` records the block it would
 *     have caused in `on` (receipt note + status count) and never blocks (product §4.1, §10).
 *   - enforced (session mode on AND kind in `harness.enforce`): a validation failure blocks without
 *     any Jev request; otherwise the review is awaited, anything but permit blocks, and a permitted
 *     action is re-checked for freshness (`checkFreshness`) and blocked as stale when the target
 *     changed during the review.
 * - `tool_result`: evidence is bound to its action through the `toolCallId` registered at `tool_call`.
 * - Changeset: envelope-tracked targets united with a workspace diff against the baseline taken at
 *   task start (`./workspace.ts`), so files written by bash count too. Paths already dirty at start
 *   are listed as pre-existing changes, never as this task's changes on their own.
 * - Run outcome: an aborted run (before_settle `aborted`, an aborted assistant message, Pi's run
 *   signal aborted at message_end/tool_result/before_settle, an assistant error that is an abort
 *   error, session shutdown) is cancelled with reason `用户取消：…` (an abort landing in a
 *   tool surfaces as stopReason `error` "This operation was aborted" and Pi clears its run signal
 *   before before_settle); a run whose last model request ended in error is failed (reason
 *   `模型请求失败：<provider message, credentials scrubbed>` and a `model_request` receipt). Neither
 *   is ever completed. Pi 0.87.1 emits `agent_settled` from a `finally` after `before_agent_start`,
 *   so a run whose every request failed is still written, exactly once (`finish` is idempotent).
 * - Completion and bounded continuation: one lifecycle controller per task (`./lifecycle.ts`);
 *   `agent_before_settle` assesses and may continue, `agent_settled` only closes the record.
 * - `agent_settled`: waits for background reviews, then writes `summary.md`, `run.json` and
 *   `receipts.jsonl` under `<harness.runsDir>/<run-id>/`. The first task's run id is
 *   `harness.runId` when injected (`PI_JEV_RUN_ID`), later tasks get `<runId>-<n>`; otherwise ids
 *   are generated. An existing run directory is never overwritten (the write fails and is reported).
 *
 * Pi's write has no overwrite field, and this adapter never sets the host overwrite marker: every
 * `write` is a `create`, so a write onto an existing file fails validation (recorded in shadow,
 * blocked when `create` is enforced).
 */
import { createJevAccess, type JevAccess } from "../shared/jev-access.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionContext,
  MessageEndEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../../../vendor/jev-harness/src/audit/receipt.ts";
import { TYPESAFE_PROFILE, type JevAttempt, type JevClient } from "../../jev/index.ts";
import {
  ACTION_KINDS,
  ACTION_REVIEW_POLICY_VERSION,
  EvidenceLedger,
  buildEnvelope,
  checkFreshness,
  createRuntimeReceipt,
  isFastPathRead,
  recordToolResult,
  reviewAction,
  sha256Hex,
  summarizeChangeset,
  summarizeUsage,
  toReviewableAction,
  validateEnvelope,
  writeRunArtifacts,
  type ActionEnvelope,
  type ActionReviewMode,
  type ActionReviewStatus,
  type AllowedReviewContext,
  type AuthorizationScope,
  type CompletionResult,
  type DigestRef,
  type EnvelopeValidation,
  type Evidence,
  type FileChange,
  type NoulAsk,
  type ReceiptUsage,
  type ReceiptVerification,
  type ReviewableAction,
  type RunCompletion,
  type RunRecord,
  type RunVerification,
  type SealedRuntimeReceipt,
  type TaskStatus,
  type VerificationStatus,
} from "../../harness/index.ts";
import type { RunRouting } from "../../harness/run-artifacts.ts";
import type { TelemetryOutcome } from "../../telemetry/index.ts";
import { CREDENTIAL_PATTERNS, containsCredential, type AdapterConfig, type AdapterMode } from "./config.ts";
import {
  ASSESSMENT_TOOLS,
  CONTINUATION_POLICY_VERSION,
  createTaskLifecycle,
  unavailableCompletion,
  type ContinuationRecord,
  type TaskLifecycle,
} from "./lifecycle.ts";
import { truncateIntent } from "./tools.ts";
import { snapshotWorkspace, type WorkspaceBaseline } from "./workspace.ts";

/** Grant ceiling for any single file read, replaced or written through the harness. */
export const HARNESS_MAX_FILE_BYTES = 1_048_576;
/** Version tag of the envelope digest recorded as the receipt snapshot. */
export const ENVELOPE_SNAPSHOT_VERSION = "pi-action-envelope-v1";
/** Longest provider error / abort detail kept in the run reasons (applied after scrubbing). */
export const MAX_OUTCOME_DETAIL_CHARS = 300;
/** Failure stage named in run reasons, the model-request receipt and `pi-jev run` output. */
export const MODEL_FAILURE_STAGE = "模型请求失败";
/** `actionId` of the receipt recording a model request that ended in error. */
export const MODEL_REQUEST_ACTION = "model_request";
/** Version tag of the model-failure digest recorded as the receipt snapshot. */
export const MODEL_FAILURE_SNAPSHOT_VERSION = "pi-model-request-v1";
/** Replaces each credential-shaped span in text written to run products or printed. */
export const CREDENTIAL_REDACTED = "[已移除：疑似凭据]";

/**
 * Provider/host text with every credential shape (and the Jev key) replaced: matches are taken on
 * the original text and overlapping ones merged into one marker. When a shape still matches
 * afterwards, the whole text is withheld. Scrub before truncating, so a cut never leaves an
 * unrecognisable key fragment.
 */
export function scrubCredentials(text: string, jevKeys: string | readonly string[] | undefined): string {
  const spans: [number, number][] = [];
  for (const jevKey of typeof jevKeys === "string" ? [jevKeys] : (jevKeys ?? []))
    if (jevKey) for (let i = text.indexOf(jevKey); i !== -1; i = text.indexOf(jevKey, i + 1)) spans.push([i, i + jevKey.length]);
  for (const pattern of CREDENTIAL_PATTERNS)
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)))
      spans.push([match.index, match.index + match[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (start >= at) {
      out += text.slice(at, start) + CREDENTIAL_REDACTED;
      at = end;
    } else at = Math.max(at, end);
  }
  out += text.slice(at);
  return containsCredential(out, jevKeys) ? CREDENTIAL_REDACTED : out;
}
/** Longest command text kept as a verification name. */
const MAX_CHECK_NAME_CHARS = 200;

/** Verification commands; host-neutral (`../core/checks.ts`). */
export { CHECK_COMMAND } from "../core/checks.ts";
import { CHECK_COMMAND } from "../core/checks.ts";

export interface HarnessDeps {
  /** Jev endpoint(s) and credential-scan secrets; default: from `config` (single-url unless `jev.providers`). */
  jev?: JevAccess;
  config: AdapterConfig;
  /** Adapter mode at creation; later changes arrive through `setMode`. */
  mode: AdapterMode;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  /** Called before every physical Jev request this harness dispatches. */
  onJevRequest: () => void;
  onJevAttempt: (attempt: JevAttempt) => void;
  /** One completion assessment or continuation decision (telemetry kinds `completion` / `continuation`). */
  onDecision: (kind: "completion" | "continuation", decisionId: string, outcome: TelemetryOutcome, durationMs: number) => void;
}

/** What an action review sends: the reviewer's view plus the only context allowed out. */
interface PreparedReview {
  action: ReviewableAction;
  context: AllowedReviewContext;
}

interface ReviewOutcome {
  status: ActionReviewStatus;
  reason: string;
  /** Non-null when an enforced review stops the action. */
  blocked: string | null;
}

interface ActionRecord {
  envelope: ActionEnvelope;
  validation: EnvelopeValidation;
  /** Session mode was `on` and the kind is in `harness.enforce`: this record may block. */
  enforced: boolean;
  /** Shadow only: the kind is in `harness.enforce`, so the block `on` would cause is recorded. */
  observedEnforce: boolean;
  /** Shadow only: why `on` would have blocked this action; the tool ran. */
  wouldBlock: string | null;
  startedAt: number;
  /** Block reason returned to Pi; the tool never ran. */
  blocked: string | null;
  review: ReviewOutcome | null;
  request: DigestRef | null;
  response: DigestRef | null;
  /** Command text when this action is a check command. */
  check: string | null;
}

interface TrackedFile {
  path: string;
  /** sha256 before the first mutating call in this task; null when the file did not exist. */
  before: string | null;
}

interface TaskRun {
  runId: string;
  dir: string;
  task: string;
  workspace: string;
  sessionId: string;
  branchId: string;
  generation: number;
  grant: AuthorizationScope;
  actions: ActionRecord[];
  byCall: Map<string, ActionRecord>;
  ledger: EvidenceLedger;
  files: Map<string, TrackedFile>;
  usage: (ReceiptUsage | null)[];
  reviews: Set<Promise<void>>;
  controller: AbortController;
  lifecycle: TaskLifecycle;
  /** Workspace state at task start, or why it could not be taken. */
  baseline: Promise<WorkspaceBaseline | string>;
  /** Latest assistant text: the answer a question task is judged on. */
  answer: string | undefined;
  /** How the agent's last activity ended when not normally (Pi `stopReason` / before_settle outcome). */
  ended: { outcome: "aborted" | "error"; detail: string } | null;
  state: "running" | "writing" | "written" | "failed";
  /** Status written to run.json; null until the products were written. */
  status: TaskStatus | null;
  /** Set once `agent_settled` began closing this task; a later shutdown waits for it instead of cancelling. */
  settling: Promise<void> | null;
  /** Host-owned routing outcomes of this task, copied into run.json. */
  routing: RunRouting | undefined;
}

export interface PiHarness {
  /** A new task starts (`before_agent_start`). */
  startTask(prompt: string, ctx: ExtensionContext, routing?: RunRouting): void;
  /** Run id of the current task, else of the last one; undefined before the first task. */
  currentRunId(): string | undefined;
  /** Never throws. Returns undefined unless an enforced kind is blocked. */
  toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined>;
  /** `ctx` carries Pi's run signal; an aborted one marks the task cancelled. */
  toolResult(event: ToolResultEvent, ctx?: ExtensionContext): void;
  messageEnd(event: MessageEndEvent, ctx?: ExtensionContext): void;
  /** `agent_before_settle`: completion checkpoint; returns the continuation request only when allowed. */
  beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined>;
  /** A user message arrived while the agent was streaming: in-flight decisions are void. */
  userMessage(): void;
  /** Adapter mode changed between shadow and on (off goes through `discard`). */
  setMode(mode: AdapterMode): void;
  /** `jev_acceptance_gate` / `foreman_assess`: the checkpoint assessment shared with the automatic path. */
  assessTool(tool: string, answer: string | undefined): Promise<CompletionResult>;
  /** `agent_settled`: wait for background reviews, then write the run products. */
  settle(): Promise<void>;
  /** Mode switched off: cancel reviews and drop the unfinished task without writing products. */
  discard(): void;
  /** Resolves when every earlier task closed by a new task's start has written its products. */
  settled(): Promise<void>;
  /** Session ends (`reason` from `session_shutdown`): cancel reviews; a task that never settled is written as cancelled. */
  shutdown(reason?: string): Promise<void>;
  statusLines(mode: AdapterMode): string[];
}

const COMPLETION_LABELS: Record<CompletionResult["completionStatus"], string> = {
  passed: "通过",
  incomplete: "未通过",
  blocked: "阻塞",
  unavailable: "不可用",
};

/** Reason prefix of a task the user cancelled (abort, Ctrl-C, `--max-time`). */
export const USER_CANCEL = "用户取消";

/** Pi's current run signal (`ctx.signal`, set while the agent streams) is aborted. */
function runSignalAborted(ctx: ExtensionContext | undefined): boolean {
  return ctx?.signal?.aborted === true;
}

/**
 * Last resort when no signal was observable: the error text of an aborted fetch/stream
 * (`AbortError`: "This operation was aborted", provider "Request was aborted" / "Request aborted").
 */
function isAbortText(text: unknown): boolean {
  return typeof text === "string" && /^(AbortError\b|This operation was aborted|Request (was )?aborted)/i.test(text.trim());
}

/** Kinds that are reviewed and whose targets are tracked for the changeset. */
const MUTATING: Record<string, true> = { edit: true, create: true, overwrite: true };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

async function fileDigest(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await nodeFs.readFile(path)).digest("hex");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Root-relative path with forward slashes, or the absolute path when outside every root. */
function displayPath(roots: readonly string[], target: string): string {
  for (const root of roots) {
    const rel = relative(root, target);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join("/");
  }
  return target;
}

/** Text parts of an assistant message; undefined for other roles or no text. */
function assistantText(message: unknown): string | undefined {
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return undefined;
  const text = m.content
    .flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || undefined;
}

function verificationOf(evidence: Evidence): VerificationStatus {
  if (evidence.outcome === "ok") return "passed";
  return evidence.outcome === "error" ? "failed" : "unavailable";
}

export function createPiHarness(deps: HarnessDeps): PiHarness {
  const { config } = deps;
  const enforce: readonly string[] = config.harness.enforce;
  // the `acceptance` chain for acceptance, continuation and enforce reviews.
  const access = deps.jev ?? createJevAccess({ config, env: deps.env });
  const counts = { envelopes: 0, invalid: 0, blocked: 0, wouldBlock: 0, reviewsSent: 0 };
  let mode: AdapterMode = deps.mode;
  let generation = 0;
  let tasks = 0;
  let current: TaskRun | undefined;
  let last: TaskRun | undefined;
  /** Closes of earlier tasks a new task's start began; `settled` and `shutdown` wait for them. */
  const closing = new Set<Promise<void>>();
  let lastError: string | undefined;
  const clients = new Map<"acceptance" | "assess", JevClient | undefined>();
  /** `foreman_assess` runs on the `assess` chain; everything else on `acceptance`. */
  const capabilityScope = new AsyncLocalStorage<"assess">();

  function jev(): JevClient | undefined {
    const capability = capabilityScope.getStore() ?? "acceptance";
    if (!access.available(capability)) return undefined;
    if (!clients.has(capability)) clients.set(capability, access.client(capability, {
      fetch: (input, init) => {
        deps.onJevRequest();
        return deps.fetch(input, init);
      },
      now: deps.now,
      newId: () => `att_${deps.newId()}`,
      waitMs: config.budget.waitMs,
      ...(deps.onJevAttempt ? { onAttempt: deps.onJevAttempt } : {}),
    }));
    return clients.get(capability);
  }

  function newRun(prompt: string, ctx: ExtensionContext): TaskRun {
    tasks++;
    const injected = config.harness.runId;
    const runId = injected === undefined ? `run_${deps.newId()}` : tasks === 1 ? injected : `${injected}-${tasks}`;
    const session = ctx.sessionManager;
    const controller = new AbortController();
    const sessionId = session.getSessionId() || runId;
    const run: TaskRun = {
      runId,
      dir: join(config.harness.runsDir, runId),
      task: truncateIntent(prompt),
      workspace: ctx.cwd,
      sessionId,
      branchId: session.getLeafId() ?? "root",
      generation: generation++,
      grant: { id: `grant_${runId}`, kinds: ACTION_KINDS.filter((kind) => kind !== "unsupported"), maxFileBytes: HARNESS_MAX_FILE_BYTES },
      actions: [],
      byCall: new Map(),
      ledger: new EvidenceLedger(),
      files: new Map(),
      usage: [],
      reviews: new Set(),
      controller,
      lifecycle: createTaskLifecycle({
        continuation: config.harness.continuation,
        mode,
        sessionId,
        signal: controller.signal,
        evidence: () => hostEvidence(run),
        outboundBlock,
        jev,
        now: deps.now,
        newId: deps.newId,
        onDecision: deps.onDecision,
      }),
      baseline: snapshotWorkspace(ctx.cwd, [config.harness.runsDir]).catch((error: unknown) => `工作区快照失败：${errorText(error)}`),
      answer: undefined,
      ended: null,
      state: "running",
      status: null,
      settling: null,
      routing: undefined,
    };
    return run;
  }

  /** Why these texts may not leave the machine, or null when they may. */
  function outboundBlock(texts: readonly string[]): string | null {
    if (!config.outbound.taskIntent) return "outbound.taskIntent=false";
    if (!access.available("acceptance")) return "Jev key missing";
    if (texts.some((text) => containsCredential(text, access.secrets))) return "credential detected";
    return null;
  }

  /**
   * Host changeset: envelope-tracked files (digest before the first mutation vs now) united with the
   * workspace diff since task start. A path both sides know keeps the envelope's before digest.
   */
  async function changeset(run: TaskRun): Promise<{ changes: FileChange[]; preexisting: string[]; note: string | null }> {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    const tracked = new Set<string>();
    for (const [target, file] of run.files) {
      tracked.add(file.path);
      if (file.before !== null) before[file.path] = file.before;
      const now = await fileDigest(target);
      if (now !== null) after[file.path] = now;
    }
    const baseline = await run.baseline;
    let preexisting: string[] = [];
    let note: string | null;
    if (typeof baseline === "string") note = baseline;
    else {
      try {
        const diff = await baseline.diff();
        for (const change of diff.changes) {
          if (tracked.has(change.path)) continue;
          if (change.before !== null) before[change.path] = change.before;
          if (change.after !== null) after[change.path] = change.after;
        }
        preexisting = diff.preexisting.sort();
        note = diff.note;
      } catch (error) {
        note = `工作区改动检测失败：${errorText(error)}`;
      }
    }
    return { changes: summarizeChangeset(before, after), preexisting, note };
  }

  async function hostEvidence(run: TaskRun) {
    const checks = run.actions.flatMap((record) => {
      if (record.check === null || record.blocked !== null) return [];
      const last = run.ledger.forAction(record.envelope.actionId).at(-1);
      return last ? [last] : [];
    });
    const { changes } = await changeset(run);
    return {
      goal: run.task,
      // Any workspace change (bash included) makes this an implementation task.
      mutated: changes.length > 0 || run.actions.some((record) => MUTATING[record.envelope.kind] === true && record.blocked === null),
      changes,
      checks,
      ...(run.answer === undefined ? {} : { answer: run.answer }),
    };
  }

  /**
   * Everything a review sends, prepared before the tool runs. A string is why nothing is sent;
   * nothing leaves the machine unless task intent is allowed out and no credential shape appears.
   */
  async function prepareReview(run: TaskRun, envelope: ActionEnvelope): Promise<PreparedReview | string> {
    if (!config.outbound.taskIntent) return "outbound.taskIntent=false; review not sent";
    if (!access.available("acceptance")) return "Jev key missing; review not sent";
    if (!run.task.trim()) return "no task intent recorded for this task; review not sent";
    let preimage: string | undefined;
    try {
      if (envelope.kind !== "create" && envelope.preimage)
        preimage = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await nodeFs.readFile(envelope.preimage.path));
      // Checks the preimage text against the envelope digest (and content against its digest).
      const action = toReviewableAction(envelope, preimage);
      const change = action.kind === "edit" ? action.diff : action.content;
      if ([run.task, change, preimage ?? ""].some((text) => containsCredential(text, access.secrets))) return "credential detected; review withheld";
      return { action, context: { task: run.task, ...(preimage === undefined ? {} : { preimage }) } };
    } catch (error) {
      return `review input unavailable: ${errorText(error)}`;
    }
  }

  async function review(run: TaskRun, record: ActionRecord, mode: ActionReviewMode, prepared: PreparedReview | string): Promise<ReviewOutcome> {
    const unavailable = (reason: string): ReviewOutcome => ({
      status: "unavailable",
      reason,
      blocked: mode === "enforced" ? `Enforced review unavailable: ${reason}. The action is not executed.` : null,
    });
    if (typeof prepared === "string") return unavailable(prepared);
    const noul = jev();
    if (!noul) return unavailable("Jev key missing; review not sent");
    const ask: NoulAsk = async (questions, options) => {
      record.request = { digest: sha256Hex(canonicalJson({ questions, state: options.state })), version: ACTION_REVIEW_POLICY_VERSION };
      const result = await noul.noul(questions, options);
      if (result.ok) record.response = { digest: sha256Hex(canonicalJson(result.evidence)), version: TYPESAFE_PROFILE.model };
      return result;
    };
    counts.reviewsSent++;
    try {
      const result = await reviewAction({ action: prepared.action, allowedContext: prepared.context, ask, mode, signal: run.controller.signal });
      return { status: result.status, reason: result.reason, blocked: result.blocked };
    } catch (error) {
      return unavailable(`review failed: ${errorText(error)}`);
    }
  }

  function wouldBlock(record: ActionRecord, reason: string): void {
    if (record.wouldBlock !== null) return;
    record.wouldBlock = reason;
    counts.wouldBlock++;
  }

  function block(record: ActionRecord, reason: string): ToolCallEventResult {
    record.blocked = reason;
    counts.blocked++;
    return { block: true, reason: `pi-jev-harness: ${reason}` };
  }

  /** Build, validate, register the call and snapshot the target's digest; awaited before Pi runs the tool. */
  async function observe(run: TaskRun, event: ToolCallEvent, ctx: ExtensionContext): Promise<ActionRecord> {
    const policy = { fs: nodeFs, allowedRoots: [ctx.cwd], grants: [run.grant] };
    const envelope = await buildEnvelope(
      { toolName: event.toolName, args: event.input, toolCallId: event.toolCallId },
      { ...policy, cwd: ctx.cwd, newId: deps.newId },
    );
    const validation = await validateEnvelope(envelope, policy);
    // Only session mode `on` blocks (H1); shadow records what `on` would have blocked.
    const listed = enforce.includes(envelope.kind);
    const record: ActionRecord = {
      envelope,
      validation,
      enforced: mode === "on" && listed,
      observedEnforce: mode !== "on" && listed,
      wouldBlock: null,
      startedAt: deps.now(),
      blocked: null,
      review: null,
      request: null,
      response: null,
      check: envelope.change?.format === "command" && "script" in envelope.change && CHECK_COMMAND.test(envelope.change.script)
        ? envelope.change.script
        : null,
    };
    counts.envelopes++;
    if (!validation.ok) counts.invalid++;
    run.ledger.expect(envelope.toolCallId, envelope.actionId);
    run.byCall.set(envelope.toolCallId, record);
    run.actions.push(record);
    const target = envelope.targets[0];
    if (MUTATING[envelope.kind] && target !== undefined && !run.files.has(target))
      run.files.set(target, { path: displayPath(envelope.scope.roots, target), before: await fileDigest(target) });
    return record;
  }

  async function toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
    if (ASSESSMENT_TOOLS.has(event.toolName)) return undefined;
    const run = current ?? (current = newRun("", ctx));
    // The baseline must be taken before the first tool of the task runs.
    await run.baseline;
    let record: ActionRecord;
    try {
      record = await observe(run, event, ctx);
    } catch (error) {
      lastError = `envelope: ${errorText(error)}`;
      // Fail closed only where blocking is enabled: a write whose kind could not be established.
      return mode === "on" && enforce.length > 0 && event.toolName === "write"
        ? { block: true, reason: `pi-jev-harness: could not check the action (${errorText(error)})` }
        : undefined;
    }
    const { envelope, validation } = record;
    if (!record.enforced) {
      // Shadow: never block, never await the network. Local validation gates the outbound review.
      if (record.observedEnforce && !validation.ok) wouldBlock(record, `validation failed: ${validation.reason}`);
      if (validation.ok && MUTATING[envelope.kind] && !isFastPathRead(envelope)) {
        try {
          const prepared = await prepareReview(run, envelope);
          // An observed enforced kind is judged as `on` would judge it; the outcome is only recorded.
          const pending = review(run, record, record.observedEnforce ? "enforced" : "shadow", prepared).then((outcome) => {
            record.review = outcome;
            if (record.observedEnforce && outcome.blocked !== null) wouldBlock(record, outcome.blocked);
          });
          run.reviews.add(pending);
          void pending.finally(() => run.reviews.delete(pending));
        } catch (error) {
          record.review = { status: "unavailable", reason: errorText(error), blocked: null };
        }
      }
      return undefined;
    }
    try {
      if (!validation.ok) return block(record, `validation failed: ${validation.reason}`);
      const outcome = await review(run, record, "enforced", await prepareReview(run, envelope));
      record.review = outcome;
      if (outcome.blocked !== null) return block(record, outcome.blocked);
      const freshness = await checkFreshness(envelope, nodeFs);
      if (freshness.status === "stale") return block(record, `stale: ${freshness.reason}`);
      return undefined;
    } catch (error) {
      return block(record, `enforced check failed: ${errorText(error)}`);
    }
  }

  function receiptFor(run: TaskRun, record: ActionRecord): SealedRuntimeReceipt {
    const { envelope } = record;
    const evidence = record.blocked === null ? run.ledger.forAction(envelope.actionId) : [];
    const notes: string[] = [];
    let status: "blocked" | "executed" | "failed";
    if (record.blocked !== null) {
      status = "blocked";
      notes.push(record.blocked);
    } else if (evidence.length === 0) {
      status = "failed";
      notes.push("no tool result was observed before the task ended");
    } else if (evidence.every((e) => e.outcome === "ok")) status = "executed";
    else {
      status = "failed";
      const bad = evidence.find((e) => e.outcome !== "ok")!;
      notes.push(`tool result ${bad.outcome}${bad.exitCode === null ? "" : ` (exit code ${bad.exitCode})`}`);
    }
    if (!record.validation.ok && record.blocked === null) notes.push(`validation failed (shadow; not blocked): ${record.validation.reason}`);
    if (record.wouldBlock !== null) notes.push(`would be blocked in on (shadow; not blocked): ${record.wouldBlock}`);
    if (record.review && record.review.status !== "permit" && record.blocked === null)
      notes.push(`${record.enforced ? "enforced" : "shadow"} review ${record.review.status}: ${record.review.reason}`);
    let verification: ReceiptVerification | undefined;
    const lastEvidence = evidence.at(-1);
    if (record.check !== null && lastEvidence)
      verification = { status: verificationOf(lastEvidence), evidenceRefs: [lastEvidence.toolCallId], note: record.check.slice(0, MAX_CHECK_NAME_CHARS) };
    return createRuntimeReceipt({
      runId: run.runId,
      sessionId: run.sessionId,
      branchId: run.branchId,
      generation: run.generation,
      actionId: envelope.actionId,
      snapshot: { digest: sha256Hex(canonicalJson(envelope)), version: ENVELOPE_SNAPSHOT_VERSION },
      request: record.request,
      response: record.response,
      authorizationRef: envelope.scope.grant?.id ?? null,
      execution: { status, reason: notes.length ? notes.join("; ") : null, evidence },
      ...(verification ? { verification } : {}),
      usage: null,
    });
  }

  /**
   * One continuation decision as a receipt: executed when the request went to Pi, not_requested when
   * only recorded. An executed receipt needs evidence; the observed fact is the boundary result this
   * adapter returned to Pi (`continue: true`), recorded as the `agent_before_settle` result.
   */
  function continuationReceipt(run: TaskRun, record: ContinuationRecord, index: number): SealedRuntimeReceipt {
    const actionId = `continuation_${index + 1}`;
    const evidence = record.applied
      ? [recordToolResult({
          actionId,
          toolCallId: actionId,
          toolName: "agent_before_settle",
          isError: false,
          content: [{ type: "text", text: "continuation request returned to Pi (continue: true)" }],
          startedAt: record.at,
          endedAt: record.at,
        }).evidence]
      : [];
    return createRuntimeReceipt({
      runId: run.runId,
      sessionId: run.sessionId,
      branchId: run.branchId,
      generation: run.generation,
      actionId,
      snapshot: {
        digest: sha256Hex(canonicalJson({ checkpoint: record.checkpoint, completion: record.completion, decision: record.decision })),
        version: CONTINUATION_POLICY_VERSION,
      },
      request: record.request,
      response: record.response,
      authorizationRef: null,
      execution: {
        status: record.applied ? "executed" : "not_requested",
        reason: [record.reason, ...(record.note === null ? [] : [`continuation assessment unavailable: ${record.note}`])].join("; "),
        evidence,
      },
      usage: null,
    });
  }

  /** The model request that ended the task in error; no tool evidence exists for it. */
  function modelFailureReceipt(run: TaskRun, detail: string): SealedRuntimeReceipt {
    return createRuntimeReceipt({
      runId: run.runId,
      sessionId: run.sessionId,
      branchId: run.branchId,
      generation: run.generation,
      actionId: MODEL_REQUEST_ACTION,
      snapshot: { digest: sha256Hex(canonicalJson({ stage: MODEL_REQUEST_ACTION, detail })), version: MODEL_FAILURE_SNAPSHOT_VERSION },
      request: null,
      response: null,
      authorizationRef: null,
      execution: { status: "failed", reason: `${MODEL_FAILURE_STAGE}：${detail}`, evidence: [] },
      usage: null,
    });
  }

  /** `完成验收：…；允许结束：…；自动续跑：…` for the run record and status. */
  function lifecycleLine(run: TaskRun): string {
    const snap = run.lifecycle.snapshot();
    const completion = snap.lastCompletion;
    const verdict = completion
      ? `完成验收：${COMPLETION_LABELS[completion.completionStatus]}（${completion.completionStatus}）；允许结束：${completion.stopAllowed ? "是" : "否"}`
      : "完成验收：未进行";
    return `${verdict}；自动续跑：已用 ${snap.continuations}/${snap.maxContinuations}，剩余 ${Math.max(0, snap.maxContinuations - snap.continuations)}`;
  }

  function completionRecord(run: TaskRun): RunCompletion {
    const snap = run.lifecycle.snapshot();
    const c = snap.lastCompletion;
    return {
      status: c ? c.completionStatus : "not_assessed",
      stopAllowed: c ? c.stopAllowed : null,
      assessment: c ? c.assessment : null,
      continuations: { used: snap.continuations, max: snap.maxContinuations },
    };
  }

  /**
   * Task status (product §8), first match wins: a cancelled run (shutdown, abort) is cancelled; a
   * run whose last model request failed is failed; then host evidence (a code change without a
   * check is never completed); then the completion assessment, completed only when it passed.
   */
  async function finish(run: TaskRun, ended: "settled" | "shutdown"): Promise<void> {
    if (run.state !== "running") return;
    run.state = "writing";
    try {
      const { changes, preexisting, note: workspaceNote } = await changeset(run);
      const receipts = run.actions.map((record) => receiptFor(run, record));
      const checks = new Map<string, RunVerification>();
      for (const sealed of receipts) {
        const { verification } = sealed.receipt;
        if (verification.note === null || verification.evidenceRefs.length === 0) continue;
        const prior = checks.get(verification.note);
        // One entry per command; its status is the latest run, its refs every run.
        checks.set(verification.note, {
          name: verification.note,
          status: verification.status,
          evidenceRefs: [...(prior?.evidenceRefs ?? []), ...verification.evidenceRefs],
        });
      }
      const verification = [...checks.values()];
      const blocked = run.actions.flatMap((record) => (record.blocked === null ? [] : [record.blocked]));
      let status: TaskStatus;
      const reasons: string[] = [];
      const remaining: string[] = [];
      let waiver: RunRecord["verificationWaiver"];
      const aborted = run.ended?.outcome === "aborted" || run.lifecycle.snapshot().phase === "cancelled";
      if (ended === "shutdown") {
        status = "cancelled";
        reasons.push("会话在任务结束前关闭");
      } else if (aborted) {
        status = "cancelled";
        reasons.push(`${USER_CANCEL}：任务被中止（${run.ended?.detail ?? "任务在完成验收前被取消"}）`);
      } else if (run.ended?.outcome === "error") {
        // Explicit (D2): a model request that ended in error never finished the task.
        status = "failed";
        reasons.push(`${MODEL_FAILURE_STAGE}：${run.ended.detail}`);
        receipts.push(modelFailureReceipt(run, run.ended.detail));
      } else if (blocked.length > 0) {
        status = "blocked";
        reasons.push(...blocked);
      } else if (verification.some((v) => v.status === "failed")) {
        status = "incomplete";
        remaining.push(...verification.filter((v) => v.status === "failed").map((v) => `检查未通过：${v.name}`));
      } else if (verification.some((v) => v.status !== "passed")) {
        status = "verification_unavailable";
        remaining.push(...verification.filter((v) => v.status !== "passed").map((v) => `检查没有得出结果：${v.name}`));
      } else if (changes.length > 0 && verification.length === 0) {
        status = "incomplete";
        remaining.push("缺少验证证据：有代码改动，但没有运行任何检查命令");
      } else {
        // Host evidence has no gap; the completion assessment decides (product §8: never completed without it).
        const completion = run.lifecycle.snapshot().lastCompletion;
        if (!completion) {
          status = "verification_unavailable";
          remaining.push("完成验收未进行：任务没有经过 agent_before_settle 检查点");
        } else if (completion.completionStatus === "passed") {
          status = "completed";
          if (verification.length === 0) waiver = { reason: "没有文件改动，也没有运行检查命令：按问答类任务处理，完成验收已通过" };
        } else if (completion.completionStatus === "incomplete") {
          status = "incomplete";
          remaining.push(...completion.gaps.map((gap) => gap.message));
          if (remaining.length === 0) remaining.push(completion.reason);
        } else if (completion.completionStatus === "blocked") {
          status = "blocked";
          reasons.push(...(completion.gaps.length ? completion.gaps.map((gap) => gap.message) : [completion.reason]));
        } else {
          status = "verification_unavailable";
          remaining.push(`完成验收不可用：${completion.reason}`);
        }
      }
      if (workspaceNote !== null) {
        reasons.push(`工作区改动检测不完整：${workspaceNote}`);
        // Without the full workspace diff the changeset may miss this task's changes.
        if (status === "completed") {
          status = "verification_unavailable";
          waiver = undefined;
          remaining.push("工作区改动检测不完整，无法确认本次改动都已验证");
        }
      }
      reasons.push(lifecycleLine(run));
      receipts.push(...run.lifecycle.records().map((record, index) => continuationReceipt(run, record, index)));
      const record: RunRecord = {
        runId: run.runId,
        task: run.task,
        status,
        workspace: run.workspace,
        changes,
        verification,
        ...(waiver ? { verificationWaiver: waiver } : {}),
        preexistingChanges: preexisting,
        completion: completionRecord(run),
        ...(run.routing ? { routing: structuredClone(run.routing) } : {}),
        reasons,
        remaining,
        receipts,
        artifacts: [],
        usage: summarizeUsage(run.usage),
      };
      await writeRunArtifacts(run.dir, record);
      run.state = "written";
      run.status = status;
    } catch (error) {
      run.state = "failed";
      lastError = `run products: ${errorText(error)}`;
    }
    last = run;
    if (current === run) current = undefined;
  }

  /**
   * Record how the agent's last activity ended. Aborted stays (the task was cancelled); an error is
   * cleared by a later normal end (Pi retried and the request succeeded).
   */
  function noteOutcome(run: TaskRun, outcome: unknown, detail: string): void {
    if (run.ended?.outcome === "aborted") return;
    // Provider text may echo a key: scrub first, then cap.
    const text = scrubCredentials(detail, access.secrets).slice(0, MAX_OUTCOME_DETAIL_CHARS);
    if (outcome === "aborted") {
      run.lifecycle.cancel();
      run.ended = { outcome: "aborted", detail: text };
    } else if (outcome === "error") {
      // Keep the provider's message when the assistant message already reported it.
      if (run.ended?.outcome !== "error") run.ended = { outcome: "error", detail: text };
    }
    else if (outcome === "completed" || outcome === "stop" || outcome === "toolUse" || outcome === "length") run.ended = null;
  }

  /**
   * Effective state per capability (product §4.1): what actually changes behavior, never what the
   * config merely asks for. Routing lines live in the host.
   */
  function capabilityLines(active: AdapterMode, run: TaskRun | undefined): string[] {
    if (active === "off") return ["强制评审：关闭", "完成验收：关闭", "续跑：关闭"];
    const { continuation } = config.harness;
    const blocked = outboundBlock([]);
    const snap = run?.lifecycle.snapshot();
    const used = `已用 ${snap?.continuations ?? 0}/${continuation.max}`;
    const continuationState =
      active === "on" && continuation.enabled ? "启用"
      : continuation.enabled ? "仅观察（shadow 模式不续跑）"
      : "仅观察（harness.continuation.enabled=false）";
    // A written task shows the status archived in run.json, never the controller's last phase.
    const phase = !snap ? "无"
      : run?.status ? `${run.status}（已归档）`
      : `${snap.phase}${snap.lastCompletion ? `；完成验收：${COMPLETION_LABELS[snap.lastCompletion.completionStatus]}` : ""}`;
    const enforcement = !enforce.length ? "无" : active === "on" ? enforce.join(",") : `仅观察（shadow 不拦截：${enforce.join(",")}）`;
    return [
      `强制评审：${enforcement}`,
      `完成验收：${blocked === null ? "开启" : `不可用（${blocked}，不发请求）`}`,
      `续跑：${continuationState}，${used}`,
      `当前任务：${phase}`,
    ];
  }

  return {
    startTask(prompt, ctx, routing) {
      if (current) {
        current.lifecycle.settled();
        const done = finish(current, "settled");
        closing.add(done);
        void done.finally(() => closing.delete(done));
      }
      current = newRun(prompt, ctx);
      current.routing = routing;
    },
    currentRunId: () => (current ?? last)?.runId,
    toolCall,
    toolResult(event, ctx) {
      const run = current;
      if (run && runSignalAborted(ctx)) noteOutcome(run, "aborted", "工具执行中收到中止");
      const record = run?.byCall.get(event.toolCallId);
      if (!run || !record) return;
      run.lifecycle.toolResult(event.toolCallId);
      try {
        run.ledger.accept({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          content: event.content,
          details: event.details,
          startedAt: record.startedAt,
          endedAt: Math.max(record.startedAt, deps.now()),
        });
      } catch (error) {
        lastError = `evidence: ${errorText(error)}`;
      }
    },
    messageEnd(event, ctx) {
      const message = event.message as { role?: unknown; usage?: Record<string, unknown>; stopReason?: unknown; errorMessage?: unknown };
      if (!current || message.role !== "assistant") return;
      const detail = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : `stopReason ${String(message.stopReason)}`;
      // A failure while Pi's run signal is aborted, or an abort error by its text, is the user's cancel.
      const aborted = message.stopReason === "error" && (runSignalAborted(ctx) || isAbortText(message.errorMessage));
      noteOutcome(current, aborted ? "aborted" : message.stopReason, detail);
      const text = assistantText(event.message);
      if (text) current.answer = text;
      const usage = message.usage;
      // Token counts come from the provider; Pi's cost is a list-price estimate, so cost stays unknown.
      current.usage.push(usage
        ? { inputTokens: usage.input as number, outputTokens: usage.output as number, cacheReadTokens: usage.cacheRead as number, cacheWriteTokens: usage.cacheWrite as number, costUsd: null }
        : null);
    },
    async beforeSettle(event, ctx) {
      const run = current;
      if (!run) return undefined;
      if (runSignalAborted(ctx)) noteOutcome(run, "aborted", "宿主中止信号已触发");
      else noteOutcome(run, event.outcome, `agent_before_settle outcome ${event.outcome}`);
      try {
        return await run.lifecycle.beforeSettle(event, ctx);
      } catch (error) {
        lastError = `before_settle: ${errorText(error)}`;
        return undefined;
      }
    },
    userMessage() {
      current?.lifecycle.userMessage();
    },
    setMode(next) {
      mode = next;
      current?.lifecycle.setMode(next);
    },
    async assessTool(tool, answer) {
      const run = current;
      if (!run) return unavailableCompletion(tool === "foreman_assess" ? "foreman" : "acceptance", "完成评估不可用：当前没有进行中的任务");
      return tool === "foreman_assess" ? capabilityScope.run("assess", () => run.lifecycle.assessTool(tool, answer)) : run.lifecycle.assessTool(tool, answer);
    },
    async settle() {
      const run = current;
      if (!run) return;
      // Concurrent settles share one close; `settling` is set synchronously so a shutdown arriving
      // while the products are being written waits for them instead of cancelling (defect 1).
      run.settling ??= (async () => {
        run.lifecycle.settled();
        await Promise.allSettled([...run.reviews]);
        await finish(run, "settled");
      })();
      await run.settling;
    },
    discard() {
      current?.lifecycle.setMode("off");
      current?.controller.abort("mode_off");
      current = undefined;
    },
    async settled() {
      await Promise.allSettled([...closing]);
    },
    async shutdown(reason) {
      await Promise.allSettled([...closing]);
      const run = current;
      if (!run) return;
      if (run.settling) {
        // The task already settled: its status is decided by that close, not by the shutdown.
        await run.settling;
        return;
      }
      if (reason === "new" || reason === "resume" || reason === "fork") run.lifecycle.sessionSwitch(`replaced:${reason}`);
      else run.lifecycle.cancel();
      run.controller.abort("shutdown");
      await Promise.allSettled([...run.reviews]);
      await finish(run, "shutdown");
    },
    statusLines(active) {
      const modeText = active === "off"
        ? "off (no envelopes, reviews or run products)"
        : enforce.length && active === "on"
          ? `${active}; enforced kinds: ${enforce.join(", ")} (blocked on failed validation, non-permit review or stale target)`
          : enforce.length
            ? `${active}; enforced kinds observed only: ${enforce.join(", ")} (would-be blocks recorded; nothing blocked)`
            : `${active} (envelopes checked and recorded; reviews not awaited; nothing blocked)`;
      const run = current ?? last;
      const next = config.harness.runId === undefined ? "<generated run id>" : tasks === 0 ? config.harness.runId : `${config.harness.runId}-${tasks + 1}`;
      const products = !run ? `none yet (next: ${join(config.harness.runsDir, next)})`
        : run.state === "written" ? `${run.dir} (written)`
        : run.state === "failed" ? `${run.dir} (write failed)`
        : `${run.dir} (task in progress)`;
      return [
        `harness: ${modeText}`,
        `harness actions this session: ${counts.envelopes} (validation failed ${counts.invalid}, blocked ${counts.blocked}${counts.wouldBlock ? `, would block in on ${counts.wouldBlock}` : ""}, reviews sent ${counts.reviewsSent})`,
        `harness run products: ${products}`,
        ...(lastError ? [`harness last error: ${lastError}`] : []),
        ...capabilityLines(active, run),
      ];
    },
  };
}
