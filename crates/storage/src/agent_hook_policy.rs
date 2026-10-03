//! One agent-hooks policy per organization (ADR 0156).
//!
//! The row holds the policy document `opensesame-agent-hooks` parses, already
//! in canonical form; this module never interprets it. What it owns is the
//! compare-and-set: a replacement names the version it was made against, and
//! lands only when that is still the stored version, in one statement, so two
//! administrators editing the same policy cannot both win against one read.
//! The audit event for a replacement commits in the same transaction as the
//! row, so a policy change is never in force without its record.

use super::{append_outbox_tx, Db, Row, Utc};

/// Who an organization's escalated actions are put to, beside the policy
/// (migration 0055).
pub mod approver;

/// The audit of every verdict answered under a policy (migration 0052).
pub mod decisions;

/// The stored policy of one organization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAgentHookPolicy {
    pub organization_id: String,
    /// The canonical policy document (JSON).
    pub policy_json: String,
    /// The compare-and-set counter: 1 on the first write, +1 on each one after.
    pub version: i64,
    pub updated_at: String,
    /// The actor subject that wrote it (`operator` or a principal).
    pub updated_by: String,
}

/// A replacement: what to store, and the version it was made against (0: no
/// policy is stored yet).
pub struct AgentHookPolicyWrite<'a> {
    pub organization_id: &'a str,
    pub policy_json: &'a str,
    pub expected_version: i64,
    pub updated_by: &'a str,
}

/// The audit event committed with a replacement.
pub struct AgentHookPolicyAudit<'a> {
    pub event_type: &'a str,
    pub payload_json: &'a str,
}

/// How a compare-and-set replacement ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentHookPolicyWriteOutcome {
    /// Stored; the row as it now stands.
    Written(StoredAgentHookPolicy),
    /// Another write landed first; nothing changed. The version now stored
    /// (0 when there is still no row).
    Conflict { current_version: i64 },
}

