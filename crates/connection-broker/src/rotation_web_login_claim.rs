//! Who owns a web-login job (ADR 0076 §9, ADR 0156).
//!
//! A web-login job has two possible owners: the generic rotation consumer,
//! which parks it with "requires a configured sandbox runner", and the Host's
//! runner, which drives it. Both used to find the job `scheduled` and then
//! write unconditionally, so both could win — a parked job with a run driving
//! it, or a run that never started because the consumer got there first.
//!
//! Ownership is now decided by one conditional write, scoped to the
//! organization: `UPDATE … WHERE state = 'scheduled'`, and whoever changes the
//! row owns it. The runner does not even offer the job to the consumer: it
//! creates it already claimed ([`request_claimed_web_login_rotation`]) and
//! publishes no `…requested` event, because that event is the consumer's work
//! queue.
//!
//! A claim is also a **lease**, persisted beside the job with the id of the
//! observation run that holds it. A process that dies mid-run leaves a job
//! `discovering` whose lease runs out by the clock; [`super::stranded_web_login_jobs`]
//! finds it by that expiry (not by a guess from `updated_at`), and the reaper
//! parks it for reconciliation. Nothing here resumes a run: whether the site
//! received a submit is not known after a crash, and a replay could change a
//! third party's password twice.

use chrono::{DateTime, Duration, Utc};
use opensesame_domain::OrganizationId;
use opensesame_rotation::RotationState;
use opensesame_task_bus::TaskBus;
use sqlx::SqlitePool;

use super::super::{
    finish, record_rotation_changelog, state_name, truncate_detail, RotationJob, RotationTarget,
    EVENT_ROTATION_FAILED, EVENT_ROTATION_REQUESTED, STATE_SCHEDULED,
};
use crate::error::{BrokerError, Result};
use crate::store::{self, RotationJobRow};
use crate::ConnectionBroker;

/// What a runner holds a job by: the run that drives it, and how long.
#[derive(Clone, Copy, Debug)]
pub struct WebLoginClaim<'a> {
    /// The observation run this claim belongs to.
    pub run_id: &'a str,
    /// How long the claim is good for. Longer than the longest a run may take,
    /// so a live run's claim is never reaped.
    pub lease: Duration,
}

