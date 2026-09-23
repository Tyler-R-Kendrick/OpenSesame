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
} from "../lib/vault/crypto.js";
export {
  createItem,
  hostOf,
  searchMatches,
  sortItems,
} from "../lib/vault/model.js";
export { testWebsitePattern } from "../lib/vault/website-pattern.js";
export {
  openVaultFile,
  readVaultFile,
} from "../lib/vault/vault-file.js";
export { buildRows } from "../sections/vault/vault-tree-rows.js";
