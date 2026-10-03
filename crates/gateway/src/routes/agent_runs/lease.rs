//! Control of a run's page: ask for it, take it, hand it back (ADR 0081 §5-§7).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_session_observe::{
    AttachRefusal, Attachment, ControlLease, ControlState, HandoffOutcome, Quiescence,
};
use opensesame_storage::{ObservationControlUpdate, StoredObservationRun};
use serde::Deserialize;
use serde_json::json;

use super::{holder_is_caller, load, refusal, run_view, subject_of};
use crate::app_state::AppState;

/// Longest a control lease is held without being renewed.
///
/// When it expires the run parks — it never returns to the agent (ADR 0081 §7).
pub const LEASE_SECONDS: i64 = 900;

/// Rebuild the lease machine from the persisted run.
///
/// The database holds a projection; `ControlLease` holds the rules. Reading the
/// projection back into the machine before every transition is what stops the
/// two from drifting — a state the machine forbids cannot be reached by writing
/// a column, because the write only happens if the machine allowed it first.
fn lease_from(run: &StoredObservationRun) -> Option<ControlLease> {
    let state = match run.control_state.as_str() {
        "agent_driving" => ControlState::AgentDriving,
        "handoff_requested" => ControlState::HandoffRequested,
        "awaiting_human" => ControlState::AwaitingHuman,
        "human_driving" => ControlState::HumanDriving,
        "resume_requested" => ControlState::ResumeRequested,
        "suspended" => ControlState::Suspended,
        _ => return None,
    };
    let quiescence = match run.quiescence.as_str() {
        "quiescent" => Quiescence::Quiescent,
        "critical" => Quiescence::Critical,
        _ => return None,
    };
    ControlLease::restore(state, quiescence, run.handoff_queued)
}

const fn state_name(state: ControlState) -> &'static str {
    match state {
        ControlState::AgentDriving => "agent_driving",
        ControlState::HandoffRequested => "handoff_requested",
        ControlState::AwaitingHuman => "awaiting_human",
        ControlState::HumanDriving => "human_driving",
        ControlState::ResumeRequested => "resume_requested",
        ControlState::Suspended => "suspended",
    }
}

const fn quiescence_name(quiescence: Quiescence) -> &'static str {
    match quiescence {
        Quiescence::Quiescent => "quiescent",
        Quiescence::Critical => "critical",
    }
}

/// Persist a lease transition under the version it was decided on.
///
/// A stale version means somebody else moved first, and the caller is told to
/// re-read rather than winning by writing second. That is what makes "exactly
/// one driver" hold across gateway processes and not merely within one.
async fn commit(
    st: &AppState,
    organization_id: &str,
    run: &StoredObservationRun,
    lease: ControlLease,
    holder: Option<String>,
    authorization: (&HeaderMap, Option<ControlRequest>, &str),
) -> Response {
    let (headers, request, transition) = authorization;
    let Ok(claims) = crate::routes::host_authorizations::browser_claims(st, headers) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    let Some(request) = request.filter(|request| {
        request.elevation.len() == 64 && request.elevation.bytes().all(|b| b.is_ascii_hexdigit())
    }) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    let lease_expires_at = holder.as_ref().map(|_| {
        (Utc::now() + chrono::Duration::seconds(LEASE_SECONDS))
            .min(claims.expires_at)
            .min(claims.auth_time + chrono::Duration::seconds(300))
            .to_rfc3339()
    });
    let update = ObservationControlUpdate {
        run_id: run.id.clone(),
        organization_id: organization_id.to_string(),
        expected_version: run.version,
        control_state: state_name(lease.state()).into(),
        quiescence: quiescence_name(lease.quiescence()).into(),
        handoff_queued: lease.handoff_queued(),
        lease_holder: holder,
        lease_expires_at,
        blocked_reason: run.blocked_reason.clone(),
    };
    match st
        .db
        .control_with_host_authorization(
            &claims.client_id,
            &opensesame_claims::hash_secret(&request.elevation),
            transition,
            &update,
            Utc::now().timestamp(),
        )
        .await
    {
        Ok(true) => match st.db.get_observation_run(organization_id, &run.id).await {
            Ok(Some(updated)) => Json(run_view(&updated)).into_response(),
            _ => unreadable_run(),
        },
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "stale_version",
                "hint": "the run moved while you were deciding; re-read it and try again"
            })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "control transition could not be written");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    elevation: String,
}

