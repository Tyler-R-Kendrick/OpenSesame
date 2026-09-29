//! Opening, running and settling one web-login run.
//!
//! [`WebLoginLauncher::rotate`] is the lifecycle responder's entry for a
//! `web_login` target: it claims the policy, requests the job, and either
//! parks it with the missing prerequisite or runs it. [`Harness`] is the run
//! itself — the step channel, the driver-side vault, and the hosted transport
//! with the organization's interceptor registered — built once, so the
//! launcher and a test drive exactly the same thing.

use std::sync::Arc;

use chrono::Utc;
use opensesame_agent_hooks::{redact_for_approver, sdk::Interceptor};
use opensesame_connection_broker::rotation::web_login::{
    begin_web_login_rotation, defer_web_login_rotation, settle_web_login_rotation,
    WebLoginSettlement,
};
use opensesame_connection_broker::{request_rotation, RotationPolicy, RotationTarget};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::LifecycleEvent;
use opensesame_rotation_web::hooks::{HookSession, HookedTransport, RunKind, SessionConfig};
use opensesame_rotation_web::{
    run_change_password_hooked, CredentialRef, ExtensionTransport, RunRequest,
};
use opensesame_session_observe::ControlLease;
use opensesame_storage::StoredObservationRun;

use super::channel::{BrowserChannel, RunChannel};
use super::custody::{DriverCandidateVault, CURRENT_PASSWORD_REF};
use super::prepare::{prepare, Plan};
use super::records::{RecordBuffer, RecordScope};
use super::settle::settlement_of;
use super::WebLoginLauncher;
use crate::lifecycle::responders::{publish_agent_phase, release_policy, Outcome};

/// `viewer_key_id` on a run this runner opens. It seals nothing to a viewer
/// key — there is no viewer-key sealing on the Host yet — so it writes no
/// event to the sealed log; its record is `agent_hook_records`.
pub(crate) const NO_VIEWER_KEY: &str = "none:hook-records-only";

/// How long a run's row (and its hook records' anchor) is kept.
const OBSERVATION_RETENTION_DAYS: i64 = 7;

/// One run, assembled.
pub(crate) struct Harness {
    pub channel: Arc<RunChannel>,
    pub vault: DriverCandidateVault,
    pub hooked: HookedTransport<ExtensionTransport<BrowserChannel>>,
}

impl Harness {
    /// Open the observation run for `plan` and assemble its transport.
    ///
    /// # Errors
    ///
    /// The run row cannot be written.
    pub(crate) async fn open(
        launcher: &WebLoginLauncher,
        plan: &Plan,
        run_id: &str,
        job_id: &str,
    ) -> anyhow::Result<Self> {
        let db = &launcher.state.db;
        let now = Utc::now();
        db.create_observation_run(&StoredObservationRun {
            id: run_id.to_owned(),
            organization_id: plan.organization_id.to_string(),
            job_id: job_id.to_owned(),
            target_origin: plan.origin.clone(),
            // A recipe replay with no model in the loop (ADR 0076 §2).
            tier: "t3".into(),
            control_state: "agent_driving".into(),
            quiescence: "quiescent".into(),
            handoff_queued: false,
            lease_holder: None,
            lease_expires_at: None,
            owner_principal_id: plan.owner.clone(),
            viewer_key_id: NO_VIEWER_KEY.into(),
            next_seq: 0,
            blocked_reason: None,
            expires_at: (now + chrono::Duration::days(OBSERVATION_RETENTION_DAYS)).to_rfc3339(),
            closed_at: None,
            version: 1,
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        })
        .await?;
        let records = Arc::new(RecordBuffer::default());
        let sink = records.sink(RecordScope {
            organization_id: plan.organization_id.to_string(),
            run_id: run_id.to_owned(),
            policy_version: plan.hooks.version,
        });
        let channel = Arc::new(RunChannel::new(
            db.clone(),
            plan.organization_id.to_string(),
            run_id.to_owned(),
            launcher.timing,
            records,
        ));
        let interceptors: Vec<Box<dyn Interceptor>> = vec![Box::new(plan.hooks.interceptor())];
        let resolver = launcher.approval_resolver.as_ref().map(|factory| factory());
        let session = HookSession::new(SessionConfig::new(run_id), interceptors, resolver)
            .map_err(|error| anyhow::anyhow!("hook session refused its configuration: {error:?}"))?
            .with_record_sink(sink)
            .with_approval_redactor(redact_for_approver);
        let transport = ExtensionTransport::new(BrowserChannel(Arc::clone(&channel)), Vec::new());
        Ok(Self {
            vault: DriverCandidateVault::new(Arc::clone(&channel)),
            hooked: HookedTransport::new(transport, session),
            channel,
        })
    }
}

impl WebLoginLauncher {
    /// Rotate a web login the lifecycle scanner found due.
    pub(crate) async fn rotate(
        &self,
        event: &LifecycleEvent,
        origin: &str,
        organization_id: &OrganizationId,
        policy: Option<RotationPolicy>,
    ) -> Outcome {
        let broker = self.state.connection_broker.as_ref();
        if let Some(policy) = policy.as_ref() {
            match broker
                .claim_rotation_policy(&policy.id, self.timing.lease_seconds())
                .await
            {
                Ok(true) => {}
                Ok(false) => {
                    return Outcome::ok(format!(
                        "rotation for policy {} skipped: leased, backing off, or parked",
                        policy.id
                    ));
                }
                Err(error) => {
                    return Outcome::failed(format!("rotation claim failed: {}", error.hint()));
                }
            }
        }
        let owner = policy.as_ref().and_then(|p| p.owner_subject.clone());
        let (outcome, job_id) = self
            .request_and_run(organization_id, origin, owner.as_deref(), policy.as_ref())
            .await;
        publish_agent_phase(&self.state, event, owner, job_id, &outcome).await;
        if let Some(policy) = policy {
            release_policy(broker, &policy, &outcome).await;
        }
        outcome
    }

