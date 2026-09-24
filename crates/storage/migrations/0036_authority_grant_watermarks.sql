-- `authority_grant` may record a watermark too (ADR 0120 §5 / INV-GA-05).
--
-- Same quiet failure as `session_grant` in 0024: a CHECK that omits a new
-- `SubjectKind` makes `dispatch::publish` treat every watermark write as a
-- lost race, so the expiry notice re-fires forever and never records.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Rows carry over whole.
-- `crates/storage/tests/lifecycle_watermarks.rs` walks `SubjectKind::ALL`, so
-- adding a variant without this migration fails that test.

CREATE TABLE lifecycle_watermarks_authority_grant (
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'certificate', 'certificate_authority', 'connection_credential',
    'store_path', 'signer', 'web_login', 'session_grant', 'authority_grant'
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

INSERT INTO lifecycle_watermarks_authority_grant
  (organization_id, subject_kind, subject_id, track, stage,
   threshold_seconds, expires_at, created_at, updated_at)
SELECT organization_id, subject_kind, subject_id, track, stage,
   threshold_seconds, expires_at, created_at, updated_at
FROM lifecycle_watermarks;

DROP TABLE lifecycle_watermarks;

ALTER TABLE lifecycle_watermarks_authority_grant RENAME TO lifecycle_watermarks;

CREATE INDEX IF NOT EXISTS idx_lifecycle_watermarks_org
  ON lifecycle_watermarks(organization_id, subject_kind);
