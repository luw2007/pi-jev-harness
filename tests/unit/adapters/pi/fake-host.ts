import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../../../../src/adapters/pi/index.ts";
import { loadConfig } from "../../../../src/adapters/pi/config.ts";
import type { HostDeps } from "../../../../src/adapters/pi/host.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PiModel } from "../../../../src/adapters/pi/tools.ts";
import { createTelemetryWriter } from "../../../../src/telemetry/index.ts";

export const KEY = "sk-test-SECRET-9f8e7d";
export const JEV_URL = "http://jev.test/v1/systemone";

export function sourceInfo(source: string): ToolInfo["sourceInfo"] {
  return { path: `<${source}>`, source, scope: "temporary", origin: "top-level" };
}

export const TOOLS: ToolInfo[] = [
  { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, sourceInfo: sourceInfo("builtin") },
  { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, sourceInfo: sourceInfo("builtin") },
  { name: "edit", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, sourceInfo: sourceInfo("builtin") },
];

function model(id: string, fields: Pick<PiModel, "reasoning" | "input" | "contextWindow">): PiModel {
  return { id, name: id, api: "openai-completions", provider: "prov", baseUrl: "http://prov.test", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 8192, ...fields };
}

export const MODELS: PiModel[] = [
  model("alpha", { reasoning: false, input: ["text"], contextWindow: 100_000 }),
  model("beta", { reasoning: true, input: ["text", "image"], contextWindow: 200_000 }),
];

type Listener = (event: unknown, ctx: ExtensionCommandContext) => unknown;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

export interface FakePi {
  pi: ExtensionAPI;
  listeners: Map<string, Listener[]>;
  commands: Map<string, Command>;
  /** Tools registered through `pi.registerTool`, by name. */
  tools: Map<string, ToolDefinition>;
  setterCalls: string[];
  /** Arguments of every `setActiveTools` call, in order. */
  setActiveToolsArgs: string[][];
  /** The host's live active tool names. */
  active(): string[];
  /** A change made by the user or another extension (bypasses `setActiveTools` recording). */
  setActive(names: string[]): void;
  notes: string[];
  ctx: ExtensionCommandContext;
  emit(event: string, payload: Record<string, unknown>): Promise<unknown[]>;
  /** Emit without awaiting async handlers; returns raw handler results. */
  emitSync(event: string, payload: Record<string, unknown>): unknown[];
  command(args: string): Promise<string>;
  /** Run a registered tool's `execute` as Pi would. */
  runTool(name: string, params: Record<string, unknown>, toolCallId?: string): Promise<{ content: { type: string; text?: string }[]; details: unknown }>;
}

