/**
 * Capability composition as configuration resources (S04).
 *
 * Four projected documents, each an opaque resource key (never a storage
 * path, never a credential) with a display path the editor navigates by.
 * `effective-plan.yaml` is read-only: it is what the resolver decided, and
 * nothing a person types can change it directly.
 */

/** Opaque resource identities. */
export const INSTANCE_POLICY_RESOURCE_KEY =
  "client_local:capabilities:instance-policy";
export const INSTALLATION_SELECTION_RESOURCE_KEY =
  "client_local:capabilities:installation-selection";
export const VAULT_RESTRICTION_RESOURCE_KEY =
  "client_local:capabilities:vault-restriction";
export const EFFECTIVE_PLAN_RESOURCE_KEY =
  "client_local:capabilities:effective-plan";

export const CAPABILITY_RESOURCE_KEYS: readonly string[] = [
  INSTANCE_POLICY_RESOURCE_KEY,
  INSTALLATION_SELECTION_RESOURCE_KEY,
  VAULT_RESTRICTION_RESOURCE_KEY,
  EFFECTIVE_PLAN_RESOURCE_KEY,
];

export function isCapabilityResourceKey(key: string): boolean {
  return CAPABILITY_RESOURCE_KEYS.includes(key);
}

/** Display paths — aliases, never authority (`aliases.ts`). */
export const INSTANCE_POLICY_DISPLAY_PATH = "capabilities/instance-policy.yaml";
export const INSTALLATION_SELECTION_DISPLAY_PATH =
  "capabilities/installation-selection.yaml";
export const VAULT_RESTRICTION_DISPLAY_PATH =
  "capabilities/vault-restriction.yaml";
export const EFFECTIVE_PLAN_DISPLAY_PATH = "capabilities/effective-plan.yaml";

export const CAPABILITY_PATH_ALIASES: ReadonlyArray<
  readonly [alias: string, resourceKey: string]
> = [
  [INSTANCE_POLICY_DISPLAY_PATH, INSTANCE_POLICY_RESOURCE_KEY],
  ["capabilities/instance-policy.yml", INSTANCE_POLICY_RESOURCE_KEY],
  [INSTALLATION_SELECTION_DISPLAY_PATH, INSTALLATION_SELECTION_RESOURCE_KEY],
  ["capabilities/installation-selection.yml", INSTALLATION_SELECTION_RESOURCE_KEY],
  [VAULT_RESTRICTION_DISPLAY_PATH, VAULT_RESTRICTION_RESOURCE_KEY],
  ["capabilities/vault-restriction.yml", VAULT_RESTRICTION_RESOURCE_KEY],
  [EFFECTIVE_PLAN_DISPLAY_PATH, EFFECTIVE_PLAN_RESOURCE_KEY],
  ["capabilities/effective-plan.yml", EFFECTIVE_PLAN_RESOURCE_KEY],
];

/** Schema identities carried by every projected document. */
export const INSTANCE_POLICY_SCHEMA_ID = "opensesame.instance-capability-policy";
export const INSTALLATION_SELECTION_SCHEMA_ID =
  "opensesame.installation-capability-selection";
export const VAULT_RESTRICTION_SCHEMA_ID =
  "opensesame.vault-capability-selection";
export const EFFECTIVE_PLAN_SCHEMA_ID = "opensesame.effective-capability-plan";
export const CAPABILITY_SCHEMA_VERSION = 1;

/**
 * Persistence keys (plaintext boundary, bounded, non-secret — ownership §4.5).
 * The personal-local policy is the only one an editor may write; a same-origin
 * or signed policy is read-only here.
 */
export const LOCAL_POLICY_KV_KEY = "capabilities.policy.local.v1";
/** Authored YAML beside the semantic document; comments live here. */
export const LOCAL_POLICY_SOURCE_KV_KEY = "capabilities.policy.local.source.v1";
export const SELECTION_SOURCE_KV_KEY = "capabilities.selection.source.v1";

export function vaultRestrictionKey(tomb: string): string {
  return `tomb/${tomb}/capabilities.v1`;
}
export function vaultRestrictionSourceKey(tomb: string): string {
  return `tomb/${tomb}/capabilities.source.v1`;
}

/** Bounds tighter than the general document bound: these are short lists. */
export const MAX_CAPABILITY_DOCUMENT_BYTES = 64 * 1024;
export const MAX_CAPABILITY_DOCUMENT_DEPTH = 8;

/** File name of the downloaded instance configuration. */
export const INSTANCE_EXPORT_FILE_NAME = "opensesame-instance-configuration.yaml";
