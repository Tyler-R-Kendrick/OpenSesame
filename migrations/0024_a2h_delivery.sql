-- `a2h` joins the delivery kinds a subscription may name (ADR 0081 §10).
--
-- Every sink 0020 admitted talks to a *system* — a subscriber's own endpoint,
-- Alertmanager, PagerDuty. A2H v1.0 talks to a *person*, over whichever of
-- SMS, email, WhatsApp, push or voice the operator's gateway is configured
-- for. That is the reason it is a delivery kind here rather than a private
-- path from the runner to a phone: an agent run that blocks at 04:00 is a fact
-- on the same feed as everything else, and reaching somebody about it rides
-- the same subscription rows, the same retry ledger and the same egress guard
-- as every other sink. A second path is the one that ends up untested.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Every column carries
-- over unchanged and every other constraint is reproduced verbatim: the
-- outbound/internal shape rule, the internal-holds-no-secret rule, and the
-- all-or-nothing sealed column group. Losing one of those in a rename would be
-- a fence removed by accident.
--
-- A2H's own secret is the one that runs the other way. Every other sink is
-- fire-and-forget; an A2H gateway posts a person's reply back to us, and the
-- `whsec_` shared secret verifying `X-A2H-Signature` is the only thing
-- separating that from a stranger claiming somebody answered. It lives in the
-- same sealed column group under the same scope, so nothing new is needed for
-- it here.

CREATE TABLE security_hooks_a2h (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  -- 'webhook'      Standard Webhooks POST to a subscriber's endpoint.
  -- 'internal'     a platform-owned responder, in process. Never community code.
  -- 'alertmanager' Prometheus Alertmanager v2 POST /api/v2/alerts.
  -- 'pagerduty'    PagerDuty Events API v2 enqueue.
  -- 'a2h'          A2H v1.0 intent to a gateway that reaches a person.
  -- There is still no 'syslog', for the reason 0020 gives.
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

INSERT INTO security_hooks_a2h
  (id, organization_id, name, event_types_json, delivery, endpoint_url,
   responder, subject_kinds_json, severity_min, enabled, sealed_secret_key_id,
   sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest,
   last_delivered_at, last_error, version, created_at, updated_at)
SELECT
   id, organization_id, name, event_types_json, delivery, endpoint_url,
   responder, subject_kinds_json, severity_min, enabled, sealed_secret_key_id,
   sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest,
   last_delivered_at, last_error, version, created_at, updated_at
FROM security_hooks;

DROP TABLE security_hooks;

ALTER TABLE security_hooks_a2h RENAME TO security_hooks;

CREATE INDEX IF NOT EXISTS idx_security_hooks_org_enabled
  ON security_hooks(organization_id, enabled, name);
