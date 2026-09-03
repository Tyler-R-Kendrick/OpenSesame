//! Grants and the delegation chain that keeps them active.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{Db, Grant, GrantId, Row};

impl Db {
    /// Persist an authorization grant.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
    pub async fn insert_grant(&self, grant: &Grant) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(grant.id.to_string())
        .bind(grant.organization_id.to_string())
        .bind(serde_json::to_string(grant)?)
        .bind(grant.revoked_at.map(|t| t.to_rfc3339()))
        .bind(grant.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
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

    /// Revoke a live grant once.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn revoke_grant(
        &self,
        id: &GrantId,
        at: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
                .bind(at.to_rfc3339())
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Assert every hop of a delegation chain is live, walking `parent_grant_id`
    /// up from `grant` to the root. Ancestor revocation must kill descendants:
    /// a child that stayed "active" after its parent died would be authority
    /// that outlived the thing it narrowed (ADR 0044 decision 8).
    ///
    /// # Errors
    ///
    /// Returns an error when a grant is inactive, missing, malformed, or cyclic.
    pub async fn assert_grant_chain_active(
        &self,
        grant: &Grant,
        now: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<()> {
        grant.assert_active(now)?;
        let mut cursor = grant.parent_grant_id;
        // Bounded walk: depth is validated at mint, but a storage cycle must
        // fail closed rather than spin.
        for _ in 0..16 {
            let Some(parent_id) = cursor else {
                return Ok(());
            };
            let parent = self
                .find_grant(&parent_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("delegation chain hop missing: {parent_id}"))?;
            parent.assert_active(now)?;
            cursor = parent.parent_grant_id;
        }
        anyhow::bail!("delegation chain too deep to verify")
    }
}
