import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareToolExposure,
  routeToolsForTask,
  snapshotToolCatalog,
  type HostTool,
  type RouteToolsForTaskOptions,
  type ToolRouteResult,
  type ToolRouter,
} from "../../../src/router/index.ts";

const pathSchema = { type: "object", properties: { path: { type: "string", description: "Relative path" } }, required: ["path"], additionalProperties: false };
const hostTools: HostTool[] = [
  { name: "read", description: "Read a file", schema: pathSchema, source: "builtin", available: true },
  { name: "grep", description: "Search file contents", schema: { type: "object", properties: { pattern: { type: "string", description: "Regex" } }, required: ["pattern"], additionalProperties: false }, source: "builtin", available: true },
  { name: "edit", description: "Edit a file", source: "builtin", available: true,
    // Arrays are outside H's closed schema subset: routed as "opaque", exposed verbatim.
    schema: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "string" } } }, required: ["path", "edits"] } },
  { name: "write", description: "Write a file", schema: pathSchema, source: "builtin", available: true },
  { name: "browser", description: "Drive a browser", schema: pathSchema, source: "ext:web", available: false },
];
const policy = { topK: 1, confidenceFloor: 0.5, probabilityFloor: 0.1, relevanceWindow: 0.05, maxCostUnits: 10 };

/** Scripted closed-set evidence: `winner` gets 0.9, the rest share 0.1 over the request's own options. */
function scripted(winner: string, overrides: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const router: ToolRouter = { source: "mock", review: async request => {
    const ids = request.options.map(option => option.id);
    calls.push(ids);
    const rest = 0.1 / (ids.length - 1);
    const probabilities = Object.fromEntries(ids.map(id => [id, id === winner ? 0.9 : rest]));
    return { model: request.model, choice: winner, confidence: 0.9, probabilities, ...overrides };
  } };
  return { router, calls };
}

function options(overrides: Partial<RouteToolsForTaskOptions> = {}): RouteToolsForTaskOptions {
  return { catalog: snapshotToolCatalog(hostTools), intent: "Fix the bug in src/a.ts", candidateRootIds: ["read", "grep", "edit", "write"],
    policy, router: scripted("edit").router, dependencies: { edit: ["read"] }, maxBundleTools: 4, maxBundleSchemaBytes: 10_000, ...overrides };
}

test("snapshot contains only registered tools under their own names, with source and availability", () => {
  const snapshot = snapshotToolCatalog([...hostTools,
    { name: "Bad-Name", description: "x", schema: pathSchema, source: "ext", available: true },
    { name: "read", description: "Duplicate", schema: pathSchema, source: "ext", available: true },
    { name: "needs_clarification", description: "x", schema: pathSchema, source: "ext", available: true }]);
  assert.deepEqual(snapshot.catalog.map(tool => tool.id), ["read", "grep", "edit", "write", "browser"]);
  assert.deepEqual(snapshot.availableIds, ["read", "grep", "edit", "write"]);
  assert.deepEqual(snapshot.rejected, [{ name: "Bad-Name", reason: "invalid_id" }, { name: "read", reason: "duplicate" }, { name: "needs_clarification", reason: "invalid_id" }]);
  const edit = snapshot.entries.find(entry => entry.id === "edit")!;
  assert.equal(edit.routingSchema, "opaque");
  assert.deepEqual(edit.schema, hostTools[2]!.schema);
  assert.equal(edit.schemaBytes, Buffer.byteLength(JSON.stringify(hostTools[2]!.schema)));
  assert.equal(snapshot.entries.find(entry => entry.id === "browser")!.source, "ext:web");
});

test("unknown or unavailable candidate ids never reach the router's closed set", async () => {
  const { router, calls } = scripted("edit");
  const result = await routeToolsForTask(options({ router, candidateRootIds: ["read", "edit", "ghost", "browser"] }));
  assert.deepEqual(calls, [["read", "edit", "needs_clarification"]]);
  assert.deepEqual(result.droppedIds, ["ghost", "browser"]);
  assert.equal(result.status, "selected");
});

test("choice outside the closed set is unavailable and exposes nothing", async () => {
  const result = await routeToolsForTask(options({ router: scripted("edit", { choice: "delete_everything" }).router }));
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.toolIds, []);
  assert.equal(result.receipt.evidence, null);
});

test("single available tool routes through the closed set and is selected", async () => {
  const { router, calls } = scripted("grep");
  const result = await routeToolsForTask(options({ router, candidateRootIds: ["grep"], dependencies: {} }));
  assert.deepEqual(calls, [["grep", "needs_clarification"]]);
  assert.equal(result.status, "selected");
  assert.deepEqual(result.toolIds, ["grep"]);
});

test("dependency closure is completed after routing; receipt keeps the original roots", async () => {
  const result = await routeToolsForTask(options({ dependencies: { edit: ["grep"], grep: ["read"] } }));
  assert.equal(result.status, "selected");
  assert.deepEqual(result.toolIds, ["read", "grep", "edit"]);
  if (result.status !== "selected") return;
  assert.deepEqual(result.rootIds, ["edit"]);
  assert.deepEqual(result.prerequisiteIds, ["read", "grep"]);
  assert.deepEqual(result.receipt.selectedIds, ["edit"]);
  const bytes = result.toolIds.reduce((sum, id) => sum + Buffer.byteLength(JSON.stringify(hostTools.find(tool => tool.name === id)!.schema)), 0);
  assert.equal(result.schemaBytes, bytes);
});

test("dependency cycle terminates and withholds the whole bundle", async () => {
  const result = await routeToolsForTask(options({ dependencies: { edit: ["read"], read: ["edit"] } }));
  assert.equal(result.status, "withheld");
  assert.deepEqual(result.toolIds, []);
  if (result.status === "withheld") assert.equal(result.gaps[0]!.reason, "dependency_cycle");
});

