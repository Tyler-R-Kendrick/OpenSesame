/**
 * Persistence keys for capability composition (ownership.md §4.5). Every
 * value under these keys is bounded, non-secret plaintext beside the vault:
 * a selection, a receipt, a policy, a counter. Nothing here is ever a
 * credential, and nothing here widens authority on its own — the resolver
 * decides what a document means.
 */

/** `InstallationCapabilitySelection` — what this browser installation chose. */
export const SELECTION_KEY = "capabilities.selection.v1";
/** `ConsentReceipt` — what a person actually accepted, digest-bound. */
export const RECEIPT_KEY = "capabilities.receipt.v1";
/** Personal-local `InstanceCapabilityPolicy` authored on this device (S04). */
export const LOCAL_POLICY_KEY = "capabilities.policy.local.v1";
/** Highest accepted managed policy `{ instanceId, revision, digest, provenance, acceptedAt }` (S03). */
export const ACCEPTED_POLICY_KEY = "capabilities.policy.accepted.v1";
/** `{ generation, committedAt }` — the durable admission counter. */
export const GENERATION_KEY = "capabilities.generation.v1";
/** Random opaque id minted once per browser installation. */
export const INSTALLATION_KEY = "installation.v1";

/** Per-vault `VaultCapabilitySelection` (disables only; never widens). */
export function vaultSelectionKey(vaultId: string): string {
  return `tomb/${vaultId}/capabilities.v1`;
}

/** Every plaintext key the core boot hydrates before resolving. */
export const CAPABILITY_BOOT_KEYS: readonly string[] = [
  INSTALLATION_KEY,
  SELECTION_KEY,
  RECEIPT_KEY,
  LOCAL_POLICY_KEY,
  ACCEPTED_POLICY_KEY,
  GENERATION_KEY,
];

/** Web Locks name serializing commits and admissions for one instance. */
export function compositionLockName(instanceId: string): string {
  return `opensesame:capabilities:${instanceId}`;
}

/** BroadcastChannel carrying the cross-tab "re-read durable state" hint. */
export const CAPABILITIES_CHANNEL = "opensesame:capabilities";

/** Largest durable record `kvRefresh` will read back for these keys. */
export const MAX_RECORD_BYTES = 64 * 1024;
