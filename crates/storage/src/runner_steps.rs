//! The step queue a local driver claims from (ADR 0079 §4).
//!
//! One step deep per run, on purpose: a browser has one DOM, and a queue that
//! could hold two steps for one page would be a queue that could reorder them.
//!
//! Three rules are enforced here rather than by a caller, because each one is a
//! way a second actor could take a step that is not theirs:
//!
//! - a step is claimed under a lease, so a driver that crashed releases by the
//!   clock rather than by a liveness check;
//! - only the claimant may settle it; and
//! - a settled step always carries an outcome, because one without is a step
//!   the executor waits on forever.

use anyhow::Context;
use sqlx::{sqlite::SqliteRow, Row};

use crate::Db;

/// How long a claim is held before the step becomes claimable again.
pub const STEP_CLAIM_SECONDS: i64 = 120;

/// One queued step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRunnerStep {
    pub run_id: String,
    pub organization_id: String,
    pub seq: i64,
    /// The `StepRequest`, as JSON.
    pub request_json: String,
    /// `pending`, `claimed`, or `settled`.
    pub state: String,
    pub claimed_by: Option<String>,
    pub claim_expires_at: Option<String>,
    /// The `StepOutcome`, as JSON. Present exactly when settled.
    pub outcome_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn step_from_row(row: &SqliteRow) -> StoredRunnerStep {
    StoredRunnerStep {
        run_id: row.get("run_id"),
        organization_id: row.get("organization_id"),
        seq: row.get("seq"),
        request_json: row.get("request_json"),
        state: row.get("state"),
        claimed_by: row.get("claimed_by"),
        claim_expires_at: row.get("claim_expires_at"),
        outcome_json: row.get("outcome_json"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

const STEP_COLUMNS: &str = "run_id, organization_id, seq, request_json, state, claimed_by, \
     claim_expires_at, outcome_json, created_at, updated_at";

/// Whether `text` is a JSON object with a string `outcome` tag: the least any
/// stored outcome is, and the shape both decoders (`StepOutcome`, the custody
/// outcomes) start from.
fn is_tagged_outcome(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .is_some_and(|value| {
            value
                .get("outcome")
                .is_some_and(serde_json::Value::is_string)
        })
}

impl Db {
    /// Enqueue one step for a run.
    ///
    /// # Errors
    ///
    /// Fails when the run already has an unsettled step. The executor issues
    /// one and waits, so a second pending step means two things believe they
    /// are driving — which is the condition this refuses rather than records.
    pub async fn enqueue_runner_step(
        &self,
        organization_id: &str,
        run_id: &str,
        seq: i64,
        request_json: &str,
        now: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool().begin().await?;
        // A step is enqueued only while the agent holds the page
        // (`agent_driving`, or `handoff_requested` until its next safe point).
        // Once a run is parked for a person, has one driving it, or has
        // stopped, nothing may be queued for the browser it would otherwise
        // drive — the check lives here, at the queue, so no caller has to
        // remember it.
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM observation_runs WHERE organization_id=? AND id=? \
             AND closed_at IS NULL AND control_state IN ('agent_driving', 'handoff_requested')",
        )
        .bind(organization_id)
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?;
        anyhow::ensure!(
            active == 1,
            "run is closed, parked, or held by a person, and takes no new step"
        );
        let outstanding: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM runner_steps \
             WHERE organization_id = ? AND run_id = ? AND state <> 'settled'",
        )
        .bind(organization_id)
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await
        .context("count outstanding steps")?;
        anyhow::ensure!(
            outstanding == 0,
            "run `{run_id}` already has an unsettled step"
        );
        sqlx::query(
            "INSERT INTO runner_steps \
             (run_id, organization_id, seq, request_json, state, claimed_by, claim_expires_at, \
              outcome_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)",
        )
        .bind(run_id)
        .bind(organization_id)
        .bind(seq)
        .bind(request_json)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .context("enqueue runner step")?;
        tx.commit().await?;
        Ok(())
    }

    /// Claim the run's outstanding step, if there is one to claim.
    ///
    /// Returns `None` when nothing is pending or the current claim is still
    /// live and belongs to somebody else.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn claim_runner_step(
        &self,
        organization_id: &str,
        run_id: &str,
        claimant: &str,
        now: &str,
        expires_at: &str,
    ) -> anyhow::Result<Option<StoredRunnerStep>> {
        // Claimable means pending, or claimed under a lease that has lapsed —
        // which is how a crashed driver releases its work without anyone
        // deciding it is dead.
        let outcome = sqlx::query(
            "UPDATE runner_steps SET state = 'claimed', claimed_by = ?, claim_expires_at = ?, \
             updated_at = ? \
             WHERE organization_id = ? AND run_id = ? AND state <> 'settled' \
             AND (state = 'pending' OR claim_expires_at <= ?) \
             AND EXISTS (SELECT 1 FROM observation_runs WHERE observation_runs.id=runner_steps.run_id \
                 AND observation_runs.organization_id=runner_steps.organization_id \
                 AND closed_at IS NULL AND control_state IN ('agent_driving', 'handoff_requested'))",
        )
        .bind(claimant)
        .bind(expires_at)
        .bind(now)
        .bind(organization_id)
        .bind(run_id)
        .bind(now)
        .execute(self.pool())
        .await
        .context("claim runner step")?;
        if outcome.rows_affected() == 0 {
            return Ok(None);
        }
        self.outstanding_runner_step(organization_id, run_id).await
    }

    /// The run's unsettled step, whatever its state.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn outstanding_runner_step(
        &self,
        organization_id: &str,
        run_id: &str,
    ) -> anyhow::Result<Option<StoredRunnerStep>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {STEP_COLUMNS} FROM runner_steps \
             WHERE organization_id = ? AND run_id = ? AND state <> 'settled' \
             ORDER BY seq ASC LIMIT 1"
        );
        let row = sqlx::query(&sql)
            .bind(organization_id)
            .bind(run_id)
            .fetch_optional(self.pool())
            .await
            .context("read outstanding runner step")?;
        Ok(row.as_ref().map(step_from_row))
    }

    /// One step by position, settled or not.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn get_runner_step(
        &self,
        organization_id: &str,
        run_id: &str,
        seq: i64,
    ) -> anyhow::Result<Option<StoredRunnerStep>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {STEP_COLUMNS} FROM runner_steps \
             WHERE organization_id = ? AND run_id = ? AND seq = ?"
        );
        let row = sqlx::query(&sql)
            .bind(organization_id)
            .bind(run_id)
            .bind(seq)
            .fetch_optional(self.pool())
            .await
            .context("read runner step")?;
        Ok(row.as_ref().map(step_from_row))
    }

    /// Record a step's outcome. Only the claimant may, only while its claim is
    /// live (`claim_expires_at > now`), and only while the run is open.
    ///
    /// Returns whether the settle applied. `false` means the caller does not
    /// hold the claim — because it lapsed (whether or not somebody else has
    /// reclaimed it yet: the lease is the clock, not the next claimant) or
    /// because it was never theirs — or the run is closed: an executor that
    /// stopped waiting reads nothing more, so nothing more is stored for it.
    /// The expiry is part of the one atomic `UPDATE`, so a driver that checks
    /// its lease and settles cannot be raced by the clock between the two.
    ///
    /// The outcome must be a JSON object carrying a string `outcome` tag. What
    /// else it may hold depends on the step it answers, which only the caller
    /// (the Host's settle route, which has the typed `StepOutcome`) can judge;
    /// this refuses only what could never be an outcome at all.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn settle_runner_step(
        &self,
        organization_id: &str,
        run_id: &str,
        seq: i64,
        claimant: &str,
        outcome_json: &str,
        now: &str,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            is_tagged_outcome(outcome_json),
            "outcome is not a tagged object"
        );
        let outcome = sqlx::query(
            "UPDATE runner_steps SET state = 'settled', outcome_json = ?, updated_at = ? \
             WHERE organization_id = ? AND run_id = ? AND seq = ? AND state = 'claimed' \
             AND claimed_by = ? AND claim_expires_at > ? AND EXISTS (SELECT 1 FROM observation_runs \
               WHERE observation_runs.id = runner_steps.run_id \
               AND observation_runs.organization_id = runner_steps.organization_id \
               AND closed_at IS NULL)",
        )
        .bind(outcome_json)
        .bind(now)
        .bind(organization_id)
        .bind(run_id)
        .bind(seq)
        .bind(claimant)
        .bind(now)
        .execute(self.pool())
        .await
        .context("settle runner step")?;
        Ok(outcome.rows_affected() > 0)
    }

    /// Replace a settled step's outcome with the form the executor accepted.
    ///
    /// The settle route stores what the driver reported; once the executor
    /// has read it, this puts back only what it decoded, with any
    /// credential-shaped text already redacted — so the queue does not keep,
    /// for the life of the run, a value a driver should never have sent.
    /// Only a settled step is rewritten, and never to an empty outcome.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn replace_settled_runner_step_outcome(
        &self,
        organization_id: &str,
        run_id: &str,
        seq: i64,
        outcome_json: &str,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            is_tagged_outcome(outcome_json),
            "outcome is not a tagged object"
        );
        let outcome = sqlx::query(
            "UPDATE runner_steps SET outcome_json = ? \
             WHERE organization_id = ? AND run_id = ? AND seq = ? AND state = 'settled'",
        )
        .bind(outcome_json)
        .bind(organization_id)
        .bind(run_id)
        .bind(seq)
        .execute(self.pool())
        .await
        .context("rewrite runner step outcome")?;
        Ok(outcome.rows_affected() > 0)
    }
}
