//! The revoke side of the fence — and the linearization point.
//!
//! Split from `mod.rs` to stay inside the 400-line module budget (ADR 0093).
//! `mod.rs` carries the full argument for why the commit below is the instant
//! a revocation takes effect; this file is that argument in code.

use opensesame_lifecycle::Lineage;
use sqlx::{Row as _, Sqlite, SqlitePool, Transaction};

/// What one revocation did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FenceCommit {
    /// The position this revocation took in the store's total order. Every
    /// authorization that observes the fence at or past this value denies.
    pub sequence: u64,
    /// Descendant grants whose `revoked_at` the cascade filled in. Zero is a
    /// normal answer — a leaf has no descendants, and the count never affects
    /// whether the fence denies.
    pub cascaded_grants: u64,
    /// Descendant delegation rows the cascade closed.
    pub cascaded_delegations: u64,
    /// False when the grant was already fenced, so nothing was written.
    pub newly_fenced: bool,
}

/// Fence a grant: the linearization point.
///
/// One `BEGIN IMMEDIATE` transaction inserts the invalidation row and, for
/// tidiness only, closes the `revoked_at` columns of the grant and everything
/// beneath it as a single indexed range scan over the materialized path — no
/// recursion, no per-hop round trip, and no separate job to fall behind.
///
/// Fencing an already-fenced grant is a no-op that reports the original
/// sequence, so a retried revoke cannot reorder history.
///
/// # Errors
///
/// Returns an error when the grant has no lineage row — an ungrounded grant
/// cannot be fenced coherently, and silently succeeding would leave its
/// descendants live — or when the transaction fails.
pub async fn fence_grant(
    pool: &SqlitePool,
    grant_id: &str,
    reason: &str,
    at: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<FenceCommit> {
    let mut tx = begin_write(pool).await?;

    let path: Option<String> =
        sqlx::query("SELECT ancestor_path FROM grant_lineage WHERE grant_id = ?")
            .bind(grant_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(|row| row.get("ancestor_path"));
    let Some(path) = path else {
        anyhow::bail!("grant {grant_id} has no recorded lineage; cannot fence it coherently");
    };
    let lineage = Lineage::from_path(&path)?;

    let existing: Option<i64> =
        sqlx::query("SELECT sequence FROM grant_invalidations WHERE grant_id = ?")
            .bind(grant_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(|row| row.get("sequence"));
    if let Some(sequence) = existing {
        tx.commit().await?;
        return Ok(FenceCommit {
            sequence: sequence.try_into().unwrap_or(u64::MAX),
            cascaded_grants: 0,
            cascaded_delegations: 0,
            newly_fenced: false,
        });
    }

    let next: i64 =
        sqlx::query("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM grant_invalidations")
            .fetch_one(&mut *tx)
            .await?
            .get("next");
    // Descriptive only: `sequence` is the authority on order, so a caller's
    // clock can label the row without being able to reorder history.
    let stamp = at.to_rfc3339();
    sqlx::query(
        "INSERT INTO grant_invalidations (grant_id, sequence, reason, invalidated_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(grant_id)
    .bind(next)
    .bind(reason)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;

    // Bookkeeping, not enforcement. One range scan over the path index covers
    // the grant and every descendant; see `Lineage::subtree_bounds` for why
    // this is a range rather than a `LIKE` prefix.
    let (low, high) = lineage.subtree_bounds();
    let grants = sqlx::query(
        "UPDATE grants SET revoked_at = ?
         WHERE revoked_at IS NULL
           AND id IN (SELECT grant_id FROM grant_lineage
                       WHERE ancestor_path >= ? AND ancestor_path < ?)",
    )
    .bind(&stamp)
    .bind(&low)
    .bind(&high)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let delegations = sqlx::query(
        "UPDATE connection_delegations SET revoked_at = ?
         WHERE revoked_at IS NULL
           AND grant_id IN (SELECT grant_id FROM grant_lineage
                             WHERE ancestor_path >= ? AND ancestor_path < ?)",
    )
    .bind(&stamp)
    .bind(&low)
    .bind(&high)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // Everything above becomes true at once, here.
    tx.commit().await?;

    Ok(FenceCommit {
        sequence: next.try_into().unwrap_or(u64::MAX),
        cascaded_grants: grants,
        cascaded_delegations: delegations,
        newly_fenced: true,
    })
}

/// Begin a transaction that already holds the write lock.
///
/// sqlx opens a deferred transaction, which only upgrades to a write lock on
/// its first write — so a revoke that started earlier can lose the lock to one
/// that started later, and both can read the same `MAX(sequence)`. The no-op
/// write below forces the upgrade up front, which makes concurrent revokes
/// queue instead of collide.
///
/// The `UNIQUE` constraint on `sequence` is the backstop, not this: if two
/// writers ever did claim the same position, the second would fail its insert
/// and its revoke would return an error. A failed revoke is safe — the caller
/// retries and the grant stays live meanwhile, which is the pre-revoke state,
/// not a widening.
async fn begin_write(pool: &SqlitePool) -> anyhow::Result<Transaction<'_, Sqlite>> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE grant_invalidations SET sequence = sequence WHERE 0")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
