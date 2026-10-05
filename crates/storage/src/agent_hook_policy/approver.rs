//! Who an organization's escalated agent actions are put to (ADR 0159).
//!
//! A sibling of the policy ([`super`]): the policy says whether an
//! action needs a person, this row says which one. It lives beside the policy
//! rather than in it because the policy document is strictly parsed, shown to
//! operators and compared against presets, and an inbox handle belongs to
//! none of that.
//!
//! The compare-and-set and the audit are the policy's: a replacement names
//! the version it was made against and lands only when that is still the
//! stored version, in one statement; its audit event commits in the same
//! transaction as the row. `approver_ref` may be cleared (`None`): the row
//! stays, so the version keeps rising and a stale editor still loses.

use crate::{append_outbox_event_in, Db, Row, Utc};

/// The stored approver of one organization.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredAgentHookApprover {
    pub organization_id: String,
    /// The approver's inbox handle, or `None` when the organization asks nobody.
    pub approver_ref: Option<String>,
    /// The compare-and-set counter: 1 on the first write, +1 on each one after.
    pub version: i64,
    pub updated_at: String,
    /// The actor subject that wrote it (`operator` or a principal).
    pub updated_by: String,
}

// The handle names somebody's inbox; it stays out of logs and test output.
impl std::fmt::Debug for StoredAgentHookApprover {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredAgentHookApprover")
            .field("organization_id", &self.organization_id)
            .field("approver_ref", &self.approver_ref.as_ref().map(|_| "…"))
            .field("version", &self.version)
            .field("updated_at", &self.updated_at)
            .field("updated_by", &self.updated_by)
            .finish()
    }
}

/// A replacement: the handle to store (`None` clears it), and the version it
/// was made against (0: nothing is stored yet).
pub struct AgentHookApproverWrite<'a> {
    pub organization_id: &'a str,
    pub approver_ref: Option<&'a str>,
    pub expected_version: i64,
    pub updated_by: &'a str,
}

/// The audit event committed with a replacement.
pub struct AgentHookApproverAudit<'a> {
    pub event_type: &'a str,
    pub payload_json: &'a str,
}

/// How a compare-and-set replacement ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentHookApproverWriteOutcome {
    /// Stored; the row as it now stands.
    Written(StoredAgentHookApprover),
    /// Another write landed first; nothing changed. The version now stored
    /// (0 when there is still no row).
    Conflict { current_version: i64 },
}

