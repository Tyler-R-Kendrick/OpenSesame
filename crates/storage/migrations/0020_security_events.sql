-- Security-event hooks: one feed for expiry, breach exposure, and whatever
-- comes next (ADR 0080).
--
-- 0017 built the hook, watermark, and delivery machinery for expiry alone, and
-- named the tables after it. Breach findings need exactly the same machinery --
-- subscriptions, fan-out, a retry ledger -- and standing up a second copy is
-- how the second feed ends up with no alerting. So the subscription and
-- delivery tables are rebuilt here under names that describe what they now
-- carry, and lifecycle_watermarks keeps its name because a ladder watermark is
-- genuinely specific to a deadline.
--
-- Rebuilt rather than altered because two CHECK constraints have to change,
-- and SQLite cannot alter a CHECK. Rebuilding under new names also avoids
-- ALTER TABLE ... RENAME entirely: renaming a table rewrites the foreign keys
-- that point at it, and there is a parent/child pair here. Creating both new
-- tables first, copying, then dropping child-before-parent means no reference
-- is ever dangling and no schema rewrite is ever triggered.
--
-- Two columns are new:
--   delivery         -- widened past 'webhook'/'internal' to the alerting
--                       sinks operators already run.
--   severity_min     -- a floor, so a paging integration can subscribe to
--                       everything loud without also subscribing to every
--                       30-day expiry notice.
--
-- Existing rows carry over with severity_min = 'info', which admits everything
-- and is exactly the behaviour they had before this migration.

-- —— subscriptions ————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS security_hooks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- JSON array of frozen event types from any family, or a family wildcard
  -- ("lifecycle.*", "breach.*"). Validated in crates/storage against the
  -- frozen sets: an empty filter is refused rather than defaulted to
  -- everything, because a hook that names no events is a misconfiguration and
  -- "everything" is the wrong direction to fail.
  event_types_json TEXT NOT NULL,
  -- 'webhook'      Standard Webhooks POST to a subscriber's endpoint.
  -- 'internal'     a platform-owned responder, in process. Never community code.
  -- 'alertmanager' Prometheus Alertmanager v2 POST /api/v2/alerts.
  -- 'pagerduty'    PagerDuty Events API v2 enqueue.
  -- There is no 'syslog': RFC 5424 is a line format, not a transport worth
  -- inventing plaintext egress for, so those lines are emitted to the host's
  -- own log stream instead. See crates/security-events/src/delivery.rs.
  delivery TEXT NOT NULL
    CHECK (delivery IN ('webhook', 'internal', 'alertmanager', 'pagerduty')),
  -- Absolute https:// URL for every outbound delivery. NULL for 'internal'.
  -- Stored even for PagerDuty, whose API has one well-known URL, so the row is
  -- self-describing and an operator can point at a regional endpoint or an
  -- egress proxy without a per-sink special case here.
  endpoint_url TEXT,
  -- Platform responder id for delivery='internal'. NULL otherwise.
  responder TEXT,
  -- Optional narrowing: only fire for these subject kinds. NULL means all.
  subject_kinds_json TEXT,
  -- Severity floor. 'info' admits everything.
  severity_min TEXT NOT NULL DEFAULT 'info'
    CHECK (severity_min IN ('info', 'warning', 'error', 'critical')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Sealed at rest: a Standard Webhooks whsec_ signing secret, or a PagerDuty
  -- routing key. Ciphertext only.
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
  -- An outbound hook needs somewhere to go and nothing to run; an internal
  -- hook is the exact inverse. Neither shape can be half-configured.
  CHECK (
    (delivery = 'internal' AND responder IS NOT NULL AND length(responder) > 0
      AND endpoint_url IS NULL)
    OR
    (delivery <> 'internal' AND endpoint_url IS NOT NULL AND length(endpoint_url) > 0
      AND responder IS NULL)
  ),
  -- An internal responder never holds a secret: it is called in process, so
  -- there is nothing to sign and nothing to authenticate.
  CHECK (delivery <> 'internal' OR sealed_secret_key_id IS NULL),
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

CREATE INDEX IF NOT EXISTS idx_security_hooks_org_enabled
  ON security_hooks(organization_id, enabled, name);

-- —— outbound delivery ledger ————————————————————————————————————
CREATE TABLE IF NOT EXISTS security_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  -- The serialized SecurityNotice a sink is rendered from. Rows carried over
  -- from 0017 instead hold the flat payload the detector built, which is not
  -- an envelope; the delivery worker recognizes both and sends a carried-over
  -- row exactly as it was written, so an upgrade does not dead-letter the
  -- deliveries somebody was already waiting on.
  --
  -- Never a credential either way: payloads are assembled key by key rather
  -- than by serializing a caller-supplied struct, and SecurityNotice::
  -- safe_payload strips secret-shaped keys as a second fence.
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
    REFERENCES security_hooks(organization_id, id) ON DELETE CASCADE,
  CHECK (length(payload_json) > 0)
);

