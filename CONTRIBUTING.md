# Contributing

1. Open an issue first for non-trivial changes.
2. Keep changes small and behaviour-preserving unless the change is the point.
3. Before sending a PR, run `pnpm typecheck`, `pnpm test` and `pnpm bench:offline`.
4. Bug fixes come with a test that fails before the fix.
5. Never commit real API keys; tests use obviously fake keys (see `.gitleaks.toml`).

By contributing you agree your work is released under the MIT license.
