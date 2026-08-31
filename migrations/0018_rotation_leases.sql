-- Rotation policies gain a lease, backoff, and an attempt cap (ADR 0076).
--
-- The scheduler previously listed every enabled policy and executed each due
-- one with no claim, so two gateway processes both executed the same policy.
-- For an OAuth refresh that is waste; for a credential change it is a lockout.
-- `backup.rs` and `sync_actor.rs` already solve this with a claim/lease; these
-- columns let `rotation_policies` do the same.
--
-- The rotation tables are created lazily by `ensure_rotation_schema()` rather
-- than by an earlier migration, so CREATE the pre-lease shape first: on a fresh
-- database that makes the ALTERs below valid, and on a database that already
-- ran `ensure_rotation_schema` it is a no-op. Both entry points converge on the
-- same final shape.
CREATE TABLE IF NOT EXISTS rotation_policies (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('connection','store_path')),
    target_id TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    last_rotated_at TEXT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rotation_jobs (
    id TEXT PRIMARY KEY,
    policy_id TEXT NULL,
    organization_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Held by the process currently executing this policy. A claim is only granted
-- when the previous lease has expired, so a crashed process releases its work
-- by the clock rather than by a liveness check.
ALTER TABLE rotation_policies ADD COLUMN lease_until TEXT;

-- Consecutive failed attempts. Reset to 0 on success.
ALTER TABLE rotation_policies ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- Earliest time this policy may be claimed again. Exponential backoff writes it
-- on failure; NULL with attempts >= max means parked, not merely waiting.
ALTER TABLE rotation_policies ADD COLUMN next_attempt_at TEXT;

-- A policy that exhausted its attempts stops retrying but stays `enabled`, so
-- the operator sees a rotation that is not happening. Silently flipping
-- `enabled` to 0 is the ADR 0052 s11 failure mode: the user believes
-- credentials are rotating when they are not.
ALTER TABLE rotation_policies ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;

-- Last failure hint. Truncated, value-blind operator text -- never a provider
-- response body and never credential material.
ALTER TABLE rotation_policies ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_rotation_policies_org ON rotation_policies(organization_id);
CREATE INDEX IF NOT EXISTS idx_rotation_policies_claimable
    ON rotation_policies(enabled, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS idx_rotation_jobs_org_time
    ON rotation_jobs(organization_id, created_at);
