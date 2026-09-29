// Adapted from jerryfane/omp-jev-compaction@e21ab3273542a07984c4f2cfc4b3e746dc95930c:tests/oversized-history.test.ts (MIT)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compact } from "../../../vendor/fast-jev/compact.ts";
import { collectToolCalls, fitState } from "../../../vendor/fast-jev/state.ts";
import type { JevAsker, JevQuestions, JevState, Message } from "../../../vendor/fast-jev/types.ts";

const LIMIT = 25_000;

function asker(noul: number): JevAsker & { calls: number; asked: string[] } {
  return {
    calls: 0,
    asked: [],
    async ask(_state: JevState, questions: JevQuestions) {
      this.calls += 1;
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const name of Object.keys(questions)) {
        this.asked.push(name);
        answers[name] = { type: "noul", noul };
      }
      return { answers };
    },
  };
}

/**
 * A history whose Jev state cannot fit at 25k tokens: every stage of shrinking
 * still leaves one line per call, so enough calls overflow the budget. 400
 * turns reproduce the live failure shape ("~32889 tokens after truncation").
 */
function oversized(turns: number): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", text: `step ${turn}: ${"reason ".repeat(20)}`, toolUses: [] });
    messages.push({
      role: "assistant",
      text: `calling read for step ${turn}`,
      toolUses: [
        {
          tool_use_id: `u-${turn}`,
          tool: "read",
          input: { path: `/repo/module-${turn}/${"segment/".repeat(40)}file.ts` },
        },
      ],
    });
    messages.push({
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: `u-${turn}`, text: `contents ${turn}: ${"payload ".repeat(100)}` }],
    });
  }
  return messages;
}

describe("state fitting under an oversized history", () => {
  it("leaves old entries out instead of failing the request", () => {
    const messages = oversized(400);
    const calls = collectToolCalls(messages, 6);
    const fitted = fitState(messages, calls, {
      maxStateTokens: LIMIT,
      preserveRecentMessages: 6,
      goal: "finish the refactor",
    });
    assert.ok(fitted.tokens <= LIMIT, `tokens ${fitted.tokens} > ${LIMIT}`);
    assert.equal(fitted.stage, "old entries left out");
    assert.ok(fitted.representedCalls.size > 0);
    assert.ok(fitted.representedCalls.size < calls.length);
  });

  it("keeps the newest calls in the state and leaves the oldest out", () => {
    const messages = oversized(400);
    const calls = collectToolCalls(messages, 6);
    const fitted = fitState(messages, calls, {
      maxStateTokens: LIMIT,
      preserveRecentMessages: 6,
      goal: "",
    });
    assert.equal(fitted.representedCalls.has(calls.at(-1)!.id), true);
    assert.equal(fitted.representedCalls.has(calls[0]!.id), false);
  });
});

describe("compaction of a history Jev cannot hold at once", () => {
  it("asks only about calls the state still shows and counts the rest unscored", async () => {
    const jev = asker(0.05);
    const result = await compact(oversized(400), jev, { keepThreshold: 0.2, goal: "refactor" });
    assert.ok(result.stats.unscored > 0);
    assert.equal(result.stats.calls, 400);
    // Two questions per call: `call_<id>` and `result_<id>`.
    const asked = new Set(jev.asked.map((name) => name.replace(/^(call|result)_/, "")));
    assert.equal(asked.size, result.stats.calls - result.stats.unscored - result.stats.pinned);
    // An unscored call keeps its output: nothing is dropped on a blind guess.
    const dropped = result.decisions.filter((decision) => decision.action !== "keep");
    assert.ok(dropped.length > 0);
    for (const decision of dropped) assert.equal(asked.has(decision.id), true);
  });
});
