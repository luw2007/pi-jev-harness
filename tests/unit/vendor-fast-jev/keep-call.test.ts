// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:tests/keep-call.test.ts (MIT)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideCall } from "../../../vendor/fast-jev/compact.ts";

describe("never erasing the call record", () => {
  it("degrades a would-be call drop to an output drop by default", () => {
    const decision = decideCall({ id: "t1", tool: "bash", pinned: false }, { keepCall: 0.01, keepResult: 0.01 }, {
      keepThreshold: 0.9,
    });
    assert.equal(decision.action, "drop_result");
    assert.equal(decision.reason, "result_dropped");
  });

  it("still allows dropping the call when explicitly opted in", () => {
    const decision = decideCall(
      { id: "t1", tool: "bash", pinned: false },
      { keepCall: 0.01, keepResult: 0.01 },
      { keepThreshold: 0.9, allowDroppingCalls: true },
    );
    assert.equal(decision.action, "drop_call");
  });
});
