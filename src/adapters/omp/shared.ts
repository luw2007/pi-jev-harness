/** The OMP adapter's only import of host-neutral adapter helpers (public entry, T042). */
export {
  containsCredential,
  defaultConfig,
  loadConfig,
  readJevKey,
  type LoadConfigOptions,
  type LoadedConfig,
  type AdapterConfig,
  type ContextRequestMode,
  type OmpContextFileConfig,
} from "../shared/index.ts";
export { createJevToolRouter, truncateIntent } from "../shared/index.ts";
