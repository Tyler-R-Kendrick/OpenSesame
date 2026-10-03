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
    park_claimed_web_login_rotation, request_claimed_web_login_rotation, settle_web_login_rotation,
    WebLoginClaim, WebLoginSettlement,
};
use opensesame_connection_broker::{BrokerError, RotationPolicy};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::LifecycleEvent;
use opensesame_rotation_web::hooks::{
    HookSession, HookedTransport, RunKind, SessionConfig, ShutdownReason,
};
use opensesame_rotation_web::{
    run_change_password_hooked, CredentialRef, ExtensionTransport, RunRequest,
};
use opensesame_session_observe::ControlLease;
use opensesame_storage::StoredObservationRun;

use super::canary;
use super::channel::{BrowserChannel, RunChannel};
use super::control::Stop;
use super::custody::{DriverCandidateVault, CURRENT_PASSWORD_REF};
use super::prepare::{prepare_for, Plan};
use super::recipe_trust::Attendance;
use super::records::{RecordBuffer, RecordScope};
use super::settle::{handed_over, overdue, settlement_of};
use super::WebLoginLauncher;
use crate::lifecycle::agent_phase::{publish_agent_phase, RunRefs};
use crate::lifecycle::responders::{release_policy, Outcome};

/// `viewer_key_id` on a run this runner opens. It seals nothing to a viewer
/// key — there is no viewer-key sealing on the Host yet — so it writes no
/// event to the sealed log; its record is `agent_hook_records`.
pub(crate) const NO_VIEWER_KEY: &str = "none:hook-records-only";

/// How long a run's row (and its hook records' anchor) is kept.
const OBSERVATION_RETENTION_DAYS: i64 = 7;

