/**
 * Host-neutral adapter entry for non-Pi host adapters (e.g. OMP, technical §10).
 * Nothing under src/adapters/shared may import a host package at runtime; see
 * tests/unit/adapters/shared/shared.test.ts.
 */
export { containsCredential, defaultConfig, loadConfig, MODEL_ROUTING_IGNORED_NOTE, readJevKey } from "./config.ts";
export type { AdapterConfig, ContextRequestMode, LoadConfigOptions, LoadedConfig, OmpContextFileConfig } from "./config.ts";
export { createJevToolRouter, truncateIntent } from "./tools.ts";
export type { FailureSink, RequestGate } from "./tools.ts";
