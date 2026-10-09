//! What a stopped gateway leaves behind (ADR 0076 §5, ADR 0081, ADR 0159).
//!
//! A run is a task in one process. If that process stops — a crash, a deploy,
//! a killed pod — nothing else writes the run's next transition: the rotation
//! job stays `discovering` and the observation run stays open, its step queue
//! still claimable by a browser, for good. The policy lease that kept a second
//! process from starting the same rotation expires by the clock; nothing
//! expires the rest.
//!
//! [`sweep`] is that expiry. It runs once at startup, before the scanner
//! starts anything, and then on a timer, and it acts only on what has outlived
//! the longest a run may last — the same horizon as the policy lease
//! ([`RunTiming::lease_seconds`]) — so a run that is alive in this process or
//! another is never touched:
//!
//! - an **observation run** still open past the horizon is closed, suspended
//!   and with no driver, so its steps can no longer be claimed. One a person
//!   holds under a live control lease is not stranded — that lease has its own
//!   clock — and one parked for a person is closed without a new notice (the
//!   run announced its own parking);
//! - a **web-login job** whose claim has lapsed is parked in
//!   `reconciliation_required`. A claim is a persisted lease that names the
//!   run holding the job (`web_login_job_claims`), so "stranded" is the
//!   lease's own expiry, not a guess from when the row was last touched; the
//!   run it names is closed with it. The detail says what is known: the run
//!   stopped before it settled, and whether the site received the change is
//!   not known. It never says "not submitted" — the process that held it may
//!   have got as far as the submit.
//!
//! The owner of a run closed as an orphan is told on the `agent.*` feed, since
//! the run that would have told them is gone.
//!
//! What the sweep does *not* do is touch the policy: a crashed run never
//! released it, and its lease lapses by the clock like every crashed
//! rotation's (`ROTATION_LEASE`), which is the documented way a policy is
//! reclaimed.

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_agent_events::AgentRun;
use opensesame_connection_broker::rotation::web_login::{
    reconcile_stranded_web_login_rotation, stranded_web_login_jobs, STRANDED_DETAIL,
};
use opensesame_connection_broker::RotationJob;
use opensesame_domain::OrganizationId;
use opensesame_storage::web_login_runs::retention::StrandedRun;

use super::RunTiming;
use crate::app_state::AppState;
use crate::lifecycle::agent_phase::announce;
use crate::lifecycle::responders::Outcome;

/// The reason an orphaned run is closed with, on the run and in the notice.
pub(crate) const RUN_ORPHANED: &str = "the gateway stopped while this run was in flight";
/// The reason a run parked for a person is closed with once it has expired.
pub(crate) const RUN_PARKED_EXPIRED: &str =
    "the run was parked for a person and was not resumed before it expired";

const DEFAULT_SWEEP_SECONDS: u64 = 60;

/// What one sweep did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SweepReport {
    /// Observation runs closed.
    pub runs_closed: usize,
    /// Rotation jobs parked for reconciliation.
    pub jobs_parked: usize,
}

/// How long a run may stay open before it is nobody's: the policy lease.
pub(crate) fn horizon() -> chrono::Duration {
    chrono::Duration::seconds(RunTiming::default().lease_seconds())
}

