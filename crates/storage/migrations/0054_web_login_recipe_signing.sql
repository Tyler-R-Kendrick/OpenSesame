-- ADR 0076 §4, ADR 0159: who may write the recipes a web-login run replays,
-- and what makes one of them trusted.
--
-- 0050 gave the runner a `web_login_recipes` table and nothing that wrote it,
-- so every real run parked with "no verified recipe for this origin". This
-- gives it a writer and a verifier, and the rule the runner enforces:
--
--   * `trust` is set only by the Host, from a verification it performed in the
--     same transaction as the write. A request body names no trust.
--   * A recipe is *verified* when its document carries a signature that
--     checks against a key the organization pinned and has not revoked
--     (`web_login_recipe_signers`). `verified_at` and `signer_key_id` record
--     that, and `digest` names exactly which document it was.
--   * An unverified recipe is stored `candidate` and no run replays it.
--   * A verified recipe is *canary-verified* once a real change through it has
--     been confirmed by a fresh login — attested inside the signed document
--     (`canary_source = 'signed'`) or recorded by the Host after a completed
--     run (`'run'`). An unattended run needs that; an attended one does not,
--     which is how the first canary can happen at all.
--   * A failed run demotes it (`canary_result = 'failed'`, `trust =
--     'candidate'`) until a later run or a re-signed document proves it again.
--
-- The invariant the writers keep: `trust = 'canary_verified'` exactly when
-- `verified_at IS NOT NULL AND canary_result = 'passed'`. The runner checks
-- both, and the signature again against the key as it stands now, so a
-- revocation takes effect on the next run and not on the next write.
--
-- Rows written before this migration carry no document: they are not
-- verified, and the runner refuses them.

ALTER TABLE web_login_recipes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE web_login_recipes ADD COLUMN document_json TEXT;
ALTER TABLE web_login_recipes ADD COLUMN digest TEXT;
ALTER TABLE web_login_recipes ADD COLUMN signer_key_id TEXT;
ALTER TABLE web_login_recipes ADD COLUMN verified_at TEXT;
ALTER TABLE web_login_recipes
  ADD COLUMN canary_result TEXT CHECK (canary_result IN ('passed', 'failed'));
ALTER TABLE web_login_recipes ADD COLUMN canary_at TEXT;
ALTER TABLE web_login_recipes ADD COLUMN canary_run_id TEXT;
ALTER TABLE web_login_recipes
  ADD COLUMN canary_source TEXT CHECK (canary_source IN ('signed', 'run'));
ALTER TABLE web_login_recipes ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'unknown';

-- The Ed25519 public keys an organization trusts to sign recipes. A key id is
-- derived from the key (`rsk_` and 32 hex of its SHA-256), so a request cannot
-- choose one. Revocation is final: the row stays, so the id can never be
-- pinned again and a recipe it signed is never quietly trusted by a re-pin.
CREATE TABLE IF NOT EXISTS web_login_recipe_signers (
  organization_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'ed25519'),
  public_key TEXT NOT NULL,
  label TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  PRIMARY KEY (organization_id, key_id),
  CHECK (length(organization_id) > 0),
  CHECK (key_id LIKE 'rsk\_%' ESCAPE '\' AND length(key_id) = 36),
  CHECK (length(public_key) = 64),
  CHECK (length(label) BETWEEN 1 AND 80),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
