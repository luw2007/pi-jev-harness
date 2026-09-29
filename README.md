# pi-jev-harness

[![CI](https://github.com/luw2007/pi-jev-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/luw2007/pi-jev-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Jev-powered harness for the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and omp coding agents. It asks a Jev decision service (by default [TypeSafe](https://docs.typesafe.ai)) for tool routing, action checks, completion acceptance, bounded continuation and recoverable context trimming, and records every decision in local, replayable run artifacts.

It never switches models. Model routing is left to magpie (or your host's own model selection).

## Install

Requires Node.js >= 22.19 and pnpm.

```sh
git clone https://github.com/luw2007/pi-jev-harness.git
cd pi-jev-harness
pnpm install
```

**Pi** — load the extension for one session:

```sh
pi --extension /path/to/pi-jev-harness/src/adapters/pi/index.ts
```

**omp** — link this directory as a plugin (the package declares its omp entry `src/adapters/omp/index.ts` in `package.json`):

```sh
omp plugin link /path/to/pi-jev-harness
```

## Configuration

- Pi: `~/.pi/agent/pi-jev-harness/config.json`. omp: `~/.omp/agent/pi-jev-harness/config.json`.
- Missing file means defaults; a corrupt file or unknown key forces `off` (the file is never rewritten).
- **Modes**: `off` (default, native host behaviour, zero Jev requests), `shadow` (record Jev advice, change nothing), `on` (apply enabled capabilities; only via `/jev mode on` in a session on Pi).
- **Key**: `TYPESAFE_API_KEY` env var. `PI_JEV_URL` overrides the endpoint; `PI_JEV_RUNS_DIR` / `PI_JEV_RUN_ID` control run output.
- **Common keys**: `outbound.taskIntent` (default `false`: nothing is sent), `router.tools`, `budget.maxRequestsPerTask`, `budget.waitMs`, `harness.enforce`, `harness.continuation`, `context.request`.
- **Provider chain** (optional): `jev.providers` is an ordered list tried with fallback on transport errors, timeouts, 5xx/429 or model-identity mismatch; `jev.capabilities` can override the chain per capability. Keys come from `keyEnv` or `keyFile`, never inline.

```json
{
  "mode": "shadow",
  "outbound": { "taskIntent": true },
  "jev": {
    "providers": [
      { "id": "typesafe", "url": "https://api.typesafe.ai/v1/systemone", "model": "jev-1.13.0", "timeoutMs": 15000, "keyEnv": "TYPESAFE_API_KEY" },
      { "id": "provider-a", "url": "https://jev.example.invalid/v1", "model": "jev-internal", "identity": "none", "timeoutMs": 3000 }
    ]
  }
}
```

The full key reference (Chinese) is in [docs/pi-jev-harness-product.md](docs/pi-jev-harness-product.md) §15.4.

## Safety model

- **Outbound gate**: no task text leaves the machine unless `outbound.taskIntent` is `true` and the mode allows it.
- **Credential scan**: outbound payloads are scanned for every configured key before sending; a hit blocks the request.
- **Budgets**: per-task request count and total wait time are bounded; a provider chain call counts as one request.
- **Never switches models**: the harness only shapes tools, checks, continuation and context.
- Continuation is bounded (max 2), and Jev being unavailable always falls back to native behaviour.

## Commands

In-session: `/jev status`, `/jev mode off|shadow|on`.

CLI (`node src/cli.ts`): `run`, `doctor`, `report`, `replay`, `--version`. See [docs/pi-jev-harness-product.md](docs/pi-jev-harness-product.md) §15.3.

## Development

```sh
pnpm typecheck
pnpm test
pnpm bench:offline
```

`pnpm test:host` runs real Pi host tests and makes real model requests; it is not part of CI.

## License

[MIT](LICENSE). Vendored third-party code keeps its own license; see `third_party/`.