fn sweep_interval() -> Duration {
    let seconds = std::env::var("OPENSESAME_WEB_LOGIN_SWEEP_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds >= 1)
        .unwrap_or(DEFAULT_SWEEP_SECONDS);
    Duration::from_secs(seconds)
}

/// The run states in which the agent was still the one driving — the only ones
/// an orphan can be in.
fn agent_was_driving(state: &str) -> bool {
    matches!(state, "agent_driving" | "handoff_requested")
}

/// Close what has outlived `horizon` at `now`.
///
/// # Errors
///
/// The stranded runs cannot be listed. A run or job that cannot be closed is
/// logged and left for the next sweep.
pub(crate) async fn sweep(
    state: &AppState,
    now: DateTime<Utc>,
    horizon: chrono::Duration,
) -> anyhow::Result<SweepReport> {
    let cutoff = now - horizon;
    let stamp = now.to_rfc3339();
    let stranded = state
        .db
        .stranded_observation_runs(&cutoff.to_rfc3339(), &stamp)
        .await?;
    let mut report = SweepReport::default();
    let mut organizations: BTreeMap<String, OrganizationId> = BTreeMap::new();
    for run in &stranded {
        if let Ok(id) = OrganizationId::parse(&run.organization_id) {
            organizations.insert(run.organization_id.clone(), id);
        }
        if close_run(state, run, &stamp).await {
            report.runs_closed += 1;
        }
    }
    for id in crate::lifecycle::scanner::scannable_organizations(state).await {
        organizations.insert(id.to_string(), id);
    }
    for organization_id in organizations.values() {
        report.jobs_parked += park_jobs(state, organization_id, now, cutoff).await;
    }
    Ok(report)
}

async fn close_run(state: &AppState, run: &StrandedRun, stamp: &str) -> bool {
    let orphaned = agent_was_driving(&run.control_state);
    let reason = if orphaned {
        RUN_ORPHANED
    } else {
        RUN_PARKED_EXPIRED
    };
    match state
        .db
        .close_stranded_observation_run(&run.organization_id, &run.run_id, reason, stamp)
        .await
    {
        Ok(true) => {}
        Ok(false) => return false,
        Err(error) => {
            tracing::warn!(%error, run_id = %run.run_id, "a stranded web-login run could not be closed");
            return false;
        }
    }
    tracing::warn!(run_id = %run.run_id, orphaned, "closed a web-login run nobody was running");
    if orphaned {
        let agent_run = AgentRun {
            run_id: run.run_id.clone(),
            job_id: run.job_id.clone(),
            organization_id: run.organization_id.clone(),
            owner_principal_id: run.owner_principal_id.clone(),
            origin: run.target_origin.clone(),
            tier: run.tier.clone(),
            control_state: "suspended".into(),
        };
        announce(state, agent_run, &Outcome::failed(RUN_ORPHANED)).await;
    }
    true
}

async fn park_jobs(
    state: &AppState,
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
    cutoff: DateTime<Utc>,
) -> usize {
    let broker = state.connection_broker.as_ref();
    let stranded = match stranded_web_login_jobs(broker, organization_id, now, cutoff).await {
        Ok(jobs) => jobs,
        Err(error) => {
            tracing::warn!(
                error = %error.hint(),
                organization_id = %organization_id,
                "stranded web-login jobs could not be listed",
            );
            return 0;
        }
    };
    let mut parked = 0;
    let stamp = now.to_rfc3339();
    for stranded in &stranded {
        if park_job(state, &stranded.job).await {
            parked += 1;
            // The claim names the run that held the job. Close that exact run
            // too, so a job is never parked while its run can still be
            // claimed from — the age-based pass above only sees runs older
            // than the horizon, and a run opens a little after its claim.
            if let Some(run_id) = &stranded.run_id {
                close_claimed_run(state, organization_id, run_id, &stamp).await;
            }
        }
    }
    parked
}

/// Close the observation run a lapsed claim named, if it is still open.
async fn close_claimed_run(
    state: &AppState,
    organization_id: &OrganizationId,
    run_id: &str,
    stamp: &str,
) {
    let org = organization_id.to_string();
    let Ok(Some(run)) = state.db.get_observation_run(&org, run_id).await else {
        return;
    };
    if run.closed_at.is_some() {
        return;
    }
    let stranded = StrandedRun {
        organization_id: run.organization_id,
        run_id: run.id,
        job_id: run.job_id,
        owner_principal_id: run.owner_principal_id,
        target_origin: run.target_origin,
        tier: run.tier,
        control_state: run.control_state,
        created_at: run.created_at,
    };
    close_run(state, &stranded, stamp).await;
}

/// Park one stranded job. `false` when it moved in the meantime (a run that
/// settled, another reaper) or could not be written.
async fn park_job(state: &AppState, job: &RotationJob) -> bool {
    let bus = state.task_bus.read().await;
    let parked = reconcile_stranded_web_login_rotation(
        state.connection_broker.as_ref(),
        bus.as_ref(),
        job,
        STRANDED_DETAIL,
    )
    .await;
    match parked {
        Ok(Some(_)) => {
            tracing::warn!(job_id = %job.id, "parked a web-login job its runner never settled");
            true
        }
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(
                error = %error.hint(),
                job_id = %job.id,
                "a stranded web-login job could not be parked",
            );
            false
        }
    }
}

/// The sweep that runs before anything is started: what the last process left
/// behind is closed before this one's scanner adds to it.
pub(crate) async fn reconcile_at_startup(state: &AppState) {
    match sweep(state, Utc::now(), horizon()).await {
        Ok(report) if report == SweepReport::default() => {}
        Ok(report) => tracing::warn!(
            runs_closed = report.runs_closed,
            jobs_parked = report.jobs_parked,
            "startup reconciliation closed web-login work a stopped gateway left behind",
        ),
        Err(error) => tracing::warn!(%error, "startup web-login reconciliation failed"),
    }
}

/// The periodic sweep, for the process's lifetime. The interval is read when
/// the actor is built, not when it is first polled.
pub(crate) fn run(state: AppState) -> impl std::future::Future<Output = ()> {
    let period = sweep_interval();
    async move {
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            state.web_login_runs.reap();
            match sweep(&state, Utc::now(), horizon()).await {
                Ok(report) if report == SweepReport::default() => {}
                Ok(report) => tracing::warn!(
                    runs_closed = report.runs_closed,
                    jobs_parked = report.jobs_parked,
                    "the web-login reaper closed work nobody was running",
                ),
                Err(error) => tracing::warn!(%error, "the web-login reaper failed"),
            }
        }
    }
}
