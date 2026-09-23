/**
 * The core's portable entry (ADR 0133 §6): what an isolate loads after the
 * runtime contract is installed. Loading it installs no host and touches no
 * platform global; the embedder calls `configureHost(createSandboxHost())`
 * before using anything that reads a port.
 */
export { configureHost } from "../host.js";
export { createSandboxHost } from "./host.js";
export {
  VaultCorruptError,
  WrongPasswordError,
} from "@opensesame/vault-core";
export {
  createItem,
  hostOf,
  searchMatches,
  sortItems,
} from "@opensesame/vault-core";
export { testWebsitePattern } from "../lib/vault/website-pattern.js";
export {
  openVaultFile,
  readVaultFile,
} from "@opensesame/vault-core";
export { buildRows } from "@opensesame/vault-core";
