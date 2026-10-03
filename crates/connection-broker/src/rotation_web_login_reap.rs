//! A web-login job a dead process left half-run (ADR 0076 §9, ADR 0156).
//!
//! The Host's runner walks a job `Scheduled → Discovering` before its first
//! step and settles it at the end. A gateway that stops in between leaves the
//! job in a running state for good: nothing else writes its next transition.
//! This is the broker's half of the reaper — find such jobs, and park one for
//! reconciliation with a truthful reason.
//!
//! Truthful means not claiming more than is known. A stranded job is not
//! "not submitted": the process that held it may have got as far as the
//! submit. So it parks the way an unknown outcome does, in
//! `ReconciliationRequired`, and the previous value is retained.
//!
//! The write is conditional on the state and timestamp the reaper read. A run
//! that settled between the read and the write wins; the reaper never
//! overwrites a settlement it did not see.

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use opensesame_rotation::RotationState;
use opensesame_task_bus::TaskBus;
use sqlx::{QueryBuilder, Row, Sqlite};

use super::super::{
    bus_event, job_event_data, record_rotation_changelog, state_name, truncate_detail, RotationJob,
    EVENT_ROTATION_FAILED,
};
use super::claim::ensure_claims;
use crate::error::Result;
use crate::store::RotationJobRow;
use crate::ConnectionBroker;

/// The detail a stranded job parks with.
pub const STRANDED_DETAIL: &str =
    "the run stopped before it settled; whether the site received the change is unknown";

/// Most jobs one listing returns; the next pass takes the rest.
const STRANDED_JOB_BATCH: i64 = 200;

/// States a web-login job passes through while a runner holds it — every one
/// that is neither waiting for a runner nor finished.
pub(super) const RUNNING: [RotationState; 10] = [
    RotationState::Discovering,
    RotationState::CandidateGenerated,
    RotationState::CandidateInstalled,
    RotationState::CandidateVerified,
    RotationState::CandidateActivated,
    RotationState::DependentsUpdated,
    RotationState::Observing,
    RotationState::PreviousRevoked,
    RotationState::RevocationVerified,
    RotationState::RollbackStarted,
];

/// A web-login job nobody is running, and the run that last held it.
#[derive(Clone, Debug)]
pub struct StrandedWebLoginJob {
    pub job: RotationJob,
    /// The observation run whose claim lapsed. `None` for a job claimed
    /// before claims were recorded.
    pub run_id: Option<String>,
}

/// Web-login jobs of `organization_id` in a running state that nobody is
/// running at `now`.
///
/// A claimed job is stranded when its **lease** has run out: the claim names
/// how long its run may take, so a live run is never listed. A job with no
/// claim on record (one begun before claims were persisted) falls back to
/// "nothing has touched it since `untouched_since`".
///
/// # Errors
///
/// The jobs cannot be read.
pub async fn stranded_web_login_jobs(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
    untouched_since: DateTime<Utc>,
) -> Result<Vec<StrandedWebLoginJob>> {
    ensure_claims(&broker.pool).await?;
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT j.id, j.policy_id, j.organization_id, j.target_kind, j.target_id, j.state, \
         j.detail, j.created_at, j.updated_at, c.run_id AS claim_run_id \
         FROM rotation_jobs j LEFT JOIN web_login_job_claims c ON c.job_id = j.id \
         WHERE j.target_kind = 'web_login' AND j.organization_id = ",
    );
    query.push_bind(organization_id.to_string());
    query.push(" AND ((c.lease_expires_at IS NOT NULL AND c.lease_expires_at < ");
    query.push_bind(now.to_rfc3339());
    query.push(") OR (c.lease_expires_at IS NULL AND j.updated_at < ");
    query.push_bind(untouched_since.to_rfc3339());
    query.push(")) AND j.state IN (");
    let mut names = query.separated(", ");
    for state in RUNNING {
        names.push_bind(state_name(state));
    }
    query
        .push(") ORDER BY j.updated_at ASC, j.id ASC LIMIT ")
        .push_bind(STRANDED_JOB_BATCH);
    let rows = query.build().fetch_all(&broker.pool).await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let job = RotationJob::from_row(RotationJobRow {
                id: row.get("id"),
                policy_id: row.get("policy_id"),
                organization_id: row.get("organization_id"),
                target_kind: row.get("target_kind"),
                target_id: row.get("target_id"),
                state: row.get("state"),
                detail: row.get("detail"),
                created_at: parse(&row.get::<String, _>("created_at")),
                updated_at: parse(&row.get::<String, _>("updated_at")),
            })?;
            Some(StrandedWebLoginJob {
                job,
                run_id: row.get("claim_run_id"),
            })
        })
        .collect())
}

fn parse(raw: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(raw).map_or_else(|_| Utc::now(), |time| time.with_timezone(&Utc))
}

/// Park a stranded job for reconciliation, if it is still exactly as listed.
///
/// Returns the parked job, or `None` when it moved in the meantime — a run
/// that settled, or another reaper that got there first.
///
/// # Errors
///
/// The write or the re-read fails.
pub async fn reconcile_stranded_web_login_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    stranded: &RotationJob,
    detail: &str,
) -> Result<Option<RotationJob>> {
    let written = sqlx::query(
        "UPDATE rotation_jobs SET state = ?, detail = ?, updated_at = ? \
         WHERE id = ? AND organization_id = ? AND target_kind = 'web_login' \
         AND state = ? AND updated_at = ?",
    )
    .bind(state_name(RotationState::ReconciliationRequired))
    .bind(truncate_detail(detail))
    .bind(Utc::now().to_rfc3339())
    .bind(&stranded.id)
    .bind(&stranded.organization_id)
    .bind(&stranded.state)
    .bind(&stranded.updated_at)
    .execute(&broker.pool)
    .await?;
    if written.rows_affected() != 1 {
        return Ok(None);
    }
    super::claim::release_claim(broker, &stranded.id).await;
    let Some(job) = broker
        .get_rotation_job(&stranded.organization_id, &stranded.id)
        .await?
    else {
        return Ok(None);
    };
    record_rotation_changelog(broker, EVENT_ROTATION_FAILED, &job, None, None).await;
    let _ = bus
        .publish(bus_event(EVENT_ROTATION_FAILED, job_event_data(&job)))
        .await;
    Ok(Some(job))
}

