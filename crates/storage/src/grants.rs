//! Grants and the delegation chain that keeps them active.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{Db, Grant, GrantId, Row};

impl Db {
    /// Persist an authorization grant, and its lineage with it.
    ///
    /// The two writes share one transaction on purpose. A grant that exists
    /// without a `grant_lineage` row has an ancestry the fence cannot prove,
    /// so it denies every request (ADR 0121) — which is the safe answer, but a
    /// useless grant. Committing them together means a grant is never visible
    /// in that state.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization fails, when the grant names a
    /// parent that has no lineage of its own, or when the transaction fails.
    pub async fn insert_grant(&self, grant: &Grant) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(grant.id.to_string())
        .bind(grant.organization_id.to_string())
        .bind(serde_json::to_string(grant)?)
        .bind(grant.revoked_at.map(|t| t.to_rfc3339()))
        .bind(grant.created_at.to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        let parent = grant.parent_grant_id.map(|id| id.to_string());
        crate::authority_fence::record_lineage(
            &mut transaction,
            &grant.id.to_string(),
            parent.as_deref(),
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Find a grant by identifier, applying the authoritative revocation column.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or stored grant cannot be decoded.
    pub async fn find_grant(&self, id: &GrantId) -> anyhow::Result<Option<Grant>> {
        let row = sqlx::query("SELECT body_json, revoked_at FROM grants WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let mut grant: Grant = serde_json::from_str(&row.get::<String, _>("body_json"))?;
        // The column is the authority on revocation: `revoke_grant` writes it
        // without rewriting body_json, so a stale body must not resurrect a
        // revoked grant.
        if let Some(revoked) = row.get::<Option<String>, _>("revoked_at") {
            grant.revoked_at = grant.revoked_at.or_else(|| {
                chrono::DateTime::parse_from_rfc3339(&revoked)
                    .ok()
                    .map(|t| t.with_timezone(&chrono::Utc))
            });
        }
        Ok(Some(grant))
    }

    /// Revoke a live grant once, through the fence.
    ///
    /// The fence row is what stops descendants, so this is not "update a
    /// column and schedule a cascade" — [`Db::fence_grant`] commits the
    /// invalidation and the descendant `revoked_at` columns together, and the
    /// commit is the instant the revocation takes effect for every grant below
    /// this one (ADR 0121).
    ///
    /// Returns `false` when the grant was already revoked, so a retried
    /// revoke is a no-op rather than a reordering.
    ///
    /// # Errors
    ///
    /// Returns an error when the grant has no recorded lineage — its
    /// descendants could not then be fenced, and reporting success would be a
    /// lie — or when the transaction fails.
    pub async fn revoke_grant(
        &self,
        id: &GrantId,
        at: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<bool> {
        let commit = self
            .fence_grant(
                &id.to_string(),
                crate::authority_fence::REASON_OWNER_REVOKED,
                at,
            )
            .await?;
        Ok(commit.newly_fenced)
    }

    /// Assert a delegation chain is live: the grant's own window, then the
    /// fence over its whole ancestry.
    ///
    /// This used to walk `parent_grant_id` upward, one query per hop. The walk
    /// is gone, and with it the window it opened: a revoke had to reach a
    /// descendant before that descendant stopped being honoured, and until it
    /// did, the child was authority that had outlived the thing it narrowed
    /// (ADR 0044 decision 8). The fence answers for every ancestor at once
    /// from the grant's materialized lineage, so a root revocation blocks this
    /// grant the moment it commits — there is nothing left to arrive.
    ///
    /// Only this grant's clock is checked, and that is not an omission.
    /// [`Grant::validate_attenuation`] refuses a child whose `expires_at`
    /// exceeds its parent's, so a grant inside its own window is necessarily
    /// inside every ancestor's window too — expiry is transitive at mint time.
    /// Revocation is not: it happens long after the chain was built, which is
    /// exactly why it needs the fence rather than an invariant.
    ///
    /// # Errors
    ///
    /// Returns an error when the grant is outside its window, or when the
    /// fence does not come back clear — including when it cannot tell.
    /// Uncertainty denies.
    pub async fn assert_grant_chain_active(
        &self,
        grant: &Grant,
        now: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<()> {
        grant.assert_active(now)?;
        let verdict = self
            .fence_status(
                &grant.id.to_string(),
                opensesame_lifecycle::Freshness::any(),
            )
            .await;
        if !verdict.authorizes() {
            anyhow::bail!("delegation chain refused: {}", verdict.reason());
        }
        Ok(())
    }
}
