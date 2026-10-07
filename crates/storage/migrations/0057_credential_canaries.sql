-- Detection-only metadata is independent of production credentials and duress policy.
CREATE TABLE host_canary_registries (
 organization_id TEXT NOT NULL,
 tomb TEXT NOT NULL,
 vault_identity TEXT NOT NULL,
 next_generation INTEGER NOT NULL DEFAULT 1 CHECK(next_generation>=1 AND next_generation<=4294967296),
 registry_json TEXT NOT NULL CHECK(length(registry_json)<=32768),
 PRIMARY KEY(organization_id,tomb)
);
CREATE TABLE host_controlled_aliases (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 tomb TEXT NOT NULL,
 vault_identity TEXT NOT NULL,
 target_connection_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>=1 AND generation<=4294967295),
 digest_b64 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 retired_at TEXT,
 FOREIGN KEY(organization_id,tomb) REFERENCES host_canary_registries(organization_id,tomb),
 UNIQUE(organization_id,tomb,generation)
);
CREATE INDEX host_controlled_aliases_context ON host_controlled_aliases(organization_id,tomb);
