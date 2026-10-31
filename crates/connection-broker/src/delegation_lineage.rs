//! Ancestor-active checks for delegated grants (INV-REVOCATION dispatch path).

use chrono::{DateTime, Utc};
use opensesame_domain::{Grant, GrantId};
use sqlx::{Row, SqlitePool};

use crate::delegation::{parse_execution_mode, ResolvedDelegation};
use crate::error::{BrokerError, Result};
use crate::ConnectionBroker;

fn internal<E: std::fmt::Display>(error: E) -> BrokerError {
    BrokerError::Invalid(format!("delegation storage: {error}"))
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc))
}

pub(crate) async fn load_grant(pool: &SqlitePool, id: &str) -> Result<Option<Grant>> {
    let row = sqlx::query("SELECT body_json, revoked_at FROM grants WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(internal)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut grant: Grant =
        serde_json::from_str(&row.get::<String, _>("body_json")).map_err(internal)?;
    if let Some(revoked) = row.get::<Option<String>, _>("revoked_at") {
        grant.revoked_at = grant.revoked_at.or(Some(parse_time(&revoked)));
    }
    Ok(Some(grant))
}

/// Active when `grant` and every ancestor is active (depth-capped).
pub(crate) async fn grant_lineage_active(
    pool: &SqlitePool,
    grant: &Grant,
    now: DateTime<Utc>,
) -> Result<bool> {
    let mut current = grant.clone();
    for _ in 0..=32u32 {
        if current.assert_active(now).is_err() {
            return Ok(false);
        }
        let Some(parent_id) = current.parent_grant_id else {
            return Ok(true);
        };
        let Some(parent) = load_grant(pool, &parent_id.to_string()).await? else {
            return Ok(false);
        };
        current = parent;
    }
    Ok(false)
}

impl ConnectionBroker {
    /// Live delegation for a connection (invoke-path `ConnectionRef` resolve).
    ///
    /// # Errors
    ///
    /// Malformed stored grants/ids, or persistence failure.
    pub async fn find_live_delegation(
        &self,
        claimant_subject: &str,
        connection_id: &str,
    ) -> Result<Option<ResolvedDelegation>> {
        self.resolve_live_delegation(claimant_subject, Some(connection_id), None)
            .await
    }

    /// Resolve a frozen delegation by its own identity, independently of newer
    /// delegations for the same claimant and connection. Rechecks its grant
    /// and every ancestor using the same rules as connection resolution.
    ///
    /// # Errors
    ///
    /// Malformed stored grants/ids, or persistence failure.
    pub async fn find_live_delegation_by_id(
        &self,
        claimant_subject: &str,
        delegation_id: &str,
    ) -> Result<Option<ResolvedDelegation>> {
        self.resolve_live_delegation(claimant_subject, None, Some(delegation_id))
            .await
    }

    async fn resolve_live_delegation(
        &self,
        claimant_subject: &str,
        connection_id: Option<&str>,
        delegation_id: Option<&str>,
    ) -> Result<Option<ResolvedDelegation>> {
        let now = Utc::now();
        let row = sqlx::query(
            "SELECT id, offer_id, connection_id, owner_subject, claimant_subject, grant_id,
                    parent_grant_id, execution_mode, expires_at
             FROM connection_delegations
             WHERE claimant_subject = ? AND revoked_at IS NULL
               AND (? IS NULL OR connection_id = ?)
               AND (? IS NULL OR id = ?)
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(claimant_subject)
        .bind(connection_id)
        .bind(connection_id)
        .bind(delegation_id)
        .bind(delegation_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let Some(row) = row else { return Ok(None) };
        if now >= parse_time(&row.get::<String, _>("expires_at")) {
            return Ok(None);
        }
        let Some(grant) =
            crate::delegation_lineage::load_grant(&self.pool, &row.get::<String, _>("grant_id"))
                .await?
        else {
            return Ok(None);
        };
        if grant.assert_active(now).is_err() {
            return Ok(None);
        }
        // Walk every ancestor — one-hop left a live child under a dead grandparent.
        let Some(parent_grant) = crate::delegation_lineage::load_grant(
            &self.pool,
            &row.get::<String, _>("parent_grant_id"),
        )
        .await?
        else {
            return Ok(None);
        };
        if !crate::delegation_lineage::grant_lineage_active(&self.pool, &parent_grant, now).await? {
            return Ok(None);
        }
        let parent_grant_id = GrantId::parse(&row.get::<String, _>("parent_grant_id"))
            .map_err(|_| BrokerError::Invalid("stored parent grant id".into()))?;
        Ok(Some(ResolvedDelegation {
            delegation_id: row.get("id"),
            offer_id: row.get("offer_id"),
            connection_id: row.get("connection_id"),
            owner_subject: row.get("owner_subject"),
            claimant_subject: row.get("claimant_subject"),
            execution_mode: parse_execution_mode(&row.get::<String, _>("execution_mode")),
            grant,
            parent_grant,
            parent_grant_id,
        }))
    }
}