CREATE INDEX IF NOT EXISTS idx_security_deliveries_pending
  ON security_deliveries(available_at, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_security_deliveries_hook
  ON security_deliveries(organization_id, hook_id, created_at);

-- —— carry the 0017 rows across ——————————————————————————————————
INSERT INTO security_hooks (
  id, organization_id, name, event_types_json, delivery, endpoint_url,
  responder, subject_kinds_json, severity_min, enabled, sealed_secret_key_id,
  sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest,
  last_delivered_at, last_error, version, created_at, updated_at
)
SELECT
  id, organization_id, name, event_types_json, delivery, endpoint_url,
  responder, subject_kinds_json, 'info', enabled, sealed_secret_key_id,
  sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest,
  last_delivered_at, last_error, version, created_at, updated_at
FROM lifecycle_hooks;

INSERT INTO security_deliveries (
  id, organization_id, hook_id, event_type, subject_kind, subject_id,
  payload_json, state, attempts, available_at, last_error, delivered_at,
  created_at, updated_at
)
SELECT
  id, organization_id, hook_id, event_type, subject_kind, subject_id,
  payload_json, state, attempts, available_at, last_error, delivered_at,
  created_at, updated_at
FROM lifecycle_deliveries;

-- Child before parent, so no foreign key is ever left pointing at nothing.
DROP TABLE lifecycle_deliveries;
DROP TABLE lifecycle_hooks;

-- —— breach findings ——————————————————————————————————————————————
-- What the breach scanner has already reported, so a finding fires once and a
-- clear can be published when it stops reproducing.
--
-- This is the breach plane's answer to lifecycle_watermarks, and it is a
-- different shape for a real reason: an expiry ladder is a monotonic rung
-- count against a moving deadline, while a breach finding is a fact that is
-- either currently true or currently false. It can go away -- a rotated secret
-- stops matching the corpus -- and that transition is itself an event, so the
-- row records state rather than a high-water mark.
--
-- No column can hold a value. `reference` is a published breach name; there is
-- deliberately no column for a hash, a prefix, or anything derived from a
-- secret, because a stored SHA-1 of a password is a crackable artifact and
-- keeping one to save a re-check would be a bad trade.
CREATE TABLE IF NOT EXISTS breach_findings (
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'store_path', 'connection_credential', 'domain', 'breach_source'
  )),
  subject_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hibp_passwords', 'hibp_breaches')),
  -- Which specific finding within the subject: a published breach name for a
  -- disclosure, empty for a password-corpus match, of which there is one per
  -- subject. Part of the key so two disclosures about one domain are two
  -- findings rather than one that keeps overwriting itself.
  reference TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  -- Corpus occurrence count for a password match. A property of the corpus.
  occurrences INTEGER,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'cleared')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  cleared_at TEXT,
  PRIMARY KEY (organization_id, subject_kind, subject_id, source, reference),
  CHECK ((state = 'cleared') = (cleared_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_breach_findings_open
  ON breach_findings(organization_id, state, last_seen_at);
