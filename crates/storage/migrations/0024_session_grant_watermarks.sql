-- `session_grant` may record a watermark too (ADR 0079).
--
-- 0017 enumerated `lifecycle_watermarks.subject_kind` as the five kinds that
-- existed when the expiry ladder was written. 0023 widened it for `web_login`
-- when that kind arrived. `session_grant` arrived in the same window and was
-- missed, so it is still refused here — the same bug, in the half nobody
-- noticed.
--
-- The consequence is the quiet kind. `dispatch::publish` records a watermark as
-- a *claim*: the process that advances it is the one entitled to act, and a
-- write that fails is read as "somebody else is on it", so it stands down. A
-- CHECK violation is indistinguishable from losing that race. So for every
-- shared-session grant approaching its deadline:
--
--   * the rung never records, so the same expiry notice fires again on every
--     scan pass, forever;
--   * and `should_respond` is never reached, though for this kind that costs
--     nothing — `SubjectKind::session_grant` is deliberately never renewable,
--     because extending one person's reach into another's vault unattended is
--     not something the platform does.
--
-- Telling somebody their access lapses in an hour is exactly what the ladder is
-- for, and it is the half that is broken.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Rows carry over whole:
-- a watermark is the record that a rung already fired, and starting clean would
-- re-send every expiry notice a deployment has already sent.
--
-- The enumeration stays rather than being dropped in favour of the Rust enum: a
-- subject kind arriving here by typo is a claim recorded against nothing, which
-- would let the real subject's rung fire beside it forever. What stops a third
-- occurrence is not vigilance but
-- `crates/storage/tests/lifecycle_watermarks.rs`, which walks
-- `SubjectKind::ALL` and writes one row per kind — so adding a variant without
-- touching this file fails a test instead of disabling a ladder.

CREATE TABLE lifecycle_watermarks_all_kinds (
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

INSERT INTO lifecycle_watermarks_all_kinds
  (organization_id, subject_kind, subject_id, track, stage,
   threshold_seconds, expires_at, created_at, updated_at)
SELECT organization_id, subject_kind, subject_id, track, stage,
   threshold_seconds, expires_at, created_at, updated_at
FROM lifecycle_watermarks;

DROP TABLE lifecycle_watermarks;

ALTER TABLE lifecycle_watermarks_all_kinds RENAME TO lifecycle_watermarks;

CREATE INDEX IF NOT EXISTS idx_lifecycle_watermarks_org
  ON lifecycle_watermarks(organization_id, subject_kind);
