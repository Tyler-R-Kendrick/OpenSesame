//! What the Host's web-login runner reads and writes (ADR 0076, ADR 0159):
//! the recipes it may replay ([`recipes`]), and the agent-hooks record of each
//! run. There is one writer of recipes, [`recipes`], which derives a recipe's
//! trust from a verification and never takes one as an input.
//!
//! Neither table can hold a credential. A recipe is selectors and a URL — a
//! statement about a site, the same for every user of it — and a hook record
//! is the payload-free projection of one interception: point, decision,
//! reason, digests. Both shapes are enforced by what the rows *have*, not by
//! a check somewhere else.

use anyhow::Context;
use sqlx::{sqlite::SqliteRow, Row};

use crate::Db;

/// Retention and orphan reconciliation of the runs this module's records
/// belong to.
pub mod retention;

mod recipe_rows;
/// The writer and the replay rule for recipes: what a run may replay, and
/// the verification that decides it (ADR 0076 §4).
pub mod recipes;

/// The keys an organization trusts to sign recipes.
pub mod signers;

/// Trust levels a run may replay unattended (rotation-recipe-schema.md,
/// "Signing and trust"). A `candidate` is a hypothesis and never is.
pub const REPLAYABLE_TRUST: [&str; 2] = ["canary_verified", "corpus"];

/// One interception, as a hosted run's audit keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAgentHookRecord {
    pub run_id: String,
    pub organization_id: String,
    /// The session's `sequence`: a total order within the run.
    pub sequence: i64,
    pub interception_point: String,
    /// `allow`, `deny` or `transform`.
    pub decision: String,
    /// The deny carried an approval block (an escalation).
    pub escalated: bool,
    /// A short machine identifier, or `None`. Never prose.
    pub reason: Option<String>,
    /// The registration index of the deciding interceptor.
    pub decided_by: Option<i64>,
    /// `sha256:` digests of the context before and after composition.
    pub input_identity: Option<String>,
    pub enforced_identity: Option<String>,
    /// The organization's hook-policy version the run decided under.
    pub policy_version: i64,
    pub recorded_at: String,
}

pub(crate) fn record_from_row(row: &SqliteRow) -> StoredAgentHookRecord {
    StoredAgentHookRecord {
        run_id: row.get("run_id"),
        organization_id: row.get("organization_id"),
        sequence: row.get("sequence"),
        interception_point: row.get("interception_point"),
        decision: row.get("decision"),
        escalated: row.get::<i64, _>("escalated") != 0,
        reason: row.get("reason"),
        decided_by: row.get("decided_by"),
        input_identity: row.get("input_identity"),
        enforced_identity: row.get("enforced_identity"),
        policy_version: row.get("policy_version"),
        recorded_at: row.get("recorded_at"),
    }
}

impl Db {
    /// Append a run's hook records, all or none.
    ///
    /// # Errors
    ///
    /// Propagates database failures. A repeated `sequence` for the run is a
    /// constraint failure, never an overwrite: the record of what a run was
    /// allowed to do is append-only.
    pub async fn append_agent_hook_records(
        &self,
        records: &[StoredAgentHookRecord],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool().begin().await?;
        for record in records {
            sqlx::query(
                "INSERT INTO agent_hook_records \
                 (run_id, organization_id, sequence, interception_point, decision, escalated, \
                  reason, decided_by, input_identity, enforced_identity, policy_version, \
                  recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&record.run_id)
            .bind(&record.organization_id)
            .bind(record.sequence)
            .bind(&record.interception_point)
            .bind(&record.decision)
            .bind(i64::from(record.escalated))
            .bind(&record.reason)
            .bind(record.decided_by)
            .bind(&record.input_identity)
            .bind(&record.enforced_identity)
            .bind(record.policy_version)
            .bind(&record.recorded_at)
            .execute(&mut *tx)
            .await
            .context("append agent-hook record")?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// A run's hook records, in `sequence` order.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn agent_hook_records(
        &self,
        organization_id: &str,
        run_id: &str,
    ) -> anyhow::Result<Vec<StoredAgentHookRecord>> {
        let rows = sqlx::query(
            "SELECT run_id, organization_id, sequence, interception_point, decision, escalated, \
             reason, decided_by, input_identity, enforced_identity, policy_version, recorded_at \
             FROM agent_hook_records WHERE organization_id = ? AND run_id = ? \
             ORDER BY sequence ASC",
        )
        .bind(organization_id)
        .bind(run_id)
        .fetch_all(self.pool())
        .await
        .context("read agent-hook records")?;
        Ok(rows.iter().map(record_from_row).collect())
    }
}
