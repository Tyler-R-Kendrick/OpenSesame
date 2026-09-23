/**
 * Engineering bounds applied before expensive work (B15). These are
 * OpenSesame budgets for the browser engine, not SOPS format limits.
 */

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TREE_DEPTH = 64;
export const MAX_TREE_NODES = 100_000;
export const MAX_DOCUMENTS = 32;
export const MAX_KEY_GROUPS = 32;
export const MAX_RECIPIENT_ENTRIES = 128;
export const MAX_SCALAR_BYTES = 1024 * 1024;
export const MAX_ENCRYPTED_FIELD_BYTES = 8 * 1024 * 1024;
export const MAX_METADATA_BYTES = 1024 * 1024;
/** Upstream writes 32-byte nonces; imports are accepted up to this bound. */
export const MAX_NONCE_BYTES = 64;
export const MIN_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const DATA_KEY_BYTES = 32;
export const SHARE_BYTES = 33;
export const MAX_AGE_PAYLOAD_BYTES = 4096;
export const MAX_REGEX_PATTERN = 256;
export const MAX_REGEX_INPUT = 8192;
export const MAX_KEY_LENGTH = 4096;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_CONFIG_RULES = 256;
