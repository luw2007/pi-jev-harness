/**
 * OMP Jev budget contract (T105). The single place that states how Jev requests are counted;
 * the code that enforces each rule is named next to it.
 *
 * 1. Per-task counter (`budget.maxRequestsPerTask`, wait `budget.waitMs`), reset at each new
 *    task (`before_agent_start`, not on a host retry of the same prompt). Shared by C1 tool
 *    routing, C2 enforce reviews, C3 approval risk checks and C12 effort: `reserveTask` in
 *    ./host.ts, passed to ./gates.ts as `GateDeps.reserveTask`. Exhausted: routing and effort
 *    record unavailable, enforce blocks (review unavailable), approval asks the human.
 *    Shadow observations (routing unless on + router.tools on, effort unless on, enforce/approval
 *    in a shadow session) never spend this counter: they draw on a separate counter with the
 *    same limit (`shadowUnits`), so observing never starves an on-mode action.
 *    Our own continuation turn (its `before_agent_start`) is the same task: no reset, no second
 *    route or effort (`OmpStop.continuing`).
 * 2. Own window per stop check and per model-callable tool call (C4 `session_stop`, C5
 *    `jev_acceptance_gate` / `foreman_assess` / `jev_route`, C6 `jev_plan`): each call gets a
 *    fresh `maxRequestsPerTask` allowance and `waitMs` wait, so calls never starve one another
 *    or the task counter (`bounded` in ./stop.ts, `runJevPlan` in ./plan.ts).
 * 3. C8 compaction (`session_before_compact`, proactive compaction) has its own budget:
 *    `budget.compactRequests` per compaction and `budget.compactWaitMs` (./compaction.ts); it
 *    neither spends nor needs the task counter. C7 request reduction keeps its own per-task
 *    counter (same `maxRequestsPerTask`, separate from rule 1) in the shared Pi context hook.
 * 4. A provider-chain call (T105 C9, ../shared/jev-access.ts) is one unit wherever it is
 *    counted, however many providers it falls back through; the chain's total wait is the
 *    caller's wait budget. The session counter in `/jev status` ("Jev requests this session")
 *    still counts physical HTTP requests.
 */
export {};
