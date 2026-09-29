/**
 * Commands that count as verification evidence: test runners, type checkers and linters. The
 * match only classifies evidence; it grants nothing (a command named "test" is still a command).
 * Host-neutral: shared by the Pi harness and the OMP stop checkpoint.
 */
export const CHECK_COMMAND =
  /(?:^|[\s;&|(])(?:node\s+(?:\S+\s+)*--test\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check)\b|(?:npx\s+|pnpm\s+exec\s+)?(?:tsc|vitest|jest|eslint|pytest|mocha)\b|go\s+(?:test|vet)\b|cargo\s+(?:test|check|clippy)\b|make\s+(?:test|check)\b|deno\s+test\b)/;