fn lease_error(error: &opensesame_session_observe::ControlError) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error": "invalid_transition", "hint": error.to_string()})),
    )
        .into_response()
}

fn unreadable_run() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal", "hint": "run state is not a state"})),
    )
        .into_response()
}

/// `POST /api/v1/agent/runs/{id}/handoff` — ask the agent for the page.
///
/// Accepted at a quiescent point and **queued** inside the critical section,
/// where the answer is reported as queued rather than dropped: a request that
/// vanishes teaches people to press the button again, and the span between the
/// candidate assertion and the submit is the one place a second actor would
/// void the check that stands between a rotation and a lockout.
pub async fn request_handoff(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    request: Option<Json<ControlRequest>>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let Some(mut lease) = lease_from(&run) else {
        return unreadable_run();
    };
    let outcome = match lease.request_handoff() {
        Ok(outcome) => outcome,
        Err(error) => return lease_error(&error),
    };
    let response = commit(
        &st,
        &organization_id,
        &run,
        lease,
        run.lease_holder.clone(),
        (&headers, request.map(|Json(value)| value), "handoff"),
    )
    .await;
    if response.status() != StatusCode::OK {
        return response;
    }
    let queued = outcome == HandoffOutcome::Queued;
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "status": if queued { "queued" } else { "accepted" },
            "hint": if queued {
                "the agent is mid-submit; you will get the page when it finishes"
            } else {
                "the agent will park at its next step"
            },
        })),
    )
        .into_response()
}

/// `POST /api/v1/agent/runs/{id}/control` — take the page.
///
/// Only from a parked run. There is no path that takes the page out from under
/// the agent mid-step: it parks first, which is what makes the receipt able to
/// say who did what.
pub async fn take_control(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    request: Option<Json<ControlRequest>>,
) -> Response {
    let (who, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await
    {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let Some(mut lease) = lease_from(&run) else {
        return unreadable_run();
    };
    // A suspended run is claimed by a person, never resumed into. Re-attaching
    // is its own edge for exactly that reason (ADR 0081 §7).
    if lease.state() == ControlState::Suspended {
        if let Err(error) = lease.reattach() {
            return lease_error(&error);
        }
    }
    if let Err(error) = lease.grant_control() {
        return lease_error(&error);
    }
    let Some(holder) = subject_of(&who) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    commit(
        &st,
        &organization_id,
        &run,
        lease,
        Some(holder),
        (&headers, request.map(|Json(value)| value), "take"),
    )
    .await
}

/// `POST /api/v1/agent/runs/{id}/release` — hand the page back.
///
/// Autonomy does not resume here. The run lands in `resume_requested`, and the
/// runner re-asserts the preconditions against the page before it drives again
/// — what the assertion established was true of a page the agent controlled,
/// and a person has been in it since.
pub async fn release_control(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    request: Option<Json<ControlRequest>>,
) -> Response {
    let (who, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await
    {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    if !run
        .lease_holder
        .as_deref()
        .is_some_and(|holder| holder_is_caller(&who, holder))
    {
        return refusal(AttachRefusal::LeaseHeld);
    }
    let Some(mut lease) = lease_from(&run) else {
        return unreadable_run();
    };
    if let Err(error) = lease.release() {
        return lease_error(&error);
    }
    commit(
        &st,
        &organization_id,
        &run,
        lease,
        None,
        (&headers, request.map(|Json(value)| value), "release"),
    )
    .await
}
