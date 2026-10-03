//! Organization policies behind the Bitwarden-compatible server (ADR 0148
//! §9): one row per organization and type, with the client's own settings
//! for it as JSON.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row as _, SqliteConnection};

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::Db;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenPolicy {
    pub id: String,
    pub org_id: String,
    pub policy_type: i64,
    pub enabled: bool,
    /// The policy's settings as the client sent them (JSON), if any.
    pub data: Option<String>,
    pub revision_at: DateTime<Utc>,
}

fn policy_from(row: &SqliteRow) -> anyhow::Result<BitwardenPolicy> {
    Ok(BitwardenPolicy {
        id: row.get("id"),
        org_id: row.get("org_id"),
        policy_type: row.get("policy_type"),
        enabled: row.get::<i64, _>("enabled") != 0,
        data: row.get("data"),
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

impl Db {
    /// An organization's policies, enabled or not.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_policies(&self, org_id: &str) -> anyhow::Result<Vec<BitwardenPolicy>> {
        let rows = sqlx::query(
            "SELECT id, org_id, policy_type, enabled, data, revision_at FROM bitwarden_org_policies \
             WHERE org_id = ? ORDER BY policy_type",
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(policy_from).collect()
    }

    /// Set a policy, keeping its id if it has one. A policy that excludes
    /// members is set with `bitwarden_put_policy_enforcing`, which revokes
    /// them in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_put_policy(&self, policy: &BitwardenPolicy) -> anyhow::Result<()> {
        let mut conn = self.pool.acquire().await?;
        put_policy(&mut conn, policy).await
    }
}

pub(super) async fn put_policy(
    conn: &mut SqliteConnection,
    policy: &BitwardenPolicy,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO bitwarden_org_policies (id, org_id, policy_type, enabled, data, revision_at) \
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, policy_type) DO UPDATE SET \
         enabled = excluded.enabled, data = excluded.data, revision_at = excluded.revision_at",
    )
    .bind(&policy.id)
    .bind(&policy.org_id)
    .bind(policy.policy_type)
    .bind(i64::from(policy.enabled))
    .bind(&policy.data)
    .bind(bitwarden_timestamp(policy.revision_at))
    .execute(&mut *conn)
    .await?;
    Ok(())
}