fn stored(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<StoredAgentHookApprover> {
    Ok(StoredAgentHookApprover {
        organization_id: row.try_get("organization_id")?,
        approver_ref: row.try_get("approver_ref")?,
        version: row.try_get("version")?,
        updated_at: row.try_get("updated_at")?,
        updated_by: row.try_get("updated_by")?,
    })
}

const SELECT: &str = "SELECT organization_id, approver_ref, version, updated_at, updated_by \
                      FROM agent_hook_approvers WHERE organization_id = ?";

impl Db {
    /// The organization's stored approver, if it has a row.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn agent_hook_approver(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<StoredAgentHookApprover>> {
        sqlx::query(SELECT)
            .bind(organization_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(stored)
            .transpose()
    }

    /// Replace the organization's approver when `expected_version` is still
    /// the stored version (0: only when none is stored), committing `audit`
    /// to the outbox in the same transaction. A lost race changes nothing and
    /// appends nothing.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails, or the handle is not an
    /// `inbox_` handle of a plausible length; nothing is committed.
    pub async fn put_agent_hook_approver(
        &self,
        write: &AgentHookApproverWrite<'_>,
        audit: &AgentHookApproverAudit<'_>,
    ) -> anyhow::Result<AgentHookApproverWriteOutcome> {
        anyhow::ensure!(
            write.expected_version >= 0,
            "an expected approver version is never negative"
        );
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let written = if write.expected_version == 0 {
            sqlx::query(
                "INSERT INTO agent_hook_approvers \
                 (organization_id, approver_ref, version, updated_at, updated_by) \
                 VALUES (?, ?, 1, ?, ?) ON CONFLICT(organization_id) DO NOTHING",
            )
            .bind(write.organization_id)
            .bind(write.approver_ref)
            .bind(&now)
            .bind(write.updated_by)
            .execute(&mut *transaction)
            .await?
        } else {
            sqlx::query(
                "UPDATE agent_hook_approvers \
                 SET approver_ref = ?, version = version + 1, updated_at = ?, updated_by = ? \
                 WHERE organization_id = ? AND version = ?",
            )
            .bind(write.approver_ref)
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
            return Ok(AgentHookApproverWriteOutcome::Conflict {
                current_version: row.map_or(0, |row| row.version),
            });
        }
        let row = row.ok_or_else(|| anyhow::anyhow!("written agent-hooks approver vanished"))?;
        append_outbox_event_in(
            &mut transaction,
            Some(write.organization_id),
            audit.event_type,
            audit.payload_json,
        )
        .await?;
        transaction.commit().await?;
        Ok(AgentHookApproverWriteOutcome::Written(row))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "org_agent_hooks";
    const REF: &str = "inbox_YXBwcm92ZXI.test-tag";
    const AUDIT: AgentHookApproverAudit<'static> = AgentHookApproverAudit {
        event_type: "agent_hooks.approver.updated",
        payload_json: "{\"organization_id\":\"org_agent_hooks\"}",
    };

    fn write(approver_ref: Option<&str>, expected_version: i64) -> AgentHookApproverWrite<'_> {
        AgentHookApproverWrite {
            organization_id: ORG,
            approver_ref,
            expected_version,
            updated_by: "operator",
        }
    }

    async fn audit_rows(db: &Db) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM outbox_events WHERE event_type = 'agent_hooks.approver.updated'",
        )
        .fetch_one(db.pool())
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn an_organization_without_an_approver_reads_none() {
        let db = Db::connect_memory().await.unwrap();
        assert_eq!(db.agent_hook_approver(ORG).await.unwrap(), None);
    }

    #[tokio::test]
    async fn writes_are_compare_and_set_and_audited_with_the_row() {
        let db = Db::connect_memory().await.unwrap();
        let first = db
            .put_agent_hook_approver(&write(Some(REF), 0), &AUDIT)
            .await
            .unwrap();
        let AgentHookApproverWriteOutcome::Written(first) = first else {
            panic!("the first write against version 0 lands");
        };
        assert_eq!(
            (first.version, first.approver_ref.as_deref()),
            (1, Some(REF))
        );
        assert_eq!(audit_rows(&db).await, 1);

        for stale in [0, 2] {
            let outcome = db
                .put_agent_hook_approver(&write(Some("inbox_other-handle"), stale), &AUDIT)
                .await
                .unwrap();
            assert_eq!(
                outcome,
                AgentHookApproverWriteOutcome::Conflict { current_version: 1 }
            );
        }
        assert_eq!(audit_rows(&db).await, 1, "a lost race appends nothing");
        assert_eq!(
            db.agent_hook_approver(ORG)
                .await
                .unwrap()
                .unwrap()
                .approver_ref
                .as_deref(),
            Some(REF),
            "a lost race changes nothing"
        );

        // Clearing keeps the row and keeps the version rising.
        let cleared = db
            .put_agent_hook_approver(&write(None, 1), &AUDIT)
            .await
            .unwrap();
        let AgentHookApproverWriteOutcome::Written(cleared) = cleared else {
            panic!("a replacement against the stored version lands");
        };
        assert_eq!((cleared.version, cleared.approver_ref), (2, None));
        assert_eq!(
            db.agent_hook_approver(ORG).await.unwrap().unwrap().version,
            2
        );
        assert_eq!(audit_rows(&db).await, 2);
    }

    #[tokio::test]
    async fn a_replacement_with_nothing_stored_is_a_conflict_at_zero() {
        let db = Db::connect_memory().await.unwrap();
        let outcome = db
            .put_agent_hook_approver(&write(Some(REF), 3), &AUDIT)
            .await
            .unwrap();
        assert_eq!(
            outcome,
            AgentHookApproverWriteOutcome::Conflict { current_version: 0 }
        );
        assert!(db
            .put_agent_hook_approver(&write(Some(REF), -1), &AUDIT)
            .await
            .is_err());
        assert_eq!(db.agent_hook_approver(ORG).await.unwrap(), None);
    }

    #[tokio::test]
    async fn the_table_refuses_what_is_not_an_inbox_handle() {
        let db = Db::connect_memory().await.unwrap();
        for bad in [
            "",
            "inbox",
            "inbox_",
            "inboxXabcdefgh",
            "https://elsewhere.example/x",
        ] {
            assert!(
                db.put_agent_hook_approver(&write(Some(bad), 0), &AUDIT)
                    .await
                    .is_err(),
                "{bad:?}"
            );
        }
        let long = format!("inbox_{}", "a".repeat(260));
        assert!(db
            .put_agent_hook_approver(&write(Some(&long), 0), &AUDIT)
            .await
            .is_err());
        assert_eq!(db.agent_hook_approver(ORG).await.unwrap(), None);
        assert_eq!(audit_rows(&db).await, 0, "a refused write appends nothing");
    }

    #[tokio::test]
    async fn organizations_do_not_share_an_approver_and_debug_hides_the_handle() {
        let db = Db::connect_memory().await.unwrap();
        db.put_agent_hook_approver(&write(Some(REF), 0), &AUDIT)
            .await
            .unwrap();
        assert_eq!(db.agent_hook_approver("org_other").await.unwrap(), None);
        let row = db.agent_hook_approver(ORG).await.unwrap().unwrap();
        assert!(!format!("{row:?}").contains(REF));
    }
}
