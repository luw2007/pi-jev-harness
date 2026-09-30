/**
 * `/jev` for OMP (T105 C10): `/jev [status]`, `/jev help`, `/jev mode off|shadow|on`,
 * `/jev acceptance on|off|dry-run|status`, `/jev autorun on|off|dry-run|status`,
 * `/jev debug on|off|status`. `dry-run` maps to `shadow`. Changes last for this session only;
 * no file is written. Unknown subcommands warn with the usage line.
 */
import type { CapabilityMode } from "./legacy-config.ts";
import type { CapabilityName, CapabilityState, SessionMode } from "./stop.ts";

export const USAGE = "Usage: /jev <status|mode|acceptance|autorun|debug|help> [arguments]";
export const HELP = [
  USAGE,
  "  /jev [status]                           show mode, config sources and capability state",
  "  /jev mode off|shadow|on                 session mode (dry-run = shadow)",
  "  /jev acceptance on|off|dry-run|status   completion acceptance at session_stop",
  "  /jev autorun on|off|dry-run|status      bounded continuation (at most 2 per task)",
  "  /jev debug on|off|status                TUI summaries; Ctrl+O expands request/response bodies (stderr summaries without TUI)",
  "  /jev help                               show this help",
].join("\n");

const COMPLETIONS = ["status", "help", "mode off", "mode shadow", "mode on",
  ...["acceptance", "autorun"].flatMap((name) => ["on", "off", "dry-run", "status"].map((value) => `${name} ${value}`)),
  ...["on", "off", "status"].map((value) => `debug ${value}`)];

export function jevCompletions(prefix: string): Array<{ value: string; label: string }> {
  return COMPLETIONS.filter((item) => item.startsWith(prefix.trimStart())).map((item) => ({ value: item, label: item }));
}

export function parseMode(value: string | undefined): CapabilityMode | undefined {
  if (value === "dry-run" || value === "shadow") return "shadow";
  return value === "on" || value === "off" ? value : undefined;
}

type Level = "info" | "warning";

export interface JevCommandTarget {
  status(): string;
  /** Returns the refusal text, or undefined when the mode was applied. */
  setMode(mode: SessionMode): string | undefined;
  /** Undefined without an active session. */
  capability(name: CapabilityName): CapabilityState | undefined;
  setCapability(name: CapabilityName, mode: CapabilityMode): boolean;
  debug?(): boolean | undefined;
  setDebug?(enabled: boolean): boolean;
  continuations(): { used: number; max: number } | undefined;
}

/** Pure dispatcher: returns the notification to show. */
export function runJevCommand(args: string, target: JevCommandTarget): { text: string; level: Level } {
  const [sub, value, extra] = args.trim().split(/\s+/).filter(Boolean);
  if (!sub || (sub === "status" && !value)) return { text: target.status(), level: "info" };
  if (sub === "help" && !value) return { text: HELP, level: "info" };
  if (sub === "mode") {
    const mode = parseMode(value);
    if (!mode || extra) return { text: "Usage: /jev mode off|shadow|on", level: "warning" };
    const refused = target.setMode(mode);
    return refused ? { text: refused, level: "warning" } : { text: `Jev: ${mode} (this session)`, level: "info" };
  }
  if (sub === "acceptance" || sub === "autorun") {
    const mode = parseMode(value);
    if (extra || (value !== undefined && value !== "status" && !mode)) return { text: `Usage: /jev ${sub} on|off|dry-run|status`, level: "warning" };
    if (mode && !target.setCapability(sub, mode)) return { text: "Jev: no active session", level: "warning" };
    const state = target.capability(sub);
    if (!state) return { text: "Jev: no active session", level: "warning" };
    const counts = sub === "autorun" ? target.continuations() : undefined;
    return { text: `${sub}=${state.mode} source=${state.source}${counts ? ` continues=${counts.used}/${counts.max}` : ""}`, level: "info" };
  }
  if (sub === "debug") {
    if (extra || (value !== undefined && value !== "status" && value !== "on" && value !== "off"))
      return { text: "Usage: /jev debug on|off|status", level: "warning" };
    if (value === "on" || value === "off") {
      if (!target.setDebug?.(value === "on")) return { text: "Jev: no active session", level: "warning" };
    }
    const enabled = target.debug?.();
    if (enabled === undefined) return { text: "Jev: no active session", level: "warning" };
    return { text: `Jev debug: ${enabled ? "on" : "off"} (this session)${enabled ? "; TUI: Ctrl+O expands full request/response bodies; without TUI stderr shows summaries only. WARNING: expanded traces expose outbound task context" : ""}`, level: "info" };
  }
  return { text: `Unknown /jev subcommand '${sub}'.\n${USAGE}`, level: "warning" };
}
