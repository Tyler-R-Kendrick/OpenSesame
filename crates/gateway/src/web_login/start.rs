//! Starting a web-login run from the lifecycle scanner (ADR 0074, ADR 0159).
//!
//! The scanner is one loop over every tenant's deadlines. A web-login run
//! takes up to 15 minutes, each step waiting on a person's browser, so running
//! it inline would hold every other tenant's certificate renewal behind it —
//! and one tenant's slow browser would decide when another tenant's
//! credentials rotate. [`start`] hands the run to the process's
//! [`RunRegistry`](super::registry::RunRegistry) and answers at once with
//! [`Outcome::started`]; the dispatcher then publishes nothing, because
//! nothing has happened yet that a subscriber could act on. The task publishes
//! the run's real outcome itself — the `agent.*` event from the launcher, and
//! the lifecycle outcome event from here — through the same feed and the same
//! dispatcher code, when the run ends.
//!
//! What was decided inline before is decided by the task now, and unchanged:
//! the policy lease is claimed when the run *starts executing*, so a second
//! process — or a second rung for the same policy in this one — cannot start a
//! duplicate. A start for a target that already has a task is answered here,
//! before any task is made.

use chrono::Utc;
use opensesame_connection_broker::rotation::web_login::web_login_run_in_flight;
use opensesame_connection_broker::RotationTarget;
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::LifecycleEvent;

use super::registry::Refused;
use super::WebLoginLauncher;
use crate::app_state::AppState;
use crate::lifecycle::dispatch::settle_outcome;
use crate::lifecycle::responders::{enabled_policy_for, rotation_target, Outcome};

/// The registry key for one organization's run against one origin.
fn key_of(organization_id: &OrganizationId, origin: &str) -> String {
    format!("{organization_id}|{origin}")
}

/// Start the web-login run `event` calls for, and return without waiting for
/// it.
pub(crate) async fn start(state: &AppState, event: &LifecycleEvent) -> Outcome {
    let Some(target) = rotation_target(event) else {
        return Outcome::failed("subject kind is not a web-login rotation target");
    };
    let RotationTarget::WebLogin { origin } = &target else {
        return Outcome::failed("subject kind is not a web-login rotation target");
    };
    let Ok(organization_id) = OrganizationId::parse(&event.subject.organization_id) else {
        return Outcome::failed("subject carries a non-canonical organization id");
    };
    let policy = enabled_policy_for(state, event, &target).await;

    let task_state = state.clone();
    let task_event = event.clone();
    let task_origin = origin.clone();
    let started = state.web_login_runs.spawn(
        &organization_id.to_string(),
        key_of(&organization_id, origin),
        async move {
            let launcher = WebLoginLauncher::from_state(&task_state);
            let outcome = launcher
                .rotate(&task_event, &task_origin, &organization_id, policy)
                .await;
            settle_outcome(&task_state, &task_event, &outcome, Utc::now()).await;
        },
    );
    match started {
        Ok(()) => Outcome::started(format!("web-login rotation for {origin} started")),
        // A run already queued or executing holds the target. It may be a
        // scheduled run (which reports its own outcome) or an attended one
        // (which publishes none), so this rung claims no outcome: nothing is
        // published for it and the expiry alert stays open.
        Err(Refused::InFlight) => Outcome::held(format!(
            "web-login rotation for {origin} skipped: a run for it is already in flight"
        )),
        Err(Refused::Full) => Outcome::failed(
            "web-login rotation was not started: the runner has too many runs queued",
        ),
    }
}

/// Whether a runner on any replica already holds a job for `origin` — the
/// conflict an attended request answers with `409` rather than queueing a run
/// that would be refused. A read that fails answers `false`: the broker's
/// insert is what decides, and it decides atomically.
pub(crate) async fn run_held(
    state: &AppState,
    organization_id: &OrganizationId,
    origin: &str,
) -> bool {
    web_login_run_in_flight(state.connection_broker.as_ref(), organization_id, origin)
        .await
        .unwrap_or(false)
}

/// Start the attended run a person asked for — one run of `origin`'s recipe
/// for `owner`, who drives it — and return without waiting for it.
///
/// It takes the registry slot a scheduled run of the same target would, so
/// within this process the two are never both in flight. Across replicas
/// sharing the database the registry is not shared: there the guarantee is the
/// broker's, which refuses to create a claimed job for a target a runner
/// already holds (`BrokerError::RunInFlight`; see [`run_held`] for asking
/// first) — it covers runs started through the claimed-job path, which both
/// attended and scheduled runs use, and not a job left `scheduled` for the
/// generic consumer. It publishes its own outcome on the `agent.*` feed when
/// it ends.
///
/// # Errors
///
/// [`Refused::InFlight`] when a run for the target is already queued or
/// executing; [`Refused::Full`] when the runner has too many queued.
pub(crate) fn start_attended(
    state: &AppState,
    organization_id: &OrganizationId,
    origin: &str,
    owner: &str,
) -> Result<(), Refused> {
    let task_state = state.clone();
    let task_org = *organization_id;
    let task_origin = origin.to_owned();
    let task_owner = owner.to_owned();
    state.web_login_runs.spawn(
        &organization_id.to_string(),
        key_of(organization_id, origin),
        async move {
            let launcher = WebLoginLauncher::from_state(&task_state);
            let outcome = launcher
                .rotate_attended(&task_org, &task_origin, &task_owner)
                .await;
            tracing::info!(
                succeeded = outcome.succeeded,
                "an attended web-login run ended"
            );
        },
    )
}