/// The target is already held by a runner this process does not know about —
/// another replica sharing the database — so no job was created.
#[derive(Clone, Copy, Debug)]
pub(super) struct HeldElsewhere;

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
        #[cfg(test)]
        let interceptors = launcher.tapped(interceptors);
        let resolver = launcher.resolver_for(&plan.organization_id).await;
        let session = HookSession::new(SessionConfig::new(run_id), interceptors, resolver)
            .map_err(|error| anyhow::anyhow!("hook session refused its configuration: {error:?}"))?
            .with_record_sink(sink)
            .with_stand_down({
                let channel = Arc::clone(&channel);
                move || {
                    channel
                        .stopped()
                        .is_some_and(|stop| matches!(stop, Stop::HandedOff | Stop::PersonHasIt))
                }
            })
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
                    return Outcome::held(format!(
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
        let ran = self
            .request_and_run(
                organization_id,
                origin,
                owner.as_deref(),
                policy.as_ref(),
                Attendance::Unattended,
            )
            .await;
        let Ok((outcome, refs)) = ran else {
            // A runner this process does not know about holds the target. Its
            // outcome is not ours to claim: an unattended run reports for
            // itself, but an attended run publishes no lifecycle outcome and a
            // crashed one holds the target until its claim lease lapses. So
            // this rung reports nothing — not "renewed" — leaves the expiry
            // alert open, and gives the policy lease back through the failure
            // path, which backs the policy off so a later pass retries.
            let outcome = Outcome::held(format!(
                "rotation for {origin} skipped: a run for it is already in flight"
            ));
            if let Some(policy) = policy {
                release_policy(broker, &policy, &outcome).await;
            }
            return outcome;
        };
        publish_agent_phase(&self.state, event, owner, &refs, &outcome).await;
        if let Some(policy) = policy {
            release_policy(broker, &policy, &outcome).await;
        }
        outcome
    }

    /// Request the job and run it. `attendance` is who is watching: the
    /// scanner's runs are unattended and need a canary-proven recipe; a run a
    /// person asked for is attended ([`Self::rotate_attended`]).
    ///
    /// # Errors
    ///
    /// [`HeldElsewhere`] when a runner on another replica already holds a job
    /// for the target (the broker refuses the insert, ADR 0159).
    pub(super) async fn request_and_run(
        &self,
        organization_id: &OrganizationId,
        origin: &str,
        owner: Option<&str>,
        policy: Option<&RotationPolicy>,
        attendance: Attendance,
    ) -> Result<(Outcome, RunRefs), HeldElsewhere> {
        let broker = self.state.connection_broker.as_ref();
        // The job is created already claimed by the run that will drive it, so
        // the generic rotation consumer is never offered it (it would park a
        // web-login job as "no runner") and nobody else can claim it: the
        // claim is a persisted lease naming this run, which is what recovery
        // reads if this process dies.
        let run_id = format!("run_{}", uuid::Uuid::now_v7());
        let claim = WebLoginClaim {
            run_id: &run_id,
            lease: chrono::Duration::seconds(self.timing.lease_seconds()),
        };
        let policy_id = policy.map(|p| p.id.clone());
        let job = match request_claimed_web_login_rotation(
            broker,
            organization_id,
            origin,
            policy_id,
            &claim,
        )
        .await
        {
            Ok(job) => job,
            Err(BrokerError::RunInFlight) => return Err(HeldElsewhere),
            Err(error) => {
                let detail = format!("rotation request failed: {}", error.hint());
                return Ok((Outcome::failed(detail), RunRefs::default()));
            }
        };
        let mut refs = RunRefs {
            job_id: Some(job.id.clone()),
            run_id: None,
        };
        let prepared = prepare_for(&self.state.db, organization_id, origin, owner, attendance);
        let outcome = match prepared.await {
            Ok(plan) => {
                let (outcome, opened) = self.run(&plan, &job.id, &run_id).await;
                refs.run_id = opened;
                outcome
            }
            Err(detail) => {
                let bus = self.state.task_bus.read().await;
                let parked = park_claimed_web_login_rotation(
                    broker,
                    bus.as_ref(),
                    organization_id,
                    &job.id,
                    &run_id,
                    detail,
                )
                .await;
                match parked {
                    Ok(_) => Outcome::failed(format!("rotation {} parked: {detail}", job.id)),
                    Err(error) => Outcome::failed(format!("rotation {}: {}", job.id, error.hint())),
                }
            }
        };
        Ok((outcome, refs))
    }

    /// Run a prepared job, which `run_id` already holds, to its settlement.
    /// Also the observation run's id, when one was opened.
    pub(crate) async fn run(
        &self,
        plan: &Plan,
        job_id: &str,
        run_id: &str,
    ) -> (Outcome, Option<String>) {
        let broker = self.state.connection_broker.as_ref();
        let (settlement, channel, opened) = match Harness::open(self, plan, run_id, job_id).await {
            Ok(harness) => (
                self.drive(plan, &harness, run_id).await,
                Some(Arc::clone(&harness.channel)),
                Some(run_id.to_owned()),
            ),
            Err(error) => {
                tracing::error!(%error, %job_id, "web-login run could not be opened");
                let detail = "the run could not be opened".into();
                (WebLoginSettlement::NotSubmitted(detail), None, None)
            }
        };
        // A run a person asked for, or already holds, is theirs: it is left
        // open, parked, so they can take it — closing it would refuse the very
        // control they requested.
        let theirs = channel
            .as_ref()
            .and_then(|channel| channel.stopped())
            .is_some_and(|stop| matches!(stop, Stop::HandedOff | Stop::PersonHasIt));
        // The rotation is settled only once the run is durably closed: until
        // then a still-claimed step could settle after the sweep below and
        // leave its answer stored. A run that cannot be closed parks the job
        // for reconciliation instead (`close`).
        let settlement = if theirs {
            settlement
        } else {
            self.close(plan, run_id, settlement).await
        };
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
        let outcome = match (settled, settlement) {
            (Err(error), _) => Outcome::failed(format!("rotation {job_id}: {}", error.hint())),
            (Ok(job), WebLoginSettlement::Completed) => {
                Outcome::ok(format!("rotation {} completed by run {run_id}", job.id))
            }
            (
                Ok(job),
                WebLoginSettlement::NotSubmitted(detail) | WebLoginSettlement::Reconcile(detail),
            ) => Outcome::failed(format!("rotation {} run {run_id}: {detail}", job.id)),
        };
        (outcome, opened)
    }

    /// Drive the hosted change-password run and read how it ended.
    async fn drive(&self, plan: &Plan, harness: &Harness, run_id: &str) -> WebLoginSettlement {
        let request = RunRequest {
            run: RunKind::ChangePassword,
            recipe: plan.recipe_id.clone(),
            origin: plan.origin.clone(),
        };
        // The whole run is bounded, not only each wait for the driver: a hook
        // waiting on a person's approval is not a step, and a run that could
        // outlast its deadline could outlast the lease that stops a second
        // process starting the same rotation.
        let run = tokio::time::timeout(
            self.timing.run_deadline,
            run_change_password_hooked(
                &harness.hooked,
                &harness.vault,
                &plan.recipe,
                &CredentialRef::new(CURRENT_PASSWORD_REF),
                ControlLease::new(),
                &request,
            ),
        )
        .await;
        let mut drift = false;
        let settlement = if let Ok(report) = run {
            drift = canary::drifted(&report);
            let settled = settlement_of(report, &harness.hooked, harness.vault.promoted()).await;
            match harness.channel.stopped() {
                Some(stop) => handed_over(settled, stop),
                None => settled,
            }
        } else {
            tracing::warn!("a web-login run ran past its deadline and was stopped");
            // The timeout dropped the hosted run where it stood, so it never
            // reached its own shutdown. Close the session here. An emission
            // that was in flight leaves its abandoned record and moves the
            // session as the deny it records does: a cut `agent_startup` is a
            // startup deny, which this shutdown (reason `error`) closes, and a
            // cut `agent_shutdown` already closed the session, so this one is
            // refused rather than emitted twice. A session that never started
            // emits nothing. Either way the trail ends in exactly one
            // `agent_shutdown`, and a refusal here is the normal answer when
            // one is already there.
            harness
                .hooked
                .session()
                .shutdown(ShutdownReason::Error)
                .await;
            overdue(harness.channel.submit_sent())
        };
        // What the run proved about the recipe it replayed is the Host's to
        // record, whether or not the rest of the run's bookkeeping lands.
        canary::record(&self.state.db, plan, &settlement, drift, run_id).await;
        // The records the last step, the output and the shutdown left behind.
        match harness.channel.flush_records().await {
            Ok(()) => settlement,
            Err(error) => {
                tracing::error!(%error, "a web-login run's hook records are incomplete");
                super::settle::unaudited(settlement)
            }
        }
    }
}
