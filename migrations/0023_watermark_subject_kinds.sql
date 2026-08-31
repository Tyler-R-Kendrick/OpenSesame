-- Every subject kind the ladder can reach may record a watermark.
--
-- 0017 pinned `lifecycle_watermarks.subject_kind` to the five kinds that
-- existed when the ladder was written. Two have been added since —
-- `web_login` (ADR 0081) and `session_grant` (ADR 0079) — and neither widened
-- this CHECK.
--
-- The consequence is the quiet kind. `dispatch::publish` records a watermark
-- as a *claim*: the process that advances it is the one entitled to act, and a
-- write that fails is read as "somebody else is on it", so it stands down. A
-- CHECK violation is indistinguishable from losing that race. So for both new
-- kinds:
--
--   * the responder never ran — a web login due for rotation was never
--     rotated, and a session grant approaching its deadline was never acted on;
--   * and the rung never recorded, so every scan pass re-fired the same
--     notice, forever.
--
-- A feature that is silently not happening while the product reports it is
-- scheduled is exactly what ADR 0052 §11 refused to ship, and the ladder is
-- the mechanism ADR 0074 built so no subsystem has a private due-check to rot
-- in. It rotted here instead.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Rows carry over whole:
-- a watermark is a claim that a rung already fired, and dropping one would
-- re-fire every notice the deployment has already sent.
--
-- The enumeration is kept rather than dropped, because a subject kind reaching
-- this table by typo is a claim recorded against nothing. What stops the next
-- variant repeating this is not vigilance but
-- `crates/storage/tests/lifecycle_watermarks.rs`, which walks `SubjectKind::ALL`
-- and writes one row per kind: adding a variant without touching this file
-- fails a test instead of disabling a ladder.

CREATE TABLE lifecycle_watermarks_widened (
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'certificate', 'certificate_authority', 'connection_credential',
    'store_path', 'signer', 'web_login', 'session_grant'
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
  CHECK (
    (track = 'renewal' AND stage = 'renewal')
    OR
    (track = 'alert' AND stage IN ('notice', 'warning', 'urgent', 'expired'))
  )
);

INSERT INTO lifecycle_watermarks_widened
  (organization_id, subject_kind, subject_id, track, stage,
   threshold_seconds, expires_at, created_at, updated_at)
SELECT organization_id, subject_kind, subject_id, track, stage,
   threshold_seconds, expires_at, created_at, updated_at
FROM lifecycle_watermarks;

DROP TABLE lifecycle_watermarks;

ALTER TABLE lifecycle_watermarks_widened RENAME TO lifecycle_watermarks;

CREATE INDEX IF NOT EXISTS idx_lifecycle_watermarks_org
  ON lifecycle_watermarks(organization_id, subject_kind);