#[cfg(test)]
mod tests {
    use opensesame_storage::Db;
    use opensesame_task_bus::InMemoryTaskBus;

    use super::super::super::{request_rotation, RotationStatus, RotationTarget};
    use super::super::{
        begin_web_login_rotation, settle_web_login_rotation, WebLoginClaim, WebLoginSettlement,
    };
    use super::*;
    use crate::config::BrokerConfig;

    async fn fixture() -> (ConnectionBroker, InMemoryTaskBus, OrganizationId) {
        let db = Db::connect_memory().await.expect("db");
        let config = BrokerConfig::in_memory(Some([7u8; 32]), "http://127.0.0.1:8787");
        let broker = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
        (broker, InMemoryTaskBus::default(), OrganizationId::new())
    }

    async fn job(
        broker: &ConnectionBroker,
        bus: &InMemoryTaskBus,
        org: &OrganizationId,
        origin: &str,
    ) -> String {
        let target = RotationTarget::WebLogin {
            origin: origin.into(),
        };
        request_rotation(broker, bus, target, None, &org.to_string(), None)
            .await
            .unwrap()
            .id
    }

    fn claim(run_id: &str) -> WebLoginClaim<'_> {
        WebLoginClaim {
            run_id,
            lease: chrono::Duration::minutes(17),
        }
    }

    fn later() -> DateTime<Utc> {
        Utc::now() + chrono::Duration::hours(1)
    }

    #[tokio::test]
    async fn only_a_running_job_untouched_since_the_cutoff_is_stranded() {
        let (broker, bus, org) = fixture().await;
        let scheduled = job(&broker, &bus, &org, "https://a.example").await;
        let running = job(&broker, &bus, &org, "https://b.example").await;
        let settled = job(&broker, &bus, &org, "https://c.example").await;
        begin_web_login_rotation(&broker, &org, &running, &claim("run_running"))
            .await
            .unwrap();
        begin_web_login_rotation(&broker, &org, &settled, &claim("run_settled"))
            .await
            .unwrap();
        settle_web_login_rotation(&broker, &bus, &org, &settled, WebLoginSettlement::Completed)
            .await
            .unwrap();

        // A cutoff before the job's last transition: a live runner is not stranded.
        let past = Utc::now() - chrono::Duration::hours(1);
        assert!(stranded_web_login_jobs(&broker, &org, past, past)
            .await
            .unwrap()
            .is_empty());

        let found = stranded_web_login_jobs(&broker, &org, later(), later())
            .await
            .unwrap();
        let ids: Vec<_> = found
            .iter()
            .map(|stranded| stranded.job.id.as_str())
            .collect();
        assert_eq!(ids, [running.as_str()], "not {scheduled} or {settled}");
        // Another organization's stranded job is not ours to reap.
        let other = OrganizationId::new();
        assert!(stranded_web_login_jobs(&broker, &other, later(), later())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_stranded_job_parks_for_reconciliation_with_a_truthful_detail() {
        let (broker, bus, org) = fixture().await;
        let id = job(&broker, &bus, &org, "https://a.example").await;
        begin_web_login_rotation(&broker, &org, &id, &claim("run_id"))
            .await
            .unwrap();
        let stranded = stranded_web_login_jobs(&broker, &org, later(), later())
            .await
            .unwrap();

        let parked =
            reconcile_stranded_web_login_rotation(&broker, &bus, &stranded[0].job, STRANDED_DETAIL)
                .await
                .unwrap()
                .expect("nothing moved it");
        assert_eq!(parked.state, "reconciliation_required");
        assert_eq!(parked.status, RotationStatus::Failed);
        assert_eq!(parked.detail.as_deref(), Some(STRANDED_DETAIL));
        assert!(!STRANDED_DETAIL.contains("not submitted"));

        // Parked once: a second reaper finds nothing, and the stale listing
        // it holds writes nothing.
        assert!(stranded_web_login_jobs(&broker, &org, later(), later())
            .await
            .unwrap()
            .is_empty());
        assert!(
            reconcile_stranded_web_login_rotation(&broker, &bus, &stranded[0].job, "again")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_run_that_settled_first_is_never_overwritten() {
        let (broker, bus, org) = fixture().await;
        let id = job(&broker, &bus, &org, "https://a.example").await;
        begin_web_login_rotation(&broker, &org, &id, &claim("run_id"))
            .await
            .unwrap();
        let stranded = stranded_web_login_jobs(&broker, &org, later(), later())
            .await
            .unwrap();

        // The run was alive after all and settles before the reaper writes.
        settle_web_login_rotation(&broker, &bus, &org, &id, WebLoginSettlement::Completed)
            .await
            .unwrap();
        assert!(reconcile_stranded_web_login_rotation(
            &broker,
            &bus,
            &stranded[0].job,
            STRANDED_DETAIL
        )
        .await
        .unwrap()
        .is_none());
        let job = broker
            .get_rotation_job(&org.to_string(), &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.state, "completed");
    }
}
