/** Opaque prefs resource identity. Not a storage path and not a credential. */
export const PREFS_RESOURCE_KEY = "client_local:vault:prefs";

export const PREFS_SCHEMA_ID = "opensesame.vault-prefs";
export const PREFS_SCHEMA_VERSION = 1;

/** Existing sealed JSON document (semantic). */
export const PREFS_SEMANTIC_PATH = "config/prefs";

/** Authored YAML sidecar; comments live here, never in the JSON body. */
export const PREFS_SOURCE_PATH = "config/prefs.source.yaml";

export const PREFS_SYSTEM_FIELDS = ["prefsRevision"] as const;
