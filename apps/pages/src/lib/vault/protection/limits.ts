/** Bounded defaults for root-protection manifests (C04). */

export const MAX_RECORDS = 64;
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Aliases kept for call-site clarity. */
export const MAX_PROTECTION_RECORDS = MAX_RECORDS;
export const MAX_RECORD_ENCODED_BYTES = MAX_RECORD_BYTES;
export const MAX_MANIFEST_ENCODED_BYTES = MAX_MANIFEST_BYTES;

export const ROOT_KEY_BYTES = 32;
export const WRAPPING_SECRET_BYTES = 32;
export const MANIFEST_SCHEMA_VERSION = 1 as const;

export const DOMAIN_MANIFEST = "opensesame/vault/root-manifest/v1";
export const DOMAIN_CAPSULE = "opensesame/vault/root-capsule/v1";
export const DOMAIN_MANIFEST_MAC = "opensesame/vault/root-manifest-mac/v1";
export const DOMAIN_CLOUD_WRAP = "opensesame/vault/cloud-wrapping-secret/v1";
/** Legacy PRF derivation — never change for existing records. */
export const LEGACY_WEBAUTHN_PRF_DOMAIN = "opensesame/vault/webauthn-prf/v1";