export function fakePi(options: {
  tools?: ToolInfo[];
  active?: string[];
  models?: PiModel[];
  contextTokens?: number | null;
  cwd?: string;
  pendingMessages?: () => boolean;
  /**
   * What the host does with a `setActiveTools` call; returns the new active set. Default: Pi's
   * behavior (registered names only, unknown names ignored).
   */
  onSetActiveTools?: (names: string[], call: number) => string[];
} = {}): FakePi {
  const listeners = new Map<string, Listener[]>();
  const commands = new Map<string, Command>();
  const registered = new Map<string, ToolDefinition>();
  const setterCalls: string[] = [];
  const notes: string[] = [];
  const tools = options.tools ?? TOOLS;
  const models = options.models ?? MODELS;
  let active = options.active ?? tools.map((tool) => tool.name);
  const setActiveToolsArgs: string[][] = [];
  const registeredNames = () => new Set([...tools.map((tool) => tool.name), ...registered.keys()]);
  // The fakes implement only the members the adapter reads; the casts widen them to the host types.
  const ctx = {
    cwd: options.cwd ?? process.cwd(),
    model: models[0],
    scopedModels: [],
    modelRegistry: { getAvailable: () => [...models], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => null, getBranch: () => [], getSessionId: () => "session-test", getLeafId: () => null },
    getContextUsage: () => ({ tokens: options.contextTokens ?? null, contextWindow: 100_000, percent: null }),
    hasPendingMessages: () => options.pendingMessages?.() ?? false,
    signal: undefined,
    ui: { notify: (message: string) => { notes.push(message); } },
  } as unknown as ExtensionCommandContext;
  const used: Pick<ExtensionAPI, "registerCommand" | "registerTool" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "setActiveTools" | "setModel" | "setThinkingLevel"> & {
    on(event: string, handler: Listener): () => void;
  } = {
    on(event: string, handler: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { registered.set(tool.name, tool as unknown as ToolDefinition); },
    getActiveTools: () => [...active],
    getAllTools: () => [...tools],
    getThinkingLevel: () => "medium",
    setActiveTools: (names) => {
      setterCalls.push("setActiveTools");
      setActiveToolsArgs.push([...names]);
      active = options.onSetActiveTools ? options.onSetActiveTools([...names], setActiveToolsArgs.length) : names.filter((name) => registeredNames().has(name));
    },
    setModel: async () => { setterCalls.push("setModel"); return true; },
    setThinkingLevel: () => { setterCalls.push("setThinkingLevel"); },
  };
  const pi = used as unknown as ExtensionAPI;
  const emitSync = (event: string, payload: Record<string, unknown>) =>
    (listeners.get(event) ?? []).map((listener) => listener({ type: event, ...payload }, ctx));
  return {
    pi, listeners, commands, tools: registered, setterCalls, setActiveToolsArgs, notes, ctx,
    active: () => [...active],
    setActive: (names) => { active = [...names]; },
    emitSync,
    emit: (event, payload) => Promise.all(emitSync(event, payload)),
    async runTool(name, params, toolCallId = `tool-${name}`) {
      const tool = registered.get(name);
      if (!tool) throw new Error(`tool ${name} not registered`);
      return (await tool.execute(toolCallId, params as never, undefined, undefined, ctx)) as { content: { type: string; text?: string }[]; details: unknown };
    },
    async command(args) {
      const before = notes.length;
      await commands.get("jev")!.handler(args, ctx);
      return notes.slice(before).join("\n");
    },
  };
}

export interface JevRequest {
  url: string;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
  signal: AbortSignal | undefined;
}

export type Responder = (request: JevRequest) => Promise<Response> | Response;

/** Valid Choice answer: first non-clarification option leads. */
export function validAnswer(request: JevRequest): Response {
  const answers = Object.fromEntries(Object.entries(request.body.questions).map(([id, question]) => {
    const ids = Object.keys(question.criteria);
    const choice = ids.find((option) => option !== "needs_clarification") ?? ids[0]!;
    const rest = (1 - 0.7) / (ids.length - 1);
    return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(ids.map((option) => [option, option === choice ? 0.7 : rest])) }];
  }));
  return new Response(JSON.stringify({ model: request.body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
}

/** Never answers; rejects when the request signal aborts. */
export function hang(request: JevRequest): Promise<Response> {
  // Executor form: tsconfig targets ES2022, which lacks Promise.withResolvers.
  return new Promise((_, reject) => {
    request.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
  });
}

export function fakeFetch(responder: Responder = validAnswer) {
  const requests: JevRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: JevRequest = { url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined };
    requests.push(request);
    return responder(request);
  }) as typeof globalThis.fetch;
  return { fetch, requests, questionIds: () => requests.flatMap((request) => Object.keys(request.body.questions)) };
}

export interface TelemetryLine {
  kind: string;
  outcome: string;
  source: string;
  [field: string]: unknown;
}

export interface Harness {
  dir: string;
  configPath: string;
  telemetryDir: string;
  deps(overrides?: Partial<HostDeps>): Partial<HostDeps>;
  telemetryText(): Promise<string>;
  events(): Promise<TelemetryLine[]>;
  cleanup(): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-adapter-"));
  const configPath = join(dir, "config.json");
  const telemetryDir = join(dir, "telemetry");
  const env = { TYPESAFE_API_KEY: KEY, PI_JEV_URL: JEV_URL };
  const telemetryText = async () => {
    let names: string[];
    try { names = await readdir(telemetryDir); } catch { return ""; }
    const texts = await Promise.all(names.map((name) => readFile(join(telemetryDir, name), "utf8")));
    return texts.join("");
  };
  return {
    dir, configPath, telemetryDir,
    deps: (overrides = {}) => {
      const envUsed = overrides.env ?? env;
      return {
        env: envUsed,
        loadConfig: () => loadConfig({ home: dir, path: configPath, env: envUsed, telemetryDir }),
        createTelemetry: (target) => createTelemetryWriter({ dir: target, now: Date.now }),
        ...overrides,
      };
    },
    telemetryText,
    async events() {
      return (await telemetryText()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Load the extension into a fresh fake Pi with an isolated claim registry. */
export function load(fake: FakePi, deps: Partial<HostDeps>, registry: object = {}) {
  createExtension(deps, registry as never)(fake.pi);
  return registry;
}

/** Wait until every shadow decision started so far has been recorded (without shutting down). */
export async function settled(registry: object) {
  const claim = (registry as Record<symbol, { host: { settled(): Promise<void> } } | undefined>)[Symbol.for("pi-jev-harness.adapter.pi")];
  await claim?.host.settled();
}