    async fn request_and_run(
        &self,
        organization_id: &OrganizationId,
        origin: &str,
        owner: Option<&str>,
        policy: Option<&RotationPolicy>,
    ) -> (Outcome, Option<String>) {
        let broker = self.state.connection_broker.as_ref();
        let target = RotationTarget::WebLogin {
            origin: origin.to_owned(),
        };
        let requested = {
            let bus = self.state.task_bus.read().await;
            let org = organization_id.to_string();
            let policy_id = policy.map(|p| p.id.clone());
            request_rotation(broker, bus.as_ref(), target, None, &org, policy_id).await
        };
        let job = match requested {
            Ok(job) => job,
            Err(error) => {
                let detail = format!("rotation request failed: {}", error.hint());
                return (Outcome::failed(detail), None);
            }
        };
        let outcome = match prepare(&self.state.db, organization_id, origin, owner).await {
            Ok(plan) => self.run(&plan, &job.id).await,
            Err(detail) => {
                let bus = self.state.task_bus.read().await;
                let parked = defer_web_login_rotation(
                    broker,
                    bus.as_ref(),
                    organization_id,
                    &job.id,
                    detail,
                )
                .await;
                match parked {
                    Ok(_) => Outcome::failed(format!("rotation {} parked: {detail}", job.id)),
                    Err(error) => Outcome::failed(format!("rotation {}: {}", job.id, error.hint())),
                }
            }
        };
        (outcome, Some(job.id))
    }

    /// Run a prepared job to its settlement.
    pub(crate) async fn run(&self, plan: &Plan, job_id: &str) -> Outcome {
        let broker = self.state.connection_broker.as_ref();
        if let Err(error) = begin_web_login_rotation(broker, &plan.organization_id, job_id).await {
            return Outcome::failed(format!("rotation {job_id}: {}", error.hint()));
        }
        let run_id = format!("run_{}", uuid::Uuid::now_v7());
        let (settlement, channel) = match Harness::open(self, plan, &run_id, job_id).await {
            Ok(harness) => (
                self.drive(plan, &harness).await,
                Some(Arc::clone(&harness.channel)),
            ),
            Err(error) => {
                tracing::error!(%error, %job_id, "web-login run could not be opened");
                let detail = "the run could not be opened".into();
                (WebLoginSettlement::NotSubmitted(detail), None)
            }
        };
        self.close(plan, &run_id, &settlement).await;
        if let Some(channel) = channel {
            channel.narrow_settled().await;
        }
        let settled = {
            let bus = self.state.task_bus.read().await;
            settle_web_login_rotation(
                broker,
                bus.as_ref(),
                &plan.organization_id,
                job_id,
                settlement.clone(),
            )
            .await
        };
        match (settled, settlement) {
            (Err(error), _) => Outcome::failed(format!("rotation {job_id}: {}", error.hint())),
            (Ok(job), WebLoginSettlement::Completed) => {
                Outcome::ok(format!("rotation {} completed by run {run_id}", job.id))
            }
            (
                Ok(job),
                WebLoginSettlement::NotSubmitted(detail) | WebLoginSettlement::Reconcile(detail),
            ) => Outcome::failed(format!("rotation {} run {run_id}: {detail}", job.id)),
        }
    }

    /// Drive the hosted change-password run and read how it ended.
    async fn drive(&self, plan: &Plan, harness: &Harness) -> WebLoginSettlement {
        let request = RunRequest {
            run: RunKind::ChangePassword,
            recipe: plan.recipe_id.clone(),
            origin: plan.origin.clone(),
        };
        let report = run_change_password_hooked(
            &harness.hooked,
            &harness.vault,
            &plan.recipe,
            &CredentialRef::new(CURRENT_PASSWORD_REF),
            ControlLease::new(),
            &request,
        )
        .await;
        let settlement = settlement_of(report, &harness.hooked, harness.vault.promoted()).await;
        // The records the last step, the output and the shutdown left behind.
        match harness.channel.flush_records().await {
            Ok(()) => settlement,
            Err(error) => {
                tracing::error!(%error, "a web-login run's hook records are incomplete");
                super::settle::unaudited(settlement)
            }
        }
    }

    /// Close the run: its steps can no longer be claimed, and a person reading
    /// it sees why it stopped.
    async fn close(&self, plan: &Plan, run_id: &str, settlement: &WebLoginSettlement) {
        let db = &self.state.db;
        let org = plan.organization_id.to_string();
        let now = Utc::now().to_rfc3339();
        let reason = match settlement {
            WebLoginSettlement::Completed => None,
            WebLoginSettlement::NotSubmitted(detail) | WebLoginSettlement::Reconcile(detail) => {
                Some(detail.clone())
            }
        };
        if let Ok(Some(run)) = db.get_observation_run(&org, run_id).await {
            let update = opensesame_storage::ObservationControlUpdate {
                run_id: run.id.clone(),
                organization_id: org.clone(),
                expected_version: run.version,
                control_state: run.control_state.clone(),
                quiescence: run.quiescence.clone(),
                handoff_queued: run.handoff_queued,
                lease_holder: run.lease_holder.clone(),
                lease_expires_at: run.lease_expires_at.clone(),
                blocked_reason: reason,
            };
            let _ = db.update_observation_control(&update, &now).await;
        }
        if let Err(error) = db.close_observation_run(&org, run_id, &now).await {
            tracing::warn!(%error, %run_id, "web-login run could not be closed");
        }
    }
}
