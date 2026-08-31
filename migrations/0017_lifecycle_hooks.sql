-- Expiry lifecycle hooks (ADR 0074).
--
-- Conventions mirror 0016_certificate_manager.sql: TEXT primary keys, RFC3339
-- TEXT timestamps, composite UNIQUE(organization_id, id) so child rows can key
-- on the tenant pair, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
-- on mutable rows, and an all-or-nothing CHECK group on every sealed-blob
-- column set. Sealed columns hold ciphertext only.
--
-- One convention is deliberately NOT followed: organization_id carries no
-- foreign key into organizations(id). The lifecycle scanner runs against
-- whatever organization the gateway is configured with, and
-- `connection_organization` falls back to the nil UUID when no demo bootstrap
-- exists -- an id with no organizations row. rotation_policies
-- (crates/connection-broker/src/store.rs), whose scheduling these tables
-- absorbed, has no such key for the same reason. Adding one here would make
-- the scanner refuse to record watermarks in exactly the deployments where
-- rotation works today: a regression dressed up as referential integrity.
-- Tenant deletion therefore has to sweep these tables explicitly rather than
-- relying on ON DELETE CASCADE.
--
-- Three tables, three distinct jobs:
--   lifecycle_hooks       — who subscribes, to what, and where it is delivered.
--   lifecycle_watermarks  — how far up each ladder a subject has been reported,
--                           so a rung fires exactly once.
--   lifecycle_deliveries  — the outbound delivery ledger (ADR 0039 saga shape:
--                           claim/lease, attempts, backoff, dead-letter).
--
-- Deliveries deliberately do NOT ride outbox_events: that outbox is drained by
-- the backup actor, which treats every unpublished row as a reason to snapshot.
-- A separate ledger keeps hook fan-out from provoking backups while reusing the
-- same saga shape.

-- —— subscriptions ————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS lifecycle_hooks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- JSON array of frozen lifecycle event types, or the "lifecycle.*" wildcard.
  -- Validated in crates/storage against opensesame-lifecycle's frozen set: an
  -- empty filter is refused rather than defaulted to everything.
  event_types_json TEXT NOT NULL,
  -- 'webhook' delivers a Standard Webhooks POST; 'internal' names a
  -- platform-owned responder that runs in-process. Community subscriptions are
  -- always 'webhook' — an observer path, per ADR 0065 §7.
  delivery TEXT NOT NULL CHECK (delivery IN ('webhook', 'internal')),
  -- Absolute https:// URL for delivery='webhook'; NULL for 'internal'.
  endpoint_url TEXT,
  -- Platform responder id for delivery='internal'; NULL for 'webhook'.
  responder TEXT,
  -- Optional narrowing: only fire for these subject kinds. NULL means all.
  subject_kinds_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Standard Webhooks whsec_ signing secret, sealed at rest.
  sealed_secret_key_id TEXT,
  sealed_secret_ciphertext BLOB,
  sealed_secret_nonce BLOB,
  sealed_secret_aad_digest TEXT,
  last_delivered_at TEXT,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, name),
  CHECK (length(name) > 0),
  CHECK (length(event_types_json) > 0),
  -- A webhook hook needs somewhere to go and nothing to run; an internal hook
  -- is the exact inverse. Neither shape can be half-configured.
  CHECK (
    (delivery = 'webhook' AND endpoint_url IS NOT NULL AND length(endpoint_url) > 0
      AND responder IS NULL)
    OR
    (delivery = 'internal' AND responder IS NOT NULL AND length(responder) > 0
      AND endpoint_url IS NULL)
  ),
  -- An internal responder never holds a signing secret: it is called in
  -- process, so there is nothing to sign and nothing to store.
  CHECK (delivery = 'webhook' OR sealed_secret_key_id IS NULL),
  CHECK (
    (sealed_secret_key_id IS NULL AND sealed_secret_ciphertext IS NULL
      AND sealed_secret_nonce IS NULL AND sealed_secret_aad_digest IS NULL)
    OR
    (sealed_secret_key_id IS NOT NULL AND sealed_secret_ciphertext IS NOT NULL
      AND sealed_secret_nonce IS NOT NULL AND sealed_secret_aad_digest IS NOT NULL
      AND length(sealed_secret_key_id) > 0 AND length(sealed_secret_ciphertext) > 0
      AND length(sealed_secret_nonce) > 0 AND length(sealed_secret_aad_digest) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_hooks_org_enabled
  ON lifecycle_hooks(organization_id, enabled, name);

-- —— ladder watermarks ————————————————————————————————————————————
-- One row per (subject, track). expires_at is part of the row rather than a
-- lookup key: when a subject is renewed its deadline moves, and comparing the
-- stored deadline against the current one is what resets the ladder. A
-- responder therefore cannot forget to reset it.
CREATE TABLE IF NOT EXISTS lifecycle_watermarks (
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'certificate', 'certificate_authority', 'connection_credential',
    'store_path', 'signer'
  )),
  subject_id TEXT NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('alert', 'renewal')),
  stage TEXT NOT NULL CHECK (stage IN (
    'notice', 'warning', 'urgent', 'expired', 'renewal'
  )),
  -- Seconds-remaining threshold of the stage that fired. Persisted rather than
  -- recomputed: a subject's renew_before_seconds can be edited between passes,
  -- and re-deriving would move a rung that already fired.
  threshold_seconds INTEGER NOT NULL,
  -- The deadline this watermark was recorded against.
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, subject_kind, subject_id, track),
  -- The alert track never records the renewal rung, and vice versa. Keeping
  -- the tracks disjoint in the schema is what stops a per-subject renewal lead
  -- from aliasing a fixed alert rung and silently suppressing it.
  CHECK (
    (track = 'renewal' AND stage = 'renewal')
    OR
    (track = 'alert' AND stage IN ('notice', 'warning', 'urgent', 'expired'))
  )
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_watermarks_org
  ON lifecycle_watermarks(organization_id, subject_kind);

-- —— outbound delivery ledger ————————————————————————————————————
CREATE TABLE IF NOT EXISTS lifecycle_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  -- The value-blind payload built by opensesame-lifecycle. Never a credential:
  -- LifecycleEvent::payload assembles its keys individually rather than
  -- serializing a caller-supplied struct.
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Backoff gate: NULL or a past timestamp means claimable now.
  available_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, hook_id)
    REFERENCES lifecycle_hooks(organization_id, id) ON DELETE CASCADE,
  CHECK (length(payload_json) > 0)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_deliveries_pending
  ON lifecycle_deliveries(available_at, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_lifecycle_deliveries_hook
  ON lifecycle_deliveries(organization_id, hook_id, created_at);
