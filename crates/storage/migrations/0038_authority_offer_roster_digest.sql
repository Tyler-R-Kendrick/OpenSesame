-- Snapshot offers bind a reviewed roster by digest, not only by revision
-- number. Without the digest, two different rosters that happen to share a
-- revision counter cannot be told apart at activation.
--
-- Live binding stays a declared CHECK value on `membership_binding`, but the
-- Host store refuses to create live offers until a trusted-writer advance path
-- exists. Application code enforces that refusal; this migration only makes
-- room for the snapshot digest.

ALTER TABLE grant_offers ADD COLUMN roster_digest TEXT;
