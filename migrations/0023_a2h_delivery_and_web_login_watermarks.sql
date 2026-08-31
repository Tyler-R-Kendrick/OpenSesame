-- A2H becomes a hook delivery mode, and web logins become a watchable subject
-- kind (ADR 0081, A2H v1.0).
--
-- Two rebuilds, because SQLite cannot alter a CHECK in place.
--
-- The second one is a bug fix, not a feature. 0017 pinned
-- lifecycle_watermarks.subject_kind to the five kinds that existed then, and
-- 0019 added `web_login` as a rotation target. A watermark write for a web-login
-- subject would therefore fail the CHECK — and `dispatch::publish` treats a
-- failed watermark write as "stand down, somebody else may be acting". The
-- result is not a loud error: web-login rotations would quietly never run. That
-- is exactly the ADR 0052 §11 failure the whole feed exists to prevent, so it is
-- fixed in the same migration that adds the channel meant to report it.

-- —— 1. security_hooks: a2h joins the sinks ————————————————————————
--
-- An a2h hook has the same shape as a webhook one: an endpoint (the A2H
-- gateway's base URL) and a sealed secret (which signs the gateway's callback
-- to us rather than our request to it). So it widens the outbound CHECK group
-- exactly as webhook does, and 'internal' keeps its exact inverse shape.
--
-- Rebuilt rather than altered because SQLite cannot alter a CHECK. This widens
-- `security_hooks` — migration 0020 rebuilt `lifecycle_hooks` under that name
-- and added `severity_min`, both of which are carried across here unchanged.
CREATE TABLE IF NOT EXISTS security_hooks_widened (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  delivery TEXT NOT NULL
    CHECK (delivery IN ('webhook', 'internal', 'alertmanager', 'pagerduty', 'a2h')),
  endpoint_url TEXT,
  responder TEXT,
  subject_kinds_json TEXT,
  severity_min TEXT NOT NULL DEFAULT 'info'
    CHECK (severity_min IN ('info', 'warning', 'error', 'critical')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
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
  CHECK (
    (delivery = 'internal' AND responder IS NOT NULL AND length(responder) > 0
      AND endpoint_url IS NULL)
    OR
    (delivery <> 'internal' AND endpoint_url IS NOT NULL AND length(endpoint_url) > 0
      AND responder IS NULL)
  ),
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

INSERT OR IGNORE INTO security_hooks_widened
SELECT id, organization_id, name, event_types_json, delivery, endpoint_url, responder,
       subject_kinds_json, severity_min, enabled, sealed_secret_key_id,
       sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest,
       last_delivered_at, last_error, version, created_at, updated_at
FROM security_hooks;

DROP TABLE security_hooks;
ALTER TABLE security_hooks_widened RENAME TO security_hooks;

CREATE INDEX IF NOT EXISTS idx_security_hooks_org_enabled
  ON security_hooks(organization_id, enabled, name);

-- —— 2. lifecycle_watermarks: web_login is a tracked subject ————————
CREATE TABLE IF NOT EXISTS lifecycle_watermarks_widened (
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'certificate', 'certificate_authority', 'connection_credential',
    'store_path', 'signer', 'web_login'
  )),
  subject_id TEXT NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('alert', 'renewal')),
  stage TEXT NOT NULL CHECK (stage IN (
    'notice', 'warning', 'urgent', 'expired', 'renewal'
  )),
  threshold_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, subject_kind, subject_id, track),
  -- Carried over unchanged from 0017: the alert track never records the
  -- renewal rung, and vice versa. Keeping the tracks disjoint in the schema is
  -- what stops a per-subject renewal lead from aliasing a fixed alert rung and
  -- silently suppressing it.
  CHECK (
    (track = 'renewal' AND stage = 'renewal')
    OR
    (track = 'alert' AND stage IN ('notice', 'warning', 'urgent', 'expired'))
  )
);

INSERT OR IGNORE INTO lifecycle_watermarks_widened
SELECT organization_id, subject_kind, subject_id, track, stage, threshold_seconds,
       expires_at, created_at, updated_at
FROM lifecycle_watermarks;

DROP TABLE lifecycle_watermarks;
ALTER TABLE lifecycle_watermarks_widened RENAME TO lifecycle_watermarks;

CREATE INDEX IF NOT EXISTS idx_lifecycle_watermarks_org
  ON lifecycle_watermarks(organization_id, subject_kind);
