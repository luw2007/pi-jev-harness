/**
 * wiring surface for the OMP host: C1 tool apply (`./tool-apply.ts`), C2 enforce
 * (`./enforce.ts`) and C3 approval + steer (`./approval.ts`). `./host.ts` calls these from its
 * handlers with the session state; nothing here registers events.
 *
 * Every entry point is a no-op unless the session mode is shadow or on (the host passes only an
 * active, non-closed session) and the session is not a child session. shadow never writes to the
 * host (no setActiveTools, no block, no confirm, no steer) and never awaits Jev.
 *
 * Budget: see ./budget.ts (enforce + approval spend the host-owned per-task counter).
 */
import type { JevAttempt, JevClient } from "../../jev/index.ts";
import type { JevAccess } from "../shared/jev-access.ts";
import type { ToolRouteResult } from "../../router/index.ts";
import type { TelemetryInput } from "../../telemetry/index.ts";
import type { AuditInput } from "../../telemetry/audit.ts";
import type { HostPort } from "../core/port.ts";
import { approveToolCall, SilentSteer, STEER_REMINDER } from "./approval.ts";
import { enforceToolCall, newEnforceTask, toolCallDeadline, type EnforceTask } from "./enforce.ts";
import type { LoadedConfig } from "./shared.ts";
import { applyRoutedTools, restoreTools, wouldApply, type AppliedTools } from "./tool-apply.ts";
import type { OmpContext, OmpExtensionAPI, OmpToolCallResult } from "./types.ts";

/** What the gates need from the host's session state. */
export interface GateSession {
  runId: string;
  mode: "off" | "shadow" | "on";
  loaded: LoadedConfig;
  closed: boolean;
  jev: JevAccess;
}

export interface GateDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  record: (event: TelemetryInput) => void;
  /** Called before every physical Jev request (host session counter). */
  onJevRequest: () => void;
  /** One unit from the host-owned per-task counter (routing, effort, enforce, approval); false = exhausted. */
  reserveTask: () => boolean;
  noteFallback: (reason: string) => void;
  /** content-free approval decision line (the session's audit writer). */
  audit?: (input: AuditInput) => void;
}

/** Approval decision → audit outcome (AUDIT_SCHEMA.approval). */
const APPROVAL_AUDIT: Record<string, string> = {
  approved: "approved", no_ui_allow: "approved", timeout_allow: "approved",
  denied: "denied", no_ui_deny: "denied", timeout_deny: "denied",
  deadline: "timeout", would_confirm: "skipped", low_risk: "ok",
};

interface GateTask {
  enforce: EnforceTask;
  /** Prompt of the open task; a repeated before_agent_start with it is a retry. */
  prompt?: string;
  open?: boolean;
  apply: AppliedTools | undefined;
  decisionId: string;
}

export interface OmpGates {
  /** `before_agent_start`: restores the previous task's tools; in on + router.tools on, awaits the route and applies it. */
  startTask(session: GateSession, prompt: string, ctx: OmpContext, route: Promise<ToolRouteResult | undefined> | undefined): Promise<void>;
  toolCall(session: GateSession, event: { toolName: string; toolCallId: string; input: unknown }, ctx: OmpContext): Promise<OmpToolCallResult | undefined>;
  toolResult(session: GateSession, ctx: OmpContext): void;
  messageEnd(message: unknown): void;
  input(source: unknown): void;
  /** A before_agent_start for the task already open (host retry): do not re-route or re-apply. */
  isRetry(prompt: string): boolean;
  /** `/jev mode off` (from shadow/on): end the task now and give back owned tools. */
  modeOff(session: GateSession): Promise<void>;
  /** Terminal end of a task (`agent_end` without `willContinue`): give back owned tools. */
  endTask(session: GateSession): Promise<void>;
  /** Session ends: cancel reviews, give back owned tools, wait for background work. */
  shutdown(session: GateSession): Promise<void>;
  settled(): Promise<void>;
  statusLines(session: GateSession): string[];
}

