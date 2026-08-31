//! Persistence for the sealed observation log (ADR 0081).
//!
//! One log per sandboxed run. The live viewer tails it, the replay overlay
//! seeks in it, and neither has a second pipeline — which is what keeps the
//! live path from skipping a redaction the recorded path applies.
//!
//! Two invariants live here rather than in a caller:
//!
//! - **Sequence allocation is transactional.** `next_seq` is read and bumped in
//!   the same transaction as the insert, so two runners appending concurrently
//!   cannot mint the same position and silently overwrite one another.
//! - **Control transitions are version-guarded.** A lease grant writes only
//!   when the version it read is still current, so "exactly one driver" holds
//!   across gateway processes rather than only within one.
//!
//! There is no plaintext column. The runner seals every event to the owner's
//! viewer key before it arrives, so the gateway relays bodies it cannot read.

use anyhow::Context;
use sqlx::{sqlite::SqliteRow, Row};

use crate::Db;

/// Events returned by one read. A viewer that falls behind seeks forward rather
/// than accruing an unbounded buffer.
pub const OBSERVATION_READ_LIMIT: usize = 256;

/// Longest value-blind hint persisted against a run.
pub const MAX_BLOCKED_REASON_CHARS: usize = 160;

/// A sandboxed run being observed, and the control lease projected onto it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredObservationRun {
    pub id: String,
    pub organization_id: String,
    pub job_id: String,
    /// The relying party's origin. Never an account.
    pub target_origin: String,
    /// `t3` (deterministic, no model) or `t4` (agentic).
    pub tier: String,
    /// `crates/session-observe`'s `ControlState`, as its wire name.
    pub control_state: String,
    /// `quiescent` or `critical`.
    pub quiescence: String,
    pub handoff_queued: bool,
    pub lease_holder: Option<String>,
    pub lease_expires_at: Option<String>,
    pub owner_principal_id: String,
    pub viewer_key_id: String,
    pub next_seq: i64,
    pub blocked_reason: Option<String>,
    pub expires_at: String,
    pub closed_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One sealed entry in a run's log.
///
/// `payload` is ciphertext. The struct has no field able to hold anything else,
/// and `Debug` renders its length rather than its bytes — a sealed body is
/// still somebody's account, and a log line is the classic way one escapes.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredObservationEvent {
    pub run_id: String,
    pub organization_id: String,
    pub seq: i64,
    /// `action`, `thought`, or `frame`.
    pub lane: String,
    /// Thought lane only: the action this rationale precedes.
    pub of_step: Option<i64>,
    /// Frame lane only: the layout generation the frame was composited under.
    pub layout_epoch: Option<i64>,
    pub payload: Vec<u8>,
    pub recorded_at: String,
}

impl std::fmt::Debug for StoredObservationEvent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredObservationEvent")
            .field("run_id", &self.run_id)
            .field("organization_id", &self.organization_id)
            .field("seq", &self.seq)
            .field("lane", &self.lane)
            .field("of_step", &self.of_step)
            .field("layout_epoch", &self.layout_epoch)
            .field("payload_len", &self.payload.len())
            .field("recorded_at", &self.recorded_at)
            .finish()
    }
}

/// One event to append.
///
/// A struct rather than seven positional arguments, so a caller cannot swap
/// `of_step` and `layout_epoch` — two `Option<i64>` next to each other in a
/// signature is a transposition waiting to happen, and the schema would accept
/// the result only to store a thought that claims to be a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObservationAppend<'a> {
    pub organization_id: &'a str,
    pub run_id: &'a str,
    /// `action`, `thought`, or `frame`.
    pub lane: &'a str,
    /// Thought lane only.
    pub of_step: Option<i64>,
    /// Frame lane only.
    pub layout_epoch: Option<i64>,
    /// Ciphertext, sealed by the runner before it got here.
    pub payload: &'a [u8],
    pub recorded_at: &'a str,
}

/// A control transition to persist, guarded by the version it was decided on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationControlUpdate {
    pub run_id: String,
    pub organization_id: String,
    /// The version the caller read before deciding. A mismatch means somebody
    /// else moved the lease first, and the caller re-reads rather than winning.
    pub expected_version: i64,
    pub control_state: String,
    pub quiescence: String,
    pub handoff_queued: bool,
    pub lease_holder: Option<String>,
    pub lease_expires_at: Option<String>,
    pub blocked_reason: Option<String>,
}