test("unavailable or unregistered prerequisite withholds the whole bundle", async () => {
  const unavailable = await routeToolsForTask(options({ dependencies: { edit: ["read", "browser"] } }));
  assert.equal(unavailable.status, "withheld");
  assert.deepEqual(unavailable.toolIds, []);
  if (unavailable.status === "withheld") assert.deepEqual(unavailable.gaps, [{ reason: "dependency_unavailable", ids: ["browser"] }]);
  // Registered but disabled in the host stays unavailable even when it is not a root candidate.
  const disabled = await routeToolsForTask(options({ candidateRootIds: ["edit"], dependencies: { edit: ["browser"] } }));
  assert.equal(disabled.status, "withheld");
  if (disabled.status === "withheld") assert.deepEqual(disabled.gaps, [{ reason: "dependency_unavailable", ids: ["browser"] }]);
  const unregistered = await routeToolsForTask(options({ dependencies: { edit: ["ghost"] } }));
  assert.equal(unregistered.status, "withheld");
  if (unregistered.status === "withheld") assert.equal(unregistered.gaps[0]!.reason, "dependency_unregistered");
});

test("host-available prerequisite outside the root candidates completes the bundle", async () => {
  const { router, calls } = scripted("edit");
  const result = await routeToolsForTask(options({ router, candidateRootIds: ["edit"], dependencies: { edit: ["read"] } }));
  assert.deepEqual(calls, [["edit", "needs_clarification"]], "Jev only sees the root candidates");
  assert.equal(result.status, "selected");
  assert.deepEqual(result.toolIds, ["read", "edit"]);
  if (result.status !== "selected") return;
  assert.deepEqual(result.rootIds, ["edit"]);
  assert.deepEqual(result.prerequisiteIds, ["read"]);
  assert.deepEqual(result.receipt.selectedIds, ["edit"]);
  assert.deepEqual(result.receipt.request.options.map(option => option.id), ["edit", "needs_clarification"], "original receipt is not rewritten");
});

test("bundle over maxBundleTools or schema bytes is withheld, not truncated", async () => {
  const deps = { edit: ["read", "grep"] };
  const exact = await routeToolsForTask(options({ dependencies: deps, maxBundleTools: 3 }));
  assert.equal(exact.status, "selected");
  const tooMany = await routeToolsForTask(options({ dependencies: deps, maxBundleTools: 2 }));
  assert.equal(tooMany.status, "withheld");
  assert.deepEqual(tooMany.toolIds, []);
  if (tooMany.status === "withheld") assert.deepEqual(tooMany.gaps, [{ reason: "too_many_tools", actual: 3, limit: 2 }]);
  const bytes = exact.status === "selected" ? exact.schemaBytes : 0;
  assert.equal((await routeToolsForTask(options({ dependencies: deps, maxBundleSchemaBytes: bytes }))).status, "selected");
  const tooLarge = await routeToolsForTask(options({ dependencies: deps, maxBundleSchemaBytes: bytes - 1 }));
  assert.equal(tooLarge.status, "withheld");
  if (tooLarge.status === "withheld") assert.deepEqual(tooLarge.gaps, [{ reason: "schema_too_large", actual: bytes, limit: bytes - 1 }]);
});

test("clarification and no_match stay distinct from selected", async () => {
  assert.equal((await routeToolsForTask(options({ router: scripted("needs_clarification").router }))).status, "needs_clarification");
  assert.equal((await routeToolsForTask(options({ policy: { ...policy, maxCostUnits: 0 } }))).status, "no_match");
});

test("pre-cancelled routing is unavailable and never calls the router", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await routeToolsForTask(options({ signal: controller.signal, router: { source: "mock", review: async () => { calls++; return null; } } }));
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.toolIds, []);
  assert.equal(calls, 0);
});

test("off and shadow keep the baseline; shadow only attaches a suggestion", async () => {
  const result = await routeToolsForTask(options());
  const baselineIds = ["read", "grep", "edit", "write"];
  const off = prepareToolExposure({ mode: "off", baselineIds, result, residentIds: ["read", "grep"] });
  assert.deepEqual(off.activeIds, baselineIds);
  assert.equal(off.suggestion, undefined);
  const shadow = prepareToolExposure({ mode: "shadow", baselineIds, result, residentIds: ["read", "grep"] });
  assert.deepEqual(shadow.activeIds, baselineIds);
  assert.deepEqual(shadow.suggestion, { status: "selected", toolIds: ["read", "edit", "grep"], addedIds: [], removedIds: ["write"] });
});

test("on exposes the selected bundle plus registered resident tools", async () => {
  const result = await routeToolsForTask(options());
  const on = prepareToolExposure({ mode: "on", baselineIds: ["read", "write"], result, residentIds: ["grep", "ghost", "browser"] });
  assert.deepEqual(on.activeIds, ["read", "edit", "grep"]);
  assert.deepEqual(on.droppedResidentIds, ["ghost", "browser"]);
  assert.equal(on.fallback, false);
});

test("on keeps the baseline when routing did not select a complete bundle", async () => {
  const results: ToolRouteResult[] = [
    await routeToolsForTask(options({ dependencies: { edit: ["browser"] } })),
    await routeToolsForTask(options({ router: scripted("edit", { choice: "ghost" }).router })),
  ];
  for (const result of results) {
    const on = prepareToolExposure({ mode: "on", baselineIds: ["read", "write"], result, residentIds: ["grep"] });
    assert.deepEqual(on.activeIds, ["read", "write"]);
    assert.equal(on.fallback, true);
  }
  assert.throws(() => prepareToolExposure({ mode: "lean" as "on", baselineIds: [], result: results[0]! }), /mode/);
});
