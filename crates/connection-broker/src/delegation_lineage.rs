//! Ancestor-active checks for delegated grants (INV-REVOCATION dispatch path).

use chrono::{DateTime, Utc};
use opensesame_domain::Grant;
use sqlx::{Row, SqlitePool};

use crate::error::{BrokerError, Result};

fn internal<E: std::fmt::Display>(error: E) -> BrokerError {
    BrokerError::Invalid(format!("delegation storage: {error}"))
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
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
    let mut grant: Grant = serde_json::from_str(&row.get::<String, _>("body_json")).map_err(internal)?;
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
        let Some(parent_id) = current.parent_grant_id.clone() else {
            return Ok(true);
        };
        let Some(parent) = load_grant(pool, &parent_id.to_string()).await? else {
            return Ok(false);
        };
        current = parent;
    }
    Ok(false)
}