fn stored(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<StoredAgentHookPolicy> {
    Ok(StoredAgentHookPolicy {
        organization_id: row.try_get("organization_id")?,
        policy_json: row.try_get("policy_json")?,
        version: row.try_get("version")?,
        updated_at: row.try_get("updated_at")?,
        updated_by: row.try_get("updated_by")?,
    })
}

const SELECT: &str = "SELECT organization_id, policy_json, version, updated_at, updated_by \
                      FROM agent_hook_policies WHERE organization_id = ?";

impl Db {
    /// The organization's stored agent-hooks policy, if it has one.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn agent_hook_policy(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<StoredAgentHookPolicy>> {
        sqlx::query(SELECT)
            .bind(organization_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(stored)
            .transpose()
    }

    /// Replace the organization's policy when `expected_version` is still
    /// the stored version (0: only when none is stored), committing `audit`
    /// to the outbox in the same transaction. A lost race changes nothing and
    /// appends nothing.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails; nothing is committed.
    pub async fn put_agent_hook_policy(
        &self,
        write: &AgentHookPolicyWrite<'_>,
        audit: &AgentHookPolicyAudit<'_>,
    ) -> anyhow::Result<AgentHookPolicyWriteOutcome> {
        anyhow::ensure!(
            write.expected_version >= 0,
            "an expected policy version is never negative"
        );
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let written = if write.expected_version == 0 {
            sqlx::query(
                "INSERT INTO agent_hook_policies \
                 (organization_id, policy_json, version, updated_at, updated_by) \
                 VALUES (?, ?, 1, ?, ?) ON CONFLICT(organization_id) DO NOTHING",
            )
            .bind(write.organization_id)
            .bind(write.policy_json)
            .bind(&now)
            .bind(write.updated_by)
            .execute(&mut *transaction)
            .await?
        } else {
            sqlx::query(
                "UPDATE agent_hook_policies \
                 SET policy_json = ?, version = version + 1, updated_at = ?, updated_by = ? \
                 WHERE organization_id = ? AND version = ?",
            )
            .bind(write.policy_json)
            .bind(&now)
            .bind(write.updated_by)
            .bind(write.organization_id)
            .bind(write.expected_version)
            .execute(&mut *transaction)
            .await?
        };
        let row = sqlx::query(SELECT)
            .bind(write.organization_id)
            .fetch_optional(&mut *transaction)
            .await?
            .as_ref()
            .map(stored)
            .transpose()?;
        if written.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(AgentHookPolicyWriteOutcome::Conflict {
                current_version: row.map_or(0, |row| row.version),
            });
        }
        let row = row.ok_or_else(|| anyhow::anyhow!("written agent-hooks policy vanished"))?;
        append_outbox_tx(&mut transaction, audit.event_type, audit.payload_json).await?;
        transaction.commit().await?;
        Ok(AgentHookPolicyWriteOutcome::Written(row))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "org_agent_hooks";
    const AUDIT: AgentHookPolicyAudit<'static> = AgentHookPolicyAudit {
        event_type: "agent_hooks.policy.updated",
        payload_json: "{\"organization_id\":\"org_agent_hooks\"}",
    };

    fn write(policy_json: &str, expected_version: i64) -> AgentHookPolicyWrite<'_> {
        AgentHookPolicyWrite {
            organization_id: ORG,
            policy_json,
            expected_version,
            updated_by: "operator",
        }
    }

    async fn audit_rows(db: &Db) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM outbox_events WHERE event_type = 'agent_hooks.policy.updated'",
        )
        .fetch_one(db.pool())
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn an_organization_without_a_policy_reads_none() {
        let db = Db::connect_memory().await.unwrap();
        assert_eq!(db.agent_hook_policy(ORG).await.unwrap(), None);
    }

    #[tokio::test]
    async fn writes_are_compare_and_set_and_audited_with_the_row() {
        let db = Db::connect_memory().await.unwrap();
        let first = db
            .put_agent_hook_policy(&write("{\"version\":1}", 0), &AUDIT)
            .await
            .unwrap();
        let AgentHookPolicyWriteOutcome::Written(first) = first else {
            panic!("the first write against version 0 lands");
        };
        assert_eq!(first.version, 1);
        assert_eq!(first.updated_by, "operator");
        assert_eq!(audit_rows(&db).await, 1);

        // A second creation, or a replacement against a stale version, loses.
        for stale in [0, 2] {
            let outcome = db
                .put_agent_hook_policy(&write("{\"version\":1,\"tools\":[]}", stale), &AUDIT)
                .await
                .unwrap();
            assert_eq!(
                outcome,
                AgentHookPolicyWriteOutcome::Conflict { current_version: 1 }
            );
        }
        assert_eq!(audit_rows(&db).await, 1, "a lost race appends nothing");

        let second = db
            .put_agent_hook_policy(&write("{\"version\":1,\"tools\":[]}", 1), &AUDIT)
            .await
            .unwrap();
        let AgentHookPolicyWriteOutcome::Written(second) = second else {
            panic!("a replacement against the stored version lands");
        };
        assert_eq!(second.version, 2);
        assert_eq!(second.policy_json, "{\"version\":1,\"tools\":[]}");
        assert_eq!(db.agent_hook_policy(ORG).await.unwrap(), Some(second));
        assert_eq!(audit_rows(&db).await, 2);
    }

    #[tokio::test]
    async fn a_replacement_with_nothing_stored_is_a_conflict_at_zero() {
        let db = Db::connect_memory().await.unwrap();
        let outcome = db
            .put_agent_hook_policy(&write("{\"version\":1}", 3), &AUDIT)
            .await
            .unwrap();
        assert_eq!(
            outcome,
            AgentHookPolicyWriteOutcome::Conflict { current_version: 0 }
        );
        assert!(db
            .put_agent_hook_policy(&write("{\"version\":1}", -1), &AUDIT)
            .await
            .is_err());
        assert_eq!(db.agent_hook_policy(ORG).await.unwrap(), None);
    }

    #[tokio::test]
    async fn organizations_do_not_share_a_policy() {
        let db = Db::connect_memory().await.unwrap();
        db.put_agent_hook_policy(&write("{\"version\":1}", 0), &AUDIT)
            .await
            .unwrap();
        assert_eq!(db.agent_hook_policy("org_other").await.unwrap(), None);
    }
}
