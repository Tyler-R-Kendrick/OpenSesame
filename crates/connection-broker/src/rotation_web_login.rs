//! A web-login job's life when a runner exists to drive it (ADR 0076 §9).
//!
//! The broker has no runner: [`super::execute_rotation`] still parks a
//! web-login job with `WEB_LOGIN_NO_RUNNER_DETAIL` for any caller that does
//! not bring one. The Host's runner (in the gateway) owns the browser half and
//! reports here, so the job's durable state keeps walking the same
//! verify-before-revoke machine every other target walks, with ADR 0076 §9's
//! web-login semantics:
//!
//! - `begin` claims the job: `Scheduled → Discovering`, before any step.
//! - A run that **completed** — submitted, confirmed by a fresh login, and
//!   promoted — walks the whole machine. `PreviousRevoked` is an observation
//!   (the site killed the old password when it took the change) and
//!   `RevocationVerified` is the site's own confirmation, never a probe.
//! - A run stopped **before anything was submitted** parks with the previous
//!   password standing. It never claims a candidate was installed.
//! - A run whose outcome is **unknown** after a submit walks to
//!   `CandidateInstalled → ReconciliationRequired`. Rollback is unavailable —
//!   we cannot un-change a password on a third party's site.
//!
//! Every detail is a value-blind hint, truncated like every other job's.

use opensesame_domain::OrganizationId;
use opensesame_rotation::RotationState;
use opensesame_task_bus::TaskBus;

use super::{
    advance, defer_rotation, finish, load_scheduled_job, state_name, truncate_detail, RotationJob,
    RotationTarget, EVENT_ROTATION_FAILED, EVENT_ROTATION_SUCCEEDED,
};
use crate::error::{BrokerError, Result};
use crate::ConnectionBroker;

#[path = "rotation_web_login_reap.rs"]
mod reap;
pub use reap::{reconcile_stranded_web_login_rotation, stranded_web_login_jobs, STRANDED_DETAIL};

/// How a hosted web-login run ended, as the job records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebLoginSettlement {
    /// The site took the change, a fresh login proved it, and the vault
    /// promoted the candidate.
    Completed,
    /// Stopped before anything was submitted; the previous password stands.
    NotSubmitted(String),
    /// Submitted (or possibly submitted) and unconfirmed; a person reconciles.
    Reconcile(String),
}

/// The job, if it is a scheduled web-login job — the only one a runner may
/// take.
async fn scheduled_web_login(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    let job = load_scheduled_job(broker, organization_id, job_id).await?;
    if !matches!(job.target, RotationTarget::WebLogin { .. }) {
        return Err(BrokerError::Invalid(format!(
            "rotation job `{job_id}` is not a web-login rotation"
        )));
    }
    Ok(job)
}

/// Park a scheduled web-login job the runner cannot run, with the honest
/// reason why (ADR 0076 T5: notify and park, never improvise).
///
/// # Errors
///
/// The job is unknown, not scheduled, not a web login, or cannot be written.
pub async fn defer_web_login_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
    detail: &str,
) -> Result<RotationJob> {
    let job = scheduled_web_login(broker, organization_id, job_id).await?;
    defer_rotation(broker, bus, organization_id, job, &truncate_detail(detail)).await
}

/// Claim a scheduled web-login job for a run: `Scheduled → Discovering`.
///
/// # Errors
///
/// The job is unknown, already taken, not a web login, or cannot be written.
pub async fn begin_web_login_rotation(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    scheduled_web_login(broker, organization_id, job_id).await?;
    let mut state = RotationState::Scheduled;
    advance(
        broker,
        job_id,
        &mut state,
        RotationState::Discovering,
        Some("web-login run started"),
    )
    .await?;
    job_in(broker, organization_id, job_id).await
}

async fn job_in(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    broker
        .get_rotation_job(&organization_id.to_string(), job_id)
        .await?
        .ok_or_else(|| BrokerError::Invalid(format!("rotation job `{job_id}` not found")))
}

