// Adapted from TypeSafeAI/jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:tests/routing.test.ts (MIT)
// Adapted from TypeSafeAI/jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:tests/routing-bundle.test.ts (MIT)
// Adapted from TypeSafeAI/jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:tests/routing-prepare.test.ts (MIT)
// Adapted from TypeSafeAI/jev-harness@44a4e3a17013b6458efd4cc2b3e8ca45efae60b8:examples/routing/scenarios.ts (MIT)
// Port notes: imports point at vendor/jev-harness; each upstream test file keeps its own
// block scope so its top-level constants stay verbatim; routing-bundle fixtures from
// examples/routing/scenarios.ts are inlined below; routing-prepare tests that need the
// H root entry (src/index.ts) or examples/integration/host.ts are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../../../vendor/jev-harness/src/routing/index.ts";
import { routeTools } from "../../../vendor/jev-harness/src/routing/route.ts";
import { assembleToolBundle } from "../../../vendor/jev-harness/src/routing/bundle.ts";
import { createCatalog, type RoutingPolicy, type RoutingReceipt, type ToolRouter } from "../../../vendor/jev-harness/src/routing/index.ts";

// ---- examples/routing/scenarios.ts (inlined fixture) ----
/** Historical routing v1 snapshot; retain descriptions and schemas for replay. */
export const DEMO_CATALOG_V1 = createCatalog([
  { id: "read_file", kind: "tool", description: "Read one named file in a synthetic workspace without changing it.", estimatedCostUnits: 1,
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative path to the single synthetic file to inspect; no absolute paths or parent traversal." } }, required: ["path"], additionalProperties: false } },
  { id: "propose_patch", kind: "tool", description: "Record a proposed single-file edit for a concrete defect; never apply it.", estimatedCostUnits: 3,
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative synthetic file path." }, patch: { type: "string", description: "Single-file unified diff describing a pending proposal only." }, rationale: { type: "string", description: "How the proposed edit addresses the requested defect." } }, required: ["path", "patch", "rationale"], additionalProperties: false } },
  { id: "inspect_agent", kind: "subagent", description: "A specialist descriptor for inspecting synthetic files and explaining a defect; no agent is launched.", estimatedCostUnits: 9,
    inputSchema: { type: "object", properties: { task: { type: "string", description: "A bounded inspection task for the synthetic specialist." }, path: { type: "string", description: "Synthetic target path for inspection." }, includeExplanation: { type: "boolean", description: "Whether to include a detailed explanation in a future host implementation." } }, required: ["task", "path"], additionalProperties: false } },
]);
/** v2 clarifies the deterministic inspector's actual source-context capability. */
export const DEMO_CATALOG = createCatalog(DEMO_CATALOG_V1.map(tool => tool.id === "inspect_agent"
  ? { ...tool, description: "Return synthetic source context for inspecting behavior, relationships, and defects; deterministic fixture support, with no model subagent launched." }
  : tool));
export const DEMO_POLICY: RoutingPolicy = { topK: 1, confidenceFloor: 0.7, probabilityFloor: 0.2, relevanceWindow: 0.1, maxCostUnits: 10 };
export interface RoutingScenario {
  id: string;
  title: string;
  intent: string;
  /** Bookkeeping and scripted evidence; neither appears in the request. */
  acceptableIds: readonly string[];
  expectedOutcome: RoutingReceipt["outcome"];
  weights: Record<string, number>;
  confidence: number;
  /** Scripted alternatives are independent of evaluation labels. */
  mockAlternatives?: Record<string, string>;
  failure?: "unavailable" | "malformed";
}
export const SCENARIOS: readonly RoutingScenario[] = [
  { id: "read", mockAlternatives: { read_file: "inspect_agent", inspect_agent: "read_file" }, title: "Read a file", intent: "Read src/sum.ts in the synthetic workspace.", acceptableIds: ["read_file", "inspect_agent"], expectedOutcome: "selected", weights: { read_file: 0.46, inspect_agent: 0.5, propose_patch: 0.01, needs_clarification: 0.03 }, confidence: 0.9 },
  { id: "patch", title: "Propose an edit", intent: "Propose a patch to fix the off-by-one loop in synthetic src/sum.ts.", acceptableIds: ["propose_patch"], expectedOutcome: "selected", weights: { read_file: 0.03, inspect_agent: 0.04, propose_patch: 0.9, needs_clarification: 0.03 }, confidence: 0.9 },
  { id: "inspect", title: "Ask a specialist", intent: "Explain the interaction of both helpers in synthetic src/sum.ts.", acceptableIds: ["inspect_agent"], expectedOutcome: "selected", weights: { read_file: 0.1, inspect_agent: 0.84, propose_patch: 0.03, needs_clarification: 0.03 }, confidence: 0.85 },
  { id: "ambiguous", title: "Clarify the task", intent: "Clean up the helper.", acceptableIds: [], expectedOutcome: "needs_clarification", weights: { needs_clarification: 1 }, confidence: 0.95 },
  { id: "uncertain", title: "Low confidence", intent: "Look at the example and maybe change it.", acceptableIds: [], expectedOutcome: "needs_clarification", weights: { read_file: 0.4, inspect_agent: 0.3, propose_patch: 0.2, needs_clarification: 0.1 }, confidence: 0.3 },
  { id: "outage", title: "Adapter unavailable", intent: "Inspect the synthetic example while the adapter is unavailable.", acceptableIds: [], expectedOutcome: "unavailable", weights: {}, confidence: 0, failure: "unavailable" },
  { id: "invalid", title: "Out-of-set response", intent: "Inspect the synthetic example with an invalid adapter response.", acceptableIds: [], expectedOutcome: "unavailable", weights: {}, confidence: 0, failure: "malformed" },
];

/** Scripted demo values, not Jev measurements or a semantic router. */
export function scenarioRouter(scenario: RoutingScenario): ToolRouter {
  return { source: "mock", review: async request => {
    if (scenario.failure === "unavailable") throw Error("Synthetic adapter outage");
    if (scenario.failure === "malformed") return { model: request.model, choice: "not_in_catalog", confidence: 1, probabilities: {} };
    const weights = request.options.map(option => [option.id, scenario.weights[option.id] ?? 0] as const);
    // A removed relevant tool does not promote an unrelated tool by renormalization.
    const probabilities = Object.fromEntries(weights);
    for (const [id, mass] of Object.entries(scenario.weights)) {
      if (request.options.some(option => option.id === id)) continue;
      const alternative = scenario.mockAlternatives?.[id];
      const target = alternative && Object.hasOwn(probabilities, alternative) ? alternative : "needs_clarification";
      probabilities[target]! += mass;
    }
    const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
    if (total === 0) probabilities.needs_clarification = 1;
    const choice = Object.keys(probabilities).sort((a, b) => probabilities[b]! - probabilities[a]!)[0]!;
    return { model: request.model, choice, confidence: scenario.confidence, probabilities };
  } };
}

// ---- tests/routing.test.ts ----
{
  const tools: api.ToolDefinition[] = [
    { id: "read", kind: "tool", description: "Read a synthetic file", estimatedCostUnits: 1, inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative synthetic path" } }, required: ["path"], additionalProperties: false } },
    { id: "specialist", kind: "subagent", description: "Inspect a synthetic file", estimatedCostUnits: 8, inputSchema: { type: "object", properties: { task: { type: "string", description: "Task to inspect" } }, required: ["task"], additionalProperties: false } },
  ];
  const policy: api.RoutingPolicy = { topK: 1, confidenceFloor: 0.7, probabilityFloor: 0.2, relevanceWindow: 0.1, maxCostUnits: 10 };
  const input = { intent: "Read the example file", availableIds: ["read", "specialist"] };
  const evidence = { model: "jev-1.13.0", choice: "specialist", confidence: 0.9, probabilities: { read: 0.46, specialist: 0.5, needs_clarification: 0.04 } };
  const router = (value: unknown): api.ToolRouter => ({ source: "mock", review: async () => value });
  const run = (value: unknown = evidence, overrides = {}) => api.routeTools(api.createCatalog(tools), input, { ...policy, ...overrides }, router(value));

  test("catalog is a detached immutable schema registry with unique closed-set ids", () => {
    assert.equal(typeof api.createCatalog, "function");
    const copy = structuredClone(tools);
    const catalog = api.createCatalog(copy);
    copy[0]!.inputSchema.properties.path!.description = "changed";
    assert.equal(catalog[0]!.inputSchema.properties.path!.description, "Relative synthetic path");
    assert.ok(Object.isFrozen(catalog[0]!.inputSchema.properties));
    for (const invalid of [[tools[0]!, tools[0]!], [{ ...tools[0]!, id: "needs_clarification" }], [{ ...tools[0]!, estimatedCostUnits: NaN }], [{ ...tools[0]!, inputSchema: { ...tools[0]!.inputSchema, required: ["missing"] } }]])
      assert.throws(() => api.createCatalog(invalid));
  });

  test("compact adapter payload excludes schemas, fixture labels and cost metadata", async () => {
    let payload: api.RoutingRequest | undefined;
    const result = await api.routeTools(api.createCatalog(tools), input, policy, { source: "mock", review: async p => { payload = p; return evidence; } });
    assert.equal(payload!.model, "jev-1.13.0");
    assert.match(payload!.untrustedDataNote, /untrusted/);
    assert.deepEqual(Object.keys(payload!.options[0]!).sort(), ["description", "id", "kind"]);
    assert.equal(JSON.stringify(payload).includes("inputSchema"), false);
    assert.deepEqual(result.selectedIds, ["read"]);
    assert.equal(result.execution.applied, false);
    assert.match(result.reason, /cost.*evidence.*authorization/i);
  });

  test("confidence, clarification, cost and top-k are deterministic policy", async () => {
    assert.equal((await run({ ...evidence, confidence: 0.69 })).outcome, "needs_clarification");
    assert.equal((await run({ ...evidence, choice: "needs_clarification", probabilities: { read: 0.1, specialist: 0.1, needs_clarification: 0.8 } })).outcome, "needs_clarification");
    assert.equal((await run(evidence, { maxCostUnits: 0 })).outcome, "no_match");
    assert.deepEqual((await run(evidence, { topK: 2 })).selectedIds, ["read", "specialist"]);
    assert.deepEqual((await run(evidence, { relevanceWindow: 0 })).selectedIds, ["specialist"]);
    assert.deepEqual((await run(evidence, { probabilityFloor: 0.6 })).selectedIds, []);
    for (const overrides of [{ topK: 0 }, { topK: 1.5 }, { confidenceFloor: NaN }, { relevanceWindow: -1 }, { probabilityFloor: 2 }, { maxCostUnits: Infinity }])
      await assert.rejects(() => run(evidence, overrides));
  });

  test("malformed or out-of-set evidence never loads tools", async () => {
    for (const value of [null, {}, { ...evidence, model: "jev-latest" }, { ...evidence, confidence: 2 }, { ...evidence, choice: "read" }, { ...evidence, probabilities: { read: 1 } }, { ...evidence, probabilities: { ...evidence.probabilities, hidden: 0 } }, { ...evidence, probabilities: { read: NaN, specialist: 0.5, needs_clarification: 0.5 } }, { ...evidence, probabilities: { read: -0.1, specialist: 1, needs_clarification: 0.1 } }]) {
      const result = await run(value);
      assert.equal(result.outcome, "unavailable");
      assert.deepEqual(result.selectedIds, []);
      assert.equal(result.evidence, null);
    }
  });

  test("availability and abort are enforced before and after the adapter", async () => {
    const catalog = api.createCatalog(tools);
    let calls = 0;
    const adapter: api.ToolRouter = { source: "mock", review: async () => { calls++; throw Error("private error content"); } };
    assert.equal((await api.routeTools(catalog, { ...input, availableIds: [] }, policy, adapter)).outcome, "no_match");
    assert.equal(calls, 0);
    await assert.rejects(() => api.routeTools(catalog, { ...input, availableIds: ["hidden"] }, policy, adapter));
    await assert.rejects(() => api.routeTools(catalog, { ...input, availableIds: ["read", "read"] }, policy, adapter));
    const failed = await api.routeTools(catalog, input, policy, adapter);
    assert.equal(failed.outcome, "unavailable");
    assert.equal(JSON.stringify(failed).includes("private error content"), false);
    const controller = new AbortController();
    controller.abort();
    await api.routeTools(catalog, input, policy, adapter, controller.signal);
    assert.equal(calls, 1);
    const late = new AbortController();
    const result = await api.routeTools(catalog, input, policy, { source: "mock", review: async () => { late.abort(); return evidence; } }, late.signal);
    assert.equal(result.outcome, "unavailable");
    const hidden = await api.routeTools(catalog, { ...input, availableIds: ["read"] }, policy, router(evidence));
    assert.equal(hidden.outcome, "unavailable");
  });

  test("pending reviews use detached snapshots and ignore adapter mutations", async () => {
    const mutable = structuredClone(input);
    const mutablePolicy = { ...policy };
    const result = await api.routeTools(api.createCatalog(tools), mutable, mutablePolicy, { source: "mock", review: async payload => {
      mutable.availableIds.length = 0;
      mutablePolicy.maxCostUnits = 0;
      assert.throws(() => { (payload.options as unknown[]).length = 0; });
      return evidence;
    } });
    assert.deepEqual(result.selectedIds, ["read"]);
    assert.equal(result.policy.maxCostUnits, 10);
  });

  test("context transitions expose real schema loads and evictions without executing", async () => {
    const receipt = await run();
    const full = api.assembleContext(receipt, "full");
    const lean = api.assembleContext(receipt, "lean", full.state);
    assert.deepEqual(full.state.loadedIds, ["read", "specialist"]);
    assert.deepEqual(lean.state.loadedIds, ["read"]);
    assert.deepEqual(lean.evictedIds, ["specialist"]);
    assert.ok(lean.serialized.length < full.serialized.length);
    const again = api.assembleContext(receipt, "full", lean.state);
    assert.deepEqual(again.addedIds, ["specialist"]);
    const unavailable = api.assembleContext(await run(null), "lean", lean.state);
    assert.deepEqual(unavailable.state.loadedIds, []);
    assert.deepEqual(unavailable.evictedIds, ["read"]);
    assert.throws(() => api.assembleContext(receipt, "invalid" as "lean"));
  });

  test("unsupported schema constraints are rejected instead of silently widened", () => {
    for (const inputSchema of [
      { ...tools[0]!.inputSchema, allOf: [{ required: ["path"] }] },
      { ...tools[0]!.inputSchema, properties: { path: { ...tools[0]!.inputSchema.properties.path!, enum: ["read"] } } },
    ]) assert.throws(() => api.createCatalog([{ ...tools[0]!, inputSchema }]));
  });


  test("sparse catalogs and required-property arrays are rejected", () => {
    assert.throws(() => api.createCatalog(Array<api.ToolDefinition>(1)));
    const sparseRequired = { ...tools[0]!, inputSchema: { ...tools[0]!.inputSchema, required: Array<string>(1) } };
    assert.throws(() => api.createCatalog([sparseRequired]));
  });

  test("sparse availability is rejected before calling the adapter", async () => {
    const availableIds = Array<string>(2);
    availableIds[1] = "read";
    let calls = 0;
    const adapter: api.ToolRouter = { source: "mock", review: async () => { calls++; return evidence; } };
    await assert.rejects(() => api.routeTools(api.createCatalog(tools), { ...input, availableIds }, policy, adapter));
    assert.equal(calls, 0);
  });
}

// ---- tests/routing-bundle.test.ts ----
{
  async function patchReceipt(availableIds: readonly string[] = DEMO_CATALOG.map(t => t.id), maxCostUnits = 10) {
    return routeTools(DEMO_CATALOG, { intent: "Propose a patch to the synthetic helper.", availableIds }, { ...DEMO_POLICY, maxCostUnits }, scenarioRouter(SCENARIOS.find(s => s.id === "patch")!));
  }

  test("host-declared prerequisites retain read access without relabeling Jev's selection", async () => {
    const receipt = await patchReceipt();
    const bundle = assembleToolBundle(receipt, { propose_patch: ["read_file"] });
    assert.equal(bundle.status, "ready");
    assert.deepEqual(receipt.selectedIds, ["propose_patch"]);
    assert.deepEqual(bundle.rootIds, ["propose_patch"]);
    assert.deepEqual(bundle.prerequisiteIds, ["read_file"]);
    assert.deepEqual(bundle.context.state.loadedIds, ["read_file", "propose_patch"]);
    assert.equal(bundle.estimatedCostUnits, 4);
    assert.deepEqual(bundle.blockedIds, []);
    assert.equal(receipt.execution.applied, false);
    assert.ok(Object.isFrozen(bundle.context.tools));
  });

  test("missing or over-budget prerequisites withhold the entire handoff", async () => {
    const unavailable = assembleToolBundle(await patchReceipt(["propose_patch"]), { propose_patch: ["read_file"] });
    assert.equal(unavailable.status, "withheld");
    assert.deepEqual(unavailable.blockedIds, ["read_file"]);
    assert.deepEqual(unavailable.context.state.loadedIds, []);
    const costly = assembleToolBundle(await patchReceipt(undefined, 3), { propose_patch: ["inspect_agent"] });
    assert.deepEqual(costly.blockedIds, ["inspect_agent"]);
    assert.deepEqual(costly.context.state.loadedIds, []);
  });

  test("dependency closure is transitive, deduplicated and cannot invent a descriptor", async () => {
    const receipt = await patchReceipt();
    const result = assembleToolBundle(receipt, { propose_patch: ["inspect_agent", "read_file"], inspect_agent: ["read_file"] });
    assert.deepEqual(result.context.state.loadedIds, DEMO_CATALOG.map(t => t.id));
    assert.equal(result.estimatedCostUnits, 13);
    assert.throws(() => assembleToolBundle(receipt, { propose_patch: ["unknown_tool"] }), /catalog/);
    assert.throws(() => assembleToolBundle(receipt, { propose_patch: ["read_file"], read_file: ["propose_patch"] }), /cycle/);
    assert.throws(() => assembleToolBundle(receipt, { propose_patch: ["read_file", "read_file"] }), /unique/);
  });

  test("failed routing and cancellation never expose dependencies, and state tracks eviction", async () => {
    const receipt = await patchReceipt();
    const prior = { loadedIds: ["inspect_agent"] };
    const controller = new AbortController(); controller.abort();
    const cancelled = assembleToolBundle(receipt, { propose_patch: ["read_file"] }, { previous: prior, signal: controller.signal });
    assert.equal(cancelled.status, "withheld");
    assert.deepEqual(cancelled.context.state.loadedIds, []);
    assert.deepEqual(cancelled.context.evictedIds, ["inspect_agent"]);
    const failed = assembleToolBundle({ ...receipt, outcome: "unavailable", selectedIds: [] }, { propose_patch: ["read_file"] });
    assert.equal(failed.status, "withheld");
    assert.deepEqual(failed.context.state.loadedIds, []);
    const active = assembleToolBundle(receipt, { propose_patch: ["read_file"] }, { previous: prior });
    assert.deepEqual(active.context.addedIds, ["read_file", "propose_patch"]);
    assert.deepEqual(active.context.evictedIds, ["inspect_agent"]);
  });
}

// ---- tests/routing-prepare.test.ts ----
{
  const catalog: api.ToolDefinition[] = [
    { id: "read", kind: "tool", description: "Read a synthetic file", estimatedCostUnits: 1,
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Synthetic path" } }, required: ["path"], additionalProperties: false } },
    { id: "inspect", kind: "subagent", description: "Inspect a synthetic file", estimatedCostUnits: 8,
      inputSchema: { type: "object", properties: { task: { type: "string", description: "Synthetic task" } }, required: ["task"], additionalProperties: false } },
  ];
  const input: api.RoutingInput = { intent: "Read the synthetic example", availableIds: ["read", "inspect"] };
  const policy: api.RoutingPolicy = { topK: 1, confidenceFloor: 0.7, probabilityFloor: 0.2, relevanceWindow: 0.1, maxCostUnits: 10 };
  const evidence: api.RoutingEvidence = { model: "jev-1.13.0", choice: "inspect", confidence: 0.9,
    probabilities: { read: 0.46, inspect: 0.5, needs_clarification: 0.04 } };
  const router = (value: unknown = evidence): api.ToolRouter => ({ source: "mock", review: async () => value });

  test("explicit shadow and lean modes expose the requested context with one review", async () => {
    for (const mode of ["shadow", "lean"] as const) {
      let calls = 0;
      const result = await api.prepareToolContext({ catalog, input, policy, mode,
        router: { source: "mock", review: async request => { calls++; assert.equal(request.intent, input.intent); return evidence; } } });
      assert.equal(calls, 1);
      assert.equal(result.mode, mode);
      assert.equal(result.receipt.outcome, "selected");
      assert.equal(result.receipt.execution.applied, false);
      assert.deepEqual(result.full.state.loadedIds, ["read", "inspect"]);
      assert.deepEqual(result.lean.state.loadedIds, ["read"]);
      assert.equal(result.context, mode === "shadow" ? result.full : result.lean);
      assert.deepEqual(JSON.parse(result.context.serialized).tools.map((tool: { id: string }) => tool.id),
        mode === "shadow" ? ["read", "inspect"] : ["read"]);
    }
  });

  test("non-selected routing outcomes keep shadow explicit and lean empty", async () => {
    const cases: { router: api.ToolRouter; policy?: api.RoutingPolicy; outcome: api.RoutingReceipt["outcome"] }[] = [
      { router: router(null), outcome: "unavailable" },
      { router: { source: "mock", review: async () => { throw Error("synthetic private adapter detail"); } }, outcome: "unavailable" },
      { router: router({ ...evidence, choice: "needs_clarification", probabilities: { read: 0.05, inspect: 0.05, needs_clarification: 0.9 } }), outcome: "needs_clarification" },
      { router: router({ ...evidence, confidence: 0.1 }), outcome: "needs_clarification" },
      { router: router(), policy: { ...policy, maxCostUnits: 0 }, outcome: "no_match" },
    ];
    for (const scenario of cases) for (const mode of ["shadow", "lean"] as const) {
      const result = await api.prepareToolContext({ catalog, input, policy: scenario.policy ?? policy,
        router: scenario.router, mode, previous: { loadedIds: ["read"] } });
      assert.equal(result.receipt.outcome, scenario.outcome);
      assert.deepEqual(result.receipt.selectedIds, []);
      assert.deepEqual(result.full.state.loadedIds, ["read", "inspect"]);
      assert.deepEqual(result.lean.state.loadedIds, []);
      assert.deepEqual(result.lean.evictedIds, ["read"]);
      assert.equal(result.context, mode === "shadow" ? result.full : result.lean);
      assert.equal(JSON.stringify(result).includes("synthetic private adapter detail"), false);
    }
  });

  test("no available descriptors makes no review call and evicts previous context", async () => {
    let calls = 0;
    const result = await api.prepareToolContext({ catalog, input: { ...input, availableIds: [] }, policy, mode: "shadow",
      previous: { loadedIds: ["read", "inspect"] }, router: { source: "mock", review: async () => { calls++; return evidence; } } });
    assert.equal(calls, 0);
    assert.equal(result.receipt.outcome, "no_match");
    assert.deepEqual(result.context.state.loadedIds, []);
    assert.deepEqual(result.context.evictedIds, ["read", "inspect"]);
  });

  test("unknown and omitted modes fail before calling the router", async () => {
    let calls = 0;
    for (const mode of ["full", "invalid", undefined]) {
      await assert.rejects(api.prepareToolContext({ catalog, input, policy, mode: mode as api.ToolContextMode,
        router: { source: "mock", review: async () => { calls++; return evidence; } } }), /mode/i);
    }
    assert.equal(calls, 0);
  });

  test("pre-abort exposes no active context in either mode and preserves the full comparison", async () => {
    for (const mode of ["shadow", "lean"] as const) {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      const result = await api.prepareToolContext({ catalog, input, policy, mode, signal: controller.signal,
        previous: { loadedIds: ["read", "inspect"] }, router: { source: "mock", review: async () => { calls++; return evidence; } } });
      assert.equal(calls, 0);
      assert.equal(result.mode, mode);
      assert.equal(result.receipt.outcome, "unavailable");
      assert.deepEqual(result.full.state.loadedIds, ["read", "inspect"]);
      assert.deepEqual(result.context.state.loadedIds, []);
      assert.deepEqual(result.context.evictedIds, ["read", "inspect"]);
      assert.deepEqual(JSON.parse(result.context.serialized).tools, []);
    }
  });

  test("abort while reviewing clears active context even when the adapter resolves or rejects", async () => {
    for (const mode of ["shadow", "lean"] as const) for (const reject of [false, true]) {
      const controller = new AbortController();
      let finish!: (value: unknown) => void;
      let fail!: (reason: unknown) => void;
      const review = new Promise<unknown>((resolve, rejection) => { finish = resolve; fail = rejection; });
      const pending = api.prepareToolContext({ catalog, input, policy, mode, signal: controller.signal,
        previous: { loadedIds: ["read"] }, router: { source: "mock", review: async (_request, signal) => {
          assert.equal(signal, controller.signal); return review;
        } } });
      controller.abort();
      if (reject) fail(Error("synthetic cancellation")); else finish(evidence);
      const result = await pending;
      assert.equal(result.receipt.outcome, "unavailable");
      assert.deepEqual(result.context.state.loadedIds, []);
      assert.deepEqual(result.context.evictedIds, ["read"]);
      assert.deepEqual(result.full.state.loadedIds, ["read", "inspect"]);
    }
  });

  test("caller mutations while awaiting do not change mode, previous state or routing snapshots", async () => {
    let finish!: (value: unknown) => void;
    const review = new Promise<unknown>(resolve => { finish = resolve; });
    const mutable: api.PrepareToolContextOptions = { catalog: structuredClone(catalog), input: structuredClone(input),
      policy: { ...policy }, router: { source: "mock", review: async () => review }, mode: "lean", previous: { loadedIds: ["inspect"] } };
    const originalPrevious = mutable.previous!;
    const pending = api.prepareToolContext(mutable);
    mutable.mode = "shadow";
    mutable.previous = { loadedIds: [] };
    (originalPrevious.loadedIds as string[]).push("read");
    mutable.catalog[0]!.description = "Changed description";
    mutable.catalog[0]!.inputSchema.properties.path!.description = "Changed schema";
    mutable.input.intent = "Changed task";
    (mutable.input.availableIds as string[]).length = 0;
    mutable.policy.maxCostUnits = 0;
    finish(evidence);
    const result = await pending;
    assert.equal(result.mode, "lean");
    assert.equal(result.context, result.lean);
    assert.equal(result.receipt.request.intent, input.intent);
    assert.equal(result.receipt.policy.maxCostUnits, policy.maxCostUnits);
    assert.equal(result.context.tools[0]!.description, catalog[0]!.description);
    assert.equal(result.context.tools[0]!.inputSchema.properties.path!.description, "Synthetic path");
    assert.deepEqual(result.context.addedIds, ["read"]);
    assert.deepEqual(result.context.evictedIds, ["inspect"]);
    assert.deepEqual(result.full.addedIds, ["read"]);
    assert.deepEqual(result.full.evictedIds, []);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.context.state.loadedIds));
    assert.ok(Object.isFrozen(result.context.tools[0]!.inputSchema.properties));
    assert.throws(() => { result.context.tools[0]!.description = "Changed result"; });
  });

  test("cancellation between routing and context handoff clears an already selected context", async () => {
    for (const mode of ["shadow", "lean"] as const) {
      const controller = new AbortController();
      const pending = api.prepareToolContext({ catalog, input, policy, mode, signal: controller.signal,
        previous: { loadedIds: ["read"] }, router: { source: "mock", review: () => Promise.resolve(evidence) } });
      queueMicrotask(() => controller.abort());
      const result = await pending;
      assert.equal(result.receipt.outcome, "selected");
      assert.deepEqual(result.lean.state.loadedIds, ["read"]);
      assert.deepEqual(result.context.state.loadedIds, []);
      assert.deepEqual(result.context.evictedIds, ["read"]);
    }
  });

  test("switching modes reloads evicted descriptors from the current availability snapshot", async () => {
    const lean = await api.prepareToolContext({ catalog, input, policy, router: router(), mode: "lean" });
    const shadow = await api.prepareToolContext({ catalog, input, policy, router: router(), mode: "shadow", previous: lean.context.state });
    assert.deepEqual(shadow.context.addedIds, ["inspect"]);
    assert.deepEqual(shadow.context.evictedIds, []);
    const reduced = await api.prepareToolContext({ catalog, input: { ...input, availableIds: ["read"] }, policy,
      router: router({ ...evidence, choice: "read", probabilities: { read: 0.9, needs_clarification: 0.1 } }), mode: "shadow", previous: shadow.context.state });
    assert.deepEqual(reduced.context.state.loadedIds, ["read"]);
    assert.deepEqual(reduced.context.evictedIds, ["inspect"]);
  });
}
