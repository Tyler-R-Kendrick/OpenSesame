//! What the Host's web-login runner reads and writes (ADR 0076, ADR 0150):
//! the recipes it may replay, and the agent-hooks record of each run.
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

/// Trust levels a run may replay unattended (rotation-recipe-schema.md,
/// "Signing and trust"). A `candidate` is a hypothesis and never is.
pub const REPLAYABLE_TRUST: [&str; 2] = ["canary_verified", "corpus"];

/// One recipe row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredWebLoginRecipe {
    pub organization_id: String,
    /// The relying party's origin, as the rotation target names it.
    pub origin: String,
    pub recipe_id: String,
    /// `candidate`, `canary_verified` or `corpus`.
    pub trust: String,
    /// The executor's projection: change URL and selectors, as JSON.
    pub recipe_json: String,
    pub expires_at: String,
    pub created_at: String,
    pub updated_at: String,
}

fn recipe_from_row(row: &SqliteRow) -> StoredWebLoginRecipe {
    StoredWebLoginRecipe {
        organization_id: row.get("organization_id"),
        origin: row.get("origin"),
        recipe_id: row.get("recipe_id"),
        trust: row.get("trust"),
        recipe_json: row.get("recipe_json"),
        expires_at: row.get("expires_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

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

const RECIPE_COLUMNS: &str = "organization_id, origin, recipe_id, trust, recipe_json, \
     expires_at, created_at, updated_at";

impl Db {
    /// Store the organization's recipe for an origin, replacing any earlier
    /// one.
    ///
    /// # Errors
    ///
    /// Propagates database failures, including a trust level the schema does
    /// not know.
    pub async fn put_web_login_recipe(&self, recipe: &StoredWebLoginRecipe) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO web_login_recipes \
             (organization_id, origin, recipe_id, trust, recipe_json, expires_at, created_at, \
              updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, origin) DO UPDATE SET \
               recipe_id = excluded.recipe_id, trust = excluded.trust, \
               recipe_json = excluded.recipe_json, expires_at = excluded.expires_at, \
               updated_at = excluded.updated_at",
        )
        .bind(&recipe.organization_id)
        .bind(&recipe.origin)
        .bind(&recipe.recipe_id)
        .bind(&recipe.trust)
        .bind(&recipe.recipe_json)
        .bind(&recipe.expires_at)
        .bind(&recipe.created_at)
        .bind(&recipe.updated_at)
        .execute(self.pool())
        .await
        .context("store web-login recipe")?;
        Ok(())
    }

    /// The recipe a run may replay for `origin` at `now`: trusted beyond a
    /// candidate, and not expired. `None` otherwise — a stale or unverified
    /// recipe is the same as none, because replaying it unattended is what
    /// the trust ladder exists to prevent.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn replayable_web_login_recipe(
        &self,
        organization_id: &str,
        origin: &str,
        now: &str,
    ) -> anyhow::Result<Option<StoredWebLoginRecipe>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {RECIPE_COLUMNS} FROM web_login_recipes \
             WHERE organization_id = ? AND origin = ? AND trust IN (?, ?) AND expires_at > ?"
        );
        let row = sqlx::query(&sql)
            .bind(organization_id)
            .bind(origin)
            .bind(REPLAYABLE_TRUST[0])
            .bind(REPLAYABLE_TRUST[1])
            .bind(now)
            .fetch_optional(self.pool())
            .await
            .context("read web-login recipe")?;
        Ok(row.as_ref().map(recipe_from_row))
    }

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