fn run_from_row(row: &SqliteRow) -> StoredObservationRun {
    StoredObservationRun {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        job_id: row.get("job_id"),
        target_origin: row.get("target_origin"),
        tier: row.get("tier"),
        control_state: row.get("control_state"),
        quiescence: row.get("quiescence"),
        handoff_queued: row.get::<i64, _>("handoff_queued") != 0,
        lease_holder: row.get("lease_holder"),
        lease_expires_at: row.get("lease_expires_at"),
        owner_principal_id: row.get("owner_principal_id"),
        viewer_key_id: row.get("viewer_key_id"),
        next_seq: row.get("next_seq"),
        blocked_reason: row.get("blocked_reason"),
        expires_at: row.get("expires_at"),
        closed_at: row.get("closed_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn event_from_row(row: &SqliteRow) -> StoredObservationEvent {
    StoredObservationEvent {
        run_id: row.get("run_id"),
        organization_id: row.get("organization_id"),
        seq: row.get("seq"),
        lane: row.get("lane"),
        of_step: row.get("of_step"),
        layout_epoch: row.get("layout_epoch"),
        payload: row.get("ciphertext"),
        recorded_at: row.get("recorded_at"),
    }
}

const RUN_COLUMNS: &str = "id, organization_id, job_id, target_origin, tier, control_state, \
     quiescence, handoff_queued, lease_holder, lease_expires_at, owner_principal_id, \
     viewer_key_id, next_seq, blocked_reason, expires_at, closed_at, version, created_at, \
     updated_at";

impl Db {
    /// Open a run. Idempotent on `id`, so a runner that retries its own start
    /// does not fork the log.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn create_observation_run(&self, run: &StoredObservationRun) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT OR IGNORE INTO observation_runs \
             (id, organization_id, job_id, target_origin, tier, control_state, quiescence, \
              handoff_queued, lease_holder, lease_expires_at, owner_principal_id, viewer_key_id, \
              next_seq, blocked_reason, expires_at, closed_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&run.id)
        .bind(&run.organization_id)
        .bind(&run.job_id)
        .bind(&run.target_origin)
        .bind(&run.tier)
        .bind(&run.control_state)
        .bind(&run.quiescence)
        .bind(i64::from(run.handoff_queued))
        .bind(&run.lease_holder)
        .bind(&run.lease_expires_at)
        .bind(&run.owner_principal_id)
        .bind(&run.viewer_key_id)
        .bind(run.next_seq)
        .bind(&run.blocked_reason)
        .bind(&run.expires_at)
        .bind(&run.closed_at)
        .bind(run.version)
        .bind(&run.created_at)
        .bind(&run.updated_at)
        .execute(self.pool())
        .await
        .context("create observation run")?;
        Ok(())
    }

    /// One run, scoped to its tenant.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn get_observation_run(
        &self,
        organization_id: &str,
        run_id: &str,
    ) -> anyhow::Result<Option<StoredObservationRun>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {RUN_COLUMNS} FROM observation_runs WHERE organization_id = ? AND id = ?"
        );
        let row = sqlx::query(&sql)
            .bind(organization_id)
            .bind(run_id)
            .fetch_optional(self.pool())
            .await
            .context("get observation run")?;
        Ok(row.as_ref().map(run_from_row))
    }

    /// Runs for a tenant, newest first.
    ///
    /// Metadata only. ADR 0076 §5 keeps recording bodies out of any listing,
    /// and this returns the run row rather than reaching into its log.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn list_observation_runs(
        &self,
        organization_id: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<StoredObservationRun>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {RUN_COLUMNS} FROM observation_runs WHERE organization_id = ? \
             ORDER BY created_at DESC, id DESC LIMIT ?"
        );
        let rows = sqlx::query(&sql)
            .bind(organization_id)
            .bind(limit.clamp(1, 200))
            .fetch_all(self.pool())
            .await
            .context("list observation runs")?;
        Ok(rows.iter().map(run_from_row).collect())
    }

    /// Append one sealed event, allocating its position under the same
    /// transaction that writes it.
    ///
    /// Returns the sequence number the event landed at.
    ///
    /// # Errors
    ///
    /// Fails when the run is unknown or closed, and propagates database
    /// failures. A closed run refuses appends rather than growing after its
    /// receipt was written.
    pub async fn append_observation_event(
        &self,
        append: &ObservationAppend<'_>,
    ) -> anyhow::Result<i64> {
        let ObservationAppend {
            organization_id,
            run_id,
            lane,
            of_step,
            layout_epoch,
            payload,
            recorded_at,
        } = *append;
        anyhow::ensure!(!payload.is_empty(), "observation payload is empty");
        let mut tx = self.pool().begin().await?;
        let row = sqlx::query(
            "SELECT next_seq, closed_at FROM observation_runs \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await
        .context("read observation run cursor")?;
        let row = row.ok_or_else(|| anyhow::anyhow!("observation run `{run_id}` not found"))?;
        if row.get::<Option<String>, _>("closed_at").is_some() {
            anyhow::bail!("observation run `{run_id}` is closed");
        }
        let seq: i64 = row.get("next_seq");
        sqlx::query(
            "INSERT INTO observation_events \
             (run_id, organization_id, seq, lane, of_step, layout_epoch, ciphertext, recorded_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(run_id)
        .bind(organization_id)
        .bind(seq)
        .bind(lane)
        .bind(of_step)
        .bind(layout_epoch)
        .bind(payload)
        .bind(recorded_at)
        .execute(&mut *tx)
        .await
        .context("append observation event")?;
        sqlx::query(
            "UPDATE observation_runs SET next_seq = ?, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(seq + 1)
        .bind(recorded_at)
        .bind(organization_id)
        .bind(run_id)
        .execute(&mut *tx)
        .await
        .context("advance observation cursor")?;
        tx.commit().await?;
        Ok(seq)
    }

    /// Read forward from `after_seq` — the one operation both readers use.
    ///
    /// A live viewer calls it with its last position and gets the tail; the
    /// replay overlay calls it with an earlier one and gets a seek.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn read_observation_events(
        &self,
        organization_id: &str,
        run_id: &str,
        after_seq: i64,
        limit: usize,
    ) -> anyhow::Result<Vec<StoredObservationEvent>> {
        let capped = i64::try_from(limit.clamp(1, OBSERVATION_READ_LIMIT)).unwrap_or(1);
        let rows = sqlx::query(
            "SELECT run_id, organization_id, seq, lane, of_step, layout_epoch, ciphertext, \
             recorded_at FROM observation_events \
             WHERE organization_id = ? AND run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        )
        .bind(organization_id)
        .bind(run_id)
        .bind(after_seq)
        .bind(capped)
        .fetch_all(self.pool())
        .await
        .context("read observation events")?;
        Ok(rows.iter().map(event_from_row).collect())
    }

    /// Persist a control transition, but only if nobody moved first.
    ///
    /// Returns the new run state on success and `None` when the version was
    /// stale — the caller re-reads and re-decides rather than overwriting a
    /// grant it did not see.
    ///
    /// # Errors
    ///
    /// Propagates database failures. A transition the schema refuses (a driver
    /// named without a driving state, a lease with no expiry) surfaces as a
    /// constraint error rather than being written.
    pub async fn update_observation_control(
        &self,
        update: &ObservationControlUpdate,
        now: &str,
    ) -> anyhow::Result<Option<StoredObservationRun>> {
        let reason = update
            .blocked_reason
            .as_deref()
            .map(|hint| truncate_chars(hint, MAX_BLOCKED_REASON_CHARS));
        let outcome = sqlx::query(
            "UPDATE observation_runs SET control_state = ?, quiescence = ?, handoff_queued = ?, \
             lease_holder = ?, lease_expires_at = ?, blocked_reason = ?, version = version + 1, \
             updated_at = ? WHERE organization_id = ? AND id = ? AND version = ? \
             AND closed_at IS NULL",
        )
        .bind(&update.control_state)
        .bind(&update.quiescence)
        .bind(i64::from(update.handoff_queued))
        .bind(&update.lease_holder)
        .bind(&update.lease_expires_at)
        .bind(reason)
        .bind(now)
        .bind(&update.organization_id)
        .bind(&update.run_id)
        .bind(update.expected_version)
        .execute(self.pool())
        .await
        .context("update observation control")?;
        if outcome.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_observation_run(&update.organization_id, &update.run_id)
            .await
    }

    /// Close a run. Appends are refused afterwards.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn close_observation_run(
        &self,
        organization_id: &str,
        run_id: &str,
        closed_at: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE observation_runs SET closed_at = ?, updated_at = ?, version = version + 1 \
             WHERE organization_id = ? AND id = ? AND closed_at IS NULL",
        )
        .bind(closed_at)
        .bind(closed_at)
        .bind(organization_id)
        .bind(run_id)
        .execute(self.pool())
        .await
        .context("close observation run")?;
        Ok(())
    }

    /// Drop runs past their retention window, and their logs with them.
    ///
    /// ADR 0076 §5's retention default is the observation window, not forever.
    /// Returns how many runs were removed.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn purge_expired_observation_runs(&self, now: &str) -> anyhow::Result<u64> {
        // The events table cascades, but SQLite enforces that only with foreign
        // keys switched on, so the child rows are deleted explicitly first.
        sqlx::query(
            "DELETE FROM observation_events WHERE run_id IN \
             (SELECT id FROM observation_runs WHERE expires_at <= ?)",
        )
        .bind(now)
        .execute(self.pool())
        .await
        .context("purge observation events")?;
        let outcome = sqlx::query("DELETE FROM observation_runs WHERE expires_at <= ?")
            .bind(now)
            .execute(self.pool())
            .await
            .context("purge observation runs")?;
        Ok(outcome.rows_affected())
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}