export function createOmpGates(port: HostPort<OmpContext>, api: Pick<OmpExtensionAPI, "sendMessage">, deps: GateDeps): OmpGates {
  const counts = { applied: 0, nativeKept: 0, wouldApply: 0, blocked: 0, wouldBlock: 0, confirmed: 0, denied: 0, wouldConfirm: 0, steers: 0, wouldSteer: 0 };
  const steer = new SilentSteer();
  const pending = new Set<Promise<void>>();
  let task: GateTask | undefined;
  const clients = new Map<string, JevClient | undefined>();
  let clientRun: string | undefined;

  const isChild = (ctx: OmpContext) => {
    try {
      return port.session(ctx).isChildSession;
    } catch {
      return false;
    }
  };

  /** One client per session and capability (chainFor(capability) via the session's JevAccess). */
  function jev(session: GateSession, capability: "enforce" | "approval"): () => JevClient | undefined {
    return () => {
      if (clientRun !== session.runId) {
        clients.clear();
        clientRun = session.runId;
      }
      if (!clients.has(capability)) {
        // Enforce reviews and approval risk ride the `assess` / `acceptance` chains (no own chain names in C9).
        clients.set(capability, session.jev.client(capability === "enforce" ? "assess" : "acceptance", {
          fetch: (input, init) => {
            deps.onJevRequest();
            return deps.fetch(input, init);
          },
          now: deps.now,
          newId: () => `att_${deps.newId()}`,
          waitMs: session.loaded.config.budget.waitMs,
          onAttempt: (attempt: JevAttempt) => deps.record({ runId: session.runId, decisionId: task?.decisionId ?? `dec_${deps.newId()}`, attemptId: attempt.attemptId,
            kind: "jev_attempt", outcome: attempt.status === "ok" ? "ok" : "unavailable", durationMs: attempt.durationMs, source: `jev:${attempt.status}` }),
        }));
      }
      return clients.get(capability);
    };
  }

  const secrets = (session: GateSession, capability: "assess" | "acceptance") => (session.jev.available(capability) ? session.jev.secrets : undefined);

  /** The per-task counter is host-owned and shared with routing and effort (see ./budget.ts). */
  const reserve = () => deps.reserveTask;

  const recordTools = (session: GateSession, decisionId: string, outcome: TelemetryInput["outcome"], source: TelemetryInput["source"]) =>
    deps.record({ runId: session.runId, decisionId, kind: "route_tools", outcome, durationMs: 0, ...(source ? { source } : {}) });

  async function giveBack(session: GateSession, t: GateTask | undefined) {
    const apply = t?.apply;
    if (!t || !apply) return;
    t.apply = undefined;
    try {
      const { restored, external } = await restoreTools(port, apply);
      if (external) recordTools(session, t.decisionId, "skipped", "tools:external_change_kept");
      if (restored) recordTools(session, t.decisionId, "ok", "tools:restored");
    } catch {
      deps.noteFallback("tools: restore failed");
    }
  }

  return {
    async startTask(session, prompt, ctx, route) {
      const previous = task;
      previous?.enforce.controller.abort("new_task");
      await giveBack(session, previous);
      const cwd = port.session(ctx).cwd;
      task = { enforce: newEnforceTask(prompt, cwd), prompt, open: true, apply: undefined, decisionId: `dec_${deps.newId()}` };
      const { config } = session.loaded;
      if (isChild(ctx) || config.router.tools === "off") return;
      if (!route) {
        // Routing withheld (outbound gate / credential) or snapshot failed: native tools stay.
        if (session.mode === "on" && config.router.tools === "on") counts.nativeKept++;
        return;
      }
      const current = task;
      if (session.mode === "shadow" || config.router.tools !== "on") {
        // Would-apply only: computed after routing, host untouched.
        const baseline = port.getActiveTools();
        const job = route.then((result) => {
          if (wouldApply(baseline, result)) counts.wouldApply++;
        }, () => {});
        pending.add(job);
        void job.finally(() => pending.delete(job));
        return;
      }
      const result = await route.catch(() => undefined);
      if (session.closed || task !== current || session.mode !== "on") return;
      const outcome = await applyRoutedTools(port, result);
      if (outcome.kind === "applied") {
        current.apply = outcome.apply;
        counts.applied++;
        recordTools(session, current.decisionId, "ok", "tools:applied");
      } else if (outcome.kind === "mismatch") {
        deps.noteFallback(`tools: apply read-back mismatch; ${outcome.restored ? "restored" : "restore unverified"}`);
        recordTools(session, current.decisionId, "fallback", "tools:apply_mismatch");
      } else {
        counts.nativeKept++;
        deps.noteFallback(`tools: native tools kept (${outcome.reason})`);
        recordTools(session, current.decisionId, "fallback", "tools:native_kept");
      }
    },

    async toolCall(session, event, ctx) {
      if (session.mode === "off" || session.closed || isChild(ctx)) return undefined;
      const mode = session.mode;
      const t = task ??= { enforce: newEnforceTask("", port.session(ctx).cwd), apply: undefined, decisionId: `dec_${deps.newId()}` };
      const { config } = session.loaded;
      const view = port.session(ctx);
      const deadlineAt = toolCallDeadline(config.budget.waitMs, config.approval.enabled && view.hasUI);
      const record = (outcome: TelemetryInput["outcome"]) =>
        deps.record({ runId: session.runId, decisionId: `dec_${deps.newId()}`, kind: "review", outcome, durationMs: 0 });
      const blocked = await enforceToolCall({
        config, secrets: secrets(session, "assess"), jev: jev(session, "enforce"), newId: deps.newId, reserve: reserve(),
        onDecision: (outcome) => {
          if (outcome === "blocked") counts.blocked++;
          if (outcome === "would_block") counts.wouldBlock++;
          record(outcome === "would_block" ? "skipped" : outcome);
        },
      }, t.enforce, mode, event, deadlineAt);
      if (blocked !== undefined) return port.blockResult(`pi-jev-harness: ${blocked}`);
      const denied = await approveToolCall({
        config, secrets: secrets(session, "acceptance"), jev: jev(session, "approval"), newId: deps.newId, reserve: reserve(),
        onDecision: (outcome) => {
          if (outcome === "approved" || outcome === "no_ui_allow" || outcome === "timeout_allow") counts.confirmed++;
          if (outcome === "denied" || outcome === "no_ui_deny" || outcome === "timeout_deny" || outcome === "deadline") counts.denied++;
          if (outcome === "would_confirm") counts.wouldConfirm++;
          deps.audit?.({ kind: "approval", event: "tool_call", outcome: APPROVAL_AUDIT[outcome] ?? "failed", mode, runId: session.runId, decisionId: `dec_${deps.newId()}` });
          if (outcome !== "low_risk") record(outcome === "denied" || outcome === "no_ui_deny" || outcome === "timeout_deny" || outcome === "deadline" ? "blocked" : outcome === "would_confirm" ? "skipped" : "ok");
        },
      }, mode, event, view, pending, deadlineAt);
      return denied === undefined ? undefined : port.blockResult(denied);
    },

    toolResult(session, ctx) {
      if (session.mode === "off" || session.closed || !session.loaded.config.approval.silentSteer || isChild(ctx)) return;
      if (!steer.toolResult()) return;
      if (session.mode === "shadow" || !api.sendMessage) {
        counts.wouldSteer++;
        return;
      }
      counts.steers++;
      api.sendMessage({ customType: "jev-autorun-reminder", content: STEER_REMINDER, display: true }, { deliverAs: "steer" });
    },

    messageEnd: (message) => steer.messageEnd(message),
    input: (source) => {
      steer.input(source);
      if (source !== "extension" && task) task.open = false;
    },

    isRetry: (prompt) => task?.open === true && task.prompt === prompt,

    async modeOff(session) {
      const t = task;
      if (!t) return;
      t.open = false;
      t.enforce.controller.abort("mode_off");
      await giveBack(session, t);
    },

    async endTask(session) {
      if (task) task.open = false;
      await giveBack(session, task);
    },

    async shutdown(session) {
      task?.enforce.controller.abort("shutdown");
      await giveBack(session, task);
      await Promise.allSettled([...pending, ...(task?.enforce.pending ?? [])]);
    },

    async settled() {
      await Promise.allSettled([...pending, ...(task?.enforce.pending ?? [])]);
    },

    statusLines(session) {
      const { config } = session.loaded;
      const a = config.approval;
      return [
        `tools apply: ${config.router.tools === "on" && session.mode === "on" ? "on" : "observe only"}; applied ${counts.applied}, native kept ${counts.nativeKept}, would-apply ${counts.wouldApply}`,
        `enforce: ${config.harness.enforce.length ? config.harness.enforce.join(",") : "none"}; blocked ${counts.blocked}, would-block ${counts.wouldBlock}`,
        `approval: ${a.enabled ? `on (no UI: ${a.noUi})` : "off"}; confirmed ${counts.confirmed}, denied ${counts.denied}, would-confirm ${counts.wouldConfirm}; steer ${a.silentSteer ? "on" : "off"} (sent ${counts.steers}, would ${counts.wouldSteer})`,
      ];
    },
  };
}