/// Record how a begun run ended, and announce it.
///
/// # Errors
///
/// The job is not a web-login job in `discovering`, or a transition cannot be
/// written.
pub async fn settle_web_login_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
    settlement: WebLoginSettlement,
) -> Result<RotationJob> {
    let job = job_in(broker, organization_id, job_id).await?;
    let discovering = state_name(RotationState::Discovering);
    if !matches!(job.target, RotationTarget::WebLogin { .. }) || job.state != discovering {
        return Err(BrokerError::Invalid(format!(
            "rotation job `{job_id}` is not a running web-login rotation"
        )));
    }
    let org = organization_id.to_string();
    let mut state = RotationState::Discovering;
    match settlement {
        WebLoginSettlement::NotSubmitted(detail) => {
            let detail = format!("not submitted; the previous password stands: {detail}");
            defer_rotation(broker, bus, organization_id, job, &truncate_detail(&detail)).await
        }
        WebLoginSettlement::Reconcile(detail) => {
            for to in [
                RotationState::CandidateGenerated,
                RotationState::CandidateInstalled,
            ] {
                advance(broker, job_id, &mut state, to, None).await?;
            }
            let detail = truncate_detail(&detail);
            advance(
                broker,
                job_id,
                &mut state,
                RotationState::ReconciliationRequired,
                Some(&detail),
            )
            .await?;
            finish(broker, bus, &org, job_id, EVENT_ROTATION_FAILED, None, None).await
        }
        WebLoginSettlement::Completed => {
            for to in [
                RotationState::CandidateGenerated,
                RotationState::CandidateInstalled,
                RotationState::CandidateVerified,
                RotationState::CandidateActivated,
                RotationState::DependentsUpdated,
                RotationState::Observing,
                RotationState::PreviousRevoked,
                RotationState::RevocationVerified,
                RotationState::Completed,
            ] {
                advance(broker, job_id, &mut state, to, None).await?;
            }
            finish(
                broker,
                bus,
                &org,
                job_id,
                EVENT_ROTATION_SUCCEEDED,
                None,
                None,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use opensesame_storage::Db;
    use opensesame_task_bus::InMemoryTaskBus;

    use super::super::{execute_rotation, request_rotation, RotationStatus};
    use super::*;
    use crate::config::BrokerConfig;

    async fn web_job() -> (ConnectionBroker, InMemoryTaskBus, OrganizationId, String) {
        let db = Db::connect_memory().await.expect("db");
        let config = BrokerConfig::in_memory(Some([7u8; 32]), "http://127.0.0.1:8787");
        let broker = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
        let bus = InMemoryTaskBus::default();
        let org = OrganizationId::new();
        let target = RotationTarget::WebLogin {
            origin: "https://example.com".into(),
        };
        let job = request_rotation(&broker, &bus, target, None, &org.to_string(), None)
            .await
            .unwrap();
        (broker, bus, org, job.id)
    }

    #[tokio::test]
    async fn a_completed_run_walks_the_whole_machine() {
        let (broker, bus, org, job) = web_job().await;
        let begun = begin_web_login_rotation(&broker, &org, &job).await.unwrap();
        assert_eq!(begun.state, "discovering");
        // A begun job is taken: neither the broker's own path nor a second
        // runner may start it again.
        assert!(begin_web_login_rotation(&broker, &org, &job).await.is_err());
        assert!(execute_rotation(&broker, &bus, &org, &job).await.is_err());

        let done =
            settle_web_login_rotation(&broker, &bus, &org, &job, WebLoginSettlement::Completed)
                .await
                .unwrap();
        assert_eq!(done.state, "completed");
        assert_eq!(done.status, RotationStatus::Succeeded);
        // Settled once; a second report is refused rather than rewritten.
        assert!(settle_web_login_rotation(
            &broker,
            &bus,
            &org,
            &job,
            WebLoginSettlement::Completed
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn an_unsubmitted_run_parks_without_claiming_an_install() {
        let (broker, bus, org, job) = web_job().await;
        begin_web_login_rotation(&broker, &org, &job).await.unwrap();
        let parked = settle_web_login_rotation(
            &broker,
            &bus,
            &org,
            &job,
            WebLoginSettlement::NotSubmitted("a hook verdict refused a step".into()),
        )
        .await
        .unwrap();
        assert_eq!(parked.state, "reconciliation_required");
        let detail = parked.detail.unwrap_or_default();
        assert!(detail.starts_with("not submitted"), "{detail}");
    }

    #[tokio::test]
    async fn an_unknown_outcome_reconciles_after_install() {
        let (broker, bus, org, job) = web_job().await;
        begin_web_login_rotation(&broker, &org, &job).await.unwrap();
        let parked = settle_web_login_rotation(
            &broker,
            &bus,
            &org,
            &job,
            WebLoginSettlement::Reconcile("x".repeat(400)),
        )
        .await
        .unwrap();
        assert_eq!(parked.state, "reconciliation_required");
        assert_eq!(parked.status, RotationStatus::Failed);
        assert!(parked.detail.unwrap_or_default().chars().count() <= 160);
    }

    #[tokio::test]
    async fn a_deferral_needs_a_scheduled_web_login_job() {
        let (broker, bus, org, job) = web_job().await;
        let parked = defer_web_login_rotation(&broker, &bus, &org, &job, "no recipe")
            .await
            .unwrap();
        assert_eq!(parked.state, "reconciliation_required");
        assert_eq!(parked.detail.as_deref(), Some("no recipe"));
        assert!(defer_web_login_rotation(&broker, &bus, &org, &job, "again")
            .await
            .is_err());
        // Only a begun job can be settled.
        let (broker, bus, org, job) = web_job().await;
        assert!(settle_web_login_rotation(
            &broker,
            &bus,
            &org,
            &job,
            WebLoginSettlement::Completed
        )
        .await
        .is_err());
    }
}
