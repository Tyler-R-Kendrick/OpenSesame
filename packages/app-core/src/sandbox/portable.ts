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

export { unlockWithRetiredCredentialGate } from "../lib/retired-credentials/unlock.js";
export {
  enrollRetiredCredential,
  removeRetiredCredential,
  clearRetiredCredentialEvents,
  probeRetiredCredential,
  retiredCredentialStatus,
  refreshRetiredCredentialStatus,
  flushRetiredCredentialTelemetry,
  retiredCredentialOwnerSeams,
} from "../lib/retired-credentials/index.js";
export { verifyCurrentCredential } from "../lib/retired-credentials/owner-auth.js";
export {
  kvHydrate,
  kvRefresh,
  kvSetDurable,
  kvGet,
  kvDurability,
} from "../lib/kv.js";
export { migrateLegacyHeaderToManifest } from "../lib/vault/protection/migrate-legacy.js";
export { sealAuthenticatedManifest } from "../lib/vault/protection/manifest-auth.js";
export { createVault, bytesToB64 } from "@opensesame/vault-core";