/// `web_login_job_claims`, created on first use like `rotation_jobs` itself.
pub(super) async fn ensure_claims(pool: &SqlitePool) -> Result<()> {
    store::ensure_rotation_schema(pool).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS web_login_job_claims (
            job_id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            claimed_at TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_web_login_job_claims_lease \
         ON web_login_job_claims(lease_expires_at)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn not_claimable(job_id: &str) -> BrokerError {
    BrokerError::Invalid(format!(
        "rotation job `{job_id}` is not a scheduled web-login rotation of this organization"
    ))
}

async fn insert_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    organization_id: &str,
    job_id: &str,
    claim: &WebLoginClaim<'_>,
    now: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO web_login_job_claims \
         (job_id, organization_id, run_id, claimed_at, lease_expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(job_id)
    .bind(organization_id)
    .bind(claim.run_id)
    .bind(now.to_rfc3339())
    .bind((now + claim.lease).to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Claim a scheduled web-login job: `Scheduled → Discovering`, one conditional
/// write scoped to `organization_id`, and the claim recorded with it.
///
/// # Errors
///
/// The job is unknown, in another organization, not a web login, or no longer
/// scheduled — somebody else claimed or parked it first.
pub async fn begin_web_login_rotation(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
    claim: &WebLoginClaim<'_>,
) -> Result<RotationJob> {
    RotationState::Scheduled
        .transition(RotationState::Discovering)
        .map_err(|_| BrokerError::Invalid("illegal rotation transition".into()))?;
    ensure_claims(&broker.pool).await?;
    let org = organization_id.to_string();
    let now = Utc::now();
    let mut tx = broker.pool.begin().await?;
    let taken = sqlx::query(
        "UPDATE rotation_jobs SET state = ?, detail = ?, updated_at = ? \
         WHERE id = ? AND organization_id = ? AND target_kind = 'web_login' AND state = ?",
    )
    .bind(state_name(RotationState::Discovering))
    .bind("web-login run started")
    .bind(now.to_rfc3339())
    .bind(job_id)
    .bind(&org)
    .bind(STATE_SCHEDULED)
    .execute(&mut *tx)
    .await?;
    if taken.rows_affected() != 1 {
        return Err(not_claimable(job_id));
    }
    insert_claim(&mut tx, &org, job_id, claim, now).await?;
    tx.commit().await?;
    job_in(broker, &org, job_id).await
}

/// Request a web-login rotation the runner owns from the start: the job is
/// created `discovering` and claimed in one transaction, and the generic
/// consumer is never offered it (no `…requested` event is published; the
/// request is still in the changelog).
///
/// # Errors
///
/// The job cannot be written.
pub async fn request_claimed_web_login_rotation(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    origin: &str,
    policy_id: Option<String>,
    claim: &WebLoginClaim<'_>,
) -> Result<RotationJob> {
    ensure_claims(&broker.pool).await?;
    let org = organization_id.to_string();
    let now = Utc::now();
    let row = RotationJobRow {
        id: format!("rot_{}", uuid::Uuid::now_v7()),
        policy_id,
        organization_id: org.clone(),
        target_kind: RotationTarget::WebLogin {
            origin: origin.to_owned(),
        }
        .kind()
        .to_owned(),
        target_id: origin.to_owned(),
        state: state_name(RotationState::Discovering).to_owned(),
        detail: Some("web-login run started".into()),
        created_at: now,
        updated_at: now,
    };
    let mut tx = broker.pool.begin().await?;
    sqlx::query(
        "INSERT INTO rotation_jobs (id, policy_id, organization_id, target_kind, target_id, \
         state, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.policy_id)
    .bind(&row.organization_id)
    .bind(&row.target_kind)
    .bind(&row.target_id)
    .bind(&row.state)
    .bind(&row.detail)
    .bind(now.to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(&mut *tx)
    .await?;
    insert_claim(&mut tx, &org, &row.id, claim, now).await?;
    tx.commit().await?;
    let job = job_in(broker, &org, &row.id).await?;
    record_rotation_changelog(broker, EVENT_ROTATION_REQUESTED, &job, None, None).await;
    Ok(job)
}

async fn job_in(broker: &ConnectionBroker, org: &str, job_id: &str) -> Result<RotationJob> {
    broker
        .get_rotation_job(org, job_id)
        .await?
        .ok_or_else(|| BrokerError::Invalid(format!("rotation job `{job_id}` not found")))
}

/// Park a web-login job in `ReconciliationRequired` with `detail`, if it is
/// still in `from` (and, for a claimed job, still claimed by `run_id`), and
/// announce it. One conditional write, scoped to the organization.
async fn park(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
    from: &str,
    run_id: Option<&str>,
    detail: &str,
) -> Result<RotationJob> {
    ensure_claims(&broker.pool).await?;
    let org = organization_id.to_string();
    let mut tx = broker.pool.begin().await?;
    let parked = sqlx::query(
        "UPDATE rotation_jobs SET state = ?, detail = ?, updated_at = ? \
         WHERE id = ? AND organization_id = ? AND target_kind = 'web_login' AND state = ? \
         AND (? IS NULL OR EXISTS (SELECT 1 FROM web_login_job_claims c \
              WHERE c.job_id = rotation_jobs.id AND c.run_id = ?))",
    )
    .bind(state_name(RotationState::ReconciliationRequired))
    .bind(truncate_detail(detail))
    .bind(Utc::now().to_rfc3339())
    .bind(job_id)
    .bind(&org)
    .bind(from)
    .bind(run_id)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    if parked.rows_affected() != 1 {
        return Err(not_claimable(job_id));
    }
    sqlx::query("DELETE FROM web_login_job_claims WHERE job_id = ?")
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    finish(broker, bus, &org, job_id, EVENT_ROTATION_FAILED, None, None).await
}

/// Park a scheduled web-login job nobody can run, with the honest reason —
/// conditional on it still being `scheduled`, so a runner that claimed it in
/// the meantime keeps it.
///
/// # Errors
///
/// The job is unknown, in another organization, not a web login, or no longer
/// scheduled.
pub async fn defer_web_login_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
    detail: &str,
) -> Result<RotationJob> {
    park(
        broker,
        bus,
        organization_id,
        job_id,
        STATE_SCHEDULED,
        None,
        detail,
    )
    .await
}

/// Park a job this run claimed, before it ran — a prerequisite is missing.
/// Conditional on the job still being `discovering` under `run_id`'s claim.
///
/// # Errors
///
/// The job is not a running web-login rotation held by that run.
pub async fn park_claimed_web_login_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
    run_id: &str,
    detail: &str,
) -> Result<RotationJob> {
    park(
        broker,
        bus,
        organization_id,
        job_id,
        state_name(RotationState::Discovering),
        Some(run_id),
        detail,
    )
    .await
}

/// Fence a settlement: bump `updated_at` of a job that is still `discovering`.
/// The reaper writes only against the `updated_at` it listed, so after this a
/// stale listing cannot overwrite the settlement in progress — and if the
/// reaper parked the job first, this fails and the settlement is refused
/// instead of overwriting the reaper.
pub(super) async fn fence_settlement(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<()> {
    let fenced = sqlx::query(
        "UPDATE rotation_jobs SET updated_at = ? \
         WHERE id = ? AND organization_id = ? AND target_kind = 'web_login' AND state = ?",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(job_id)
    .bind(organization_id.to_string())
    .bind(state_name(RotationState::Discovering))
    .execute(&broker.pool)
    .await?;
    if fenced.rows_affected() == 1 {
        Ok(())
    } else {
        Err(BrokerError::Invalid(format!(
            "rotation job `{job_id}` is not a running web-login rotation"
        )))
    }
}

/// Drop a job's claim once it is settled or parked.
pub(super) async fn release_claim(broker: &ConnectionBroker, job_id: &str) {
    if let Err(error) = sqlx::query("DELETE FROM web_login_job_claims WHERE job_id = ?")
        .bind(job_id)
        .execute(&broker.pool)
        .await
    {
        tracing::warn!(%error, %job_id, "a settled web-login job's claim could not be released");
    }
}

/// The run that holds `job_id`, while it is claimed.
///
/// # Errors
///
/// The claim cannot be read.
pub async fn claim_holder(broker: &ConnectionBroker, job_id: &str) -> Result<Option<String>> {
    ensure_claims(&broker.pool).await?;
    Ok(
        sqlx::query_scalar("SELECT run_id FROM web_login_job_claims WHERE job_id = ?")
            .bind(job_id)
            .fetch_optional(&broker.pool)
            .await?,
    )
}

#[cfg(test)]
#[path = "rotation_web_login_claim_tests.rs"]
mod tests;
