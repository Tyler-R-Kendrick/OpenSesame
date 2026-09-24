//! The durable half of root/ancestor invalidation fencing (ADR 0121).
//!
//! `opensesame-lifecycle`'s [`evaluate_fence`] decides; this module is what
//! makes the decision durable and what fixes the instant it takes effect.
//!
//! # The linearization point
//!
//! **A revocation takes effect at the COMMIT of [`fence_grant`]'s
//! transaction.** That commit is the only event in the system that matters
//! for revocation ordering:
//!
//! - Before it, a concurrent authorization may legitimately allow. It read a
//!   state of the world in which the grant was live, and that read is not
//!   wrong — it is ordered before the revoke.
//! - From it onward, every authorization denies, including one already in
//!   flight that has not yet reached its fence read. There is no descendant
//!   to update first, so there is no interval during which "revoked" is true
//!   for the root and false for a child.
//!
//! The transaction is `BEGIN IMMEDIATE`: it takes the write lock up front, so
//! the sequence it claims cannot be claimed by a racing writer that started
//! earlier and committed later. [`read_fence`] is a plain read, so a reader
//! never blocks a revoke and a revoke never blocks a reader — they are simply
//! ordered by that commit.
//!
//! The cascade of `revoked_at` columns rides in the same transaction, but it
//! is deliberately *not* what enforces. It exists so listings, receipts and
//! the expiry scanner agree with the fence. Were it dropped entirely the
//! fence would still deny every descendant, which is the property that makes
//! this safe to rely on.
//!
//! # Scope — no quorum is implied
//!
//! This is one `SQLite` database with one writer at a time. Within a host, the
//! `sequence` column is a total order and the fence is linearizable. That is
//! the whole claim. It is **not** a consensus protocol, and nothing here may
//! be read as one: two hosts pointed at two databases have two independent
//! fences, and a deployment that needs one authority decision across hosts
//! needs a store that actually provides consensus. Inferring a quorum from
//! `SQLite` would be inventing a guarantee the storage engine does not offer.
//!
//! # Freshness
//!
//! [`fence_status`] returns [`FenceVerdict`], whose only authorizing variant
//! is `Clear`. Every uncertainty — a grant with no lineage row, an unparsable
//! path, a stored row that disagrees with its own path, a failed query — maps
//! to `Indeterminate`, which denies. A caller that has already observed the
//! fence at some sequence passes [`Freshness::at_least`] so an answer from
//! behind that point is refused rather than believed.

mod read;
mod record;
mod revoke;

pub use read::{fence_high_water, fence_status};
pub use record::{record_lineage, REASON_OWNER_REVOKED};
pub use revoke::{fence_grant, FenceCommit};

use opensesame_lifecycle::{FenceVerdict, Freshness, Lineage};

use super::Db;

impl Db {
    /// Fence a grant. See [`fence_grant`] for the linearization point.
    ///
    /// # Errors
    ///
    /// Returns an error when the grant has no lineage or the transaction fails.
    pub async fn fence_grant(
        &self,
        grant_id: &str,
        reason: &str,
        at: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<FenceCommit> {
        fence_grant(&self.pool, grant_id, reason, at).await
    }

    /// The fence verdict for one grant's whole chain, in one query.
    ///
    /// This is the replacement for a per-hop walk up `parent_grant_id`: see
    /// [`Db::assert_grant_chain_active`].
    pub async fn fence_status(&self, grant_id: &str, freshness: Freshness) -> FenceVerdict {
        fence_status(&self.pool, grant_id, freshness).await
    }

    /// The store's fence high-water mark.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn fence_high_water(&self) -> anyhow::Result<u64> {
        fence_high_water(&self.pool).await
    }

    /// Record a grant's lineage outside a caller-owned transaction.
    ///
    /// Prefer [`record_lineage`] inside the transaction that writes the grant
    /// — a grant that exists without a lineage row denies until one appears.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent has no lineage or the insert fails.
    pub async fn record_grant_lineage(
        &self,
        grant_id: &str,
        parent_grant_id: Option<&str>,
    ) -> anyhow::Result<Lineage> {
        let mut tx = self.pool.begin().await?;
        let lineage = record_lineage(&mut tx, grant_id, parent_grant_id).await?;
        tx.commit().await?;
        Ok(lineage)
    }
}
