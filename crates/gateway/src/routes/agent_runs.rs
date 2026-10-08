//! Watching a sandboxed run, and taking the page (ADR 0081).
//!
//! Four surfaces, one module each, and the split between them is the design:
//!
//! - **Read** (here) — what runs exist and where they are. Metadata only; ADR
//!   0076 §5 keeps bodies out of any listing, so a run row never carries a
//!   frame, a rationale, or a page.
//! - **Observe** (`stream`) — the sealed log, streamed. The gateway relays
//!   ciphertext it cannot read, so this route is a courier: it decides *who may
//!   read the stream*, and the viewer key decides *what they can make of it*.
//! - **Hook records** (`hook_records`) — the payload-free agent-hooks record of
//!   a Host-run agent (ADR 0159): what a run with no viewer key has in place of
//!   a sealed log.
//! - **Control** (`lease`) — request the page, take it, hand it back. Every
//!   transition goes through `crates/session-observe`'s lease machine and is
//!   written under the version it was decided on, so two gateway processes
//!   cannot both grant it.
//! - **Driver** (`driver`) — the owner's browser claiming and settling steps.
//!
//! Entitlement is `authorize_attach`: the credential's owner, and nobody else.
//! Not a delegate, not an operator, not an agent surface.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use opensesame_session_observe::{
    authorize_attach, AttachRefusal, Attachment, StepUp, ViewerRelation,
};
use opensesame_storage::StoredObservationRun;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{
    resolve_caller, resolve_caller_organization, same_principal_subject, Caller,
};

mod driver;
mod hook_records;
mod lease;
mod outcome;
mod scrub;
mod stream;
#[path = "agent_run_stream_authority.rs"]
mod stream_authority;

/// Every route of this module, for `routes::router` to merge.
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/agent/runs", get(list_runs))
        .route("/api/v1/agent/runs/{id}", get(get_run))
        .route("/api/v1/agent/runs/{id}/observe", get(stream::observe))
        .route("/api/v1/agent/runs/{id}/log", get(stream::read_log))
        // ADR 0159: the payload-free hook record of a Host-run agent.
        .route(
            "/api/v1/agent/runs/{id}/hook-records",
            get(hook_records::read_hook_records),
        )
        .route(
            "/api/v1/agent/runs/{id}/handoff",
            post(lease::request_handoff),
        )
        .route("/api/v1/agent/runs/{id}/control", post(lease::take_control))
        .route(
            "/api/v1/agent/runs/{id}/release",
            post(lease::release_control),
        )
        .route(
            "/api/v1/agent/runs/{id}/steps/claim",
            post(driver::claim_step),
        )
        .route(
            "/api/v1/agent/runs/{id}/steps/{seq}/outcome",
            post(driver::settle_step),
        )
}

#[cfg(test)]
#[path = "agent_run_stream_tests.rs"]
mod stream_tests;

fn refusal(refusal: AttachRefusal) -> Response {
    let status = match refusal {
        AttachRefusal::NotTheOwner | AttachRefusal::AgentSurfacesExcluded => StatusCode::NOT_FOUND,
        AttachRefusal::StepUpRequired => StatusCode::UNAUTHORIZED,
        AttachRefusal::LeaseHeld => StatusCode::CONFLICT,
    };
    // A non-owner gets 404, not 403: whether a given run exists is itself
    // account information, and a 403 would confirm it.
    (
        status,
        Json(json!({"error": refusal_code(refusal), "hint": refusal.to_string()})),
    )
        .into_response()
}

const fn refusal_code(refusal: AttachRefusal) -> &'static str {
    match refusal {
        AttachRefusal::NotTheOwner | AttachRefusal::AgentSurfacesExcluded => "not_found",
        AttachRefusal::StepUpRequired => "step_up_required",
        AttachRefusal::LeaseHeld => "lease_held",
    }
}

/// How this caller stands to the run.
///
/// An operator is `Operator` even when it could read the row: ADR 0081 §8's
/// point is that reading somebody's session is not an operations capability.
fn relation(who: &Caller, run: &StoredObservationRun) -> ViewerRelation {
    match who {
        Caller::Operator => ViewerRelation::Operator,
        Caller::Session { subject, .. } => {
            if same_principal_subject(subject, &run.owner_principal_id) {
                ViewerRelation::CredentialOwner
            } else {
                ViewerRelation::Delegate
            }
        }
    }
}

/// Recent verified Identity evidence is necessary, not sufficient: commit also
/// consumes a purpose-bound elevation atomically with the control transition.
fn step_up(st: &AppState, headers: &HeaderMap) -> StepUp {
    let Ok(claims) = super::host_authorizations::browser_claims(st, headers) else {
        return StepUp::Stale;
    };
    if claims.assurance == crate::session_claims::Assurance::PhishingResistant
        && claims.amr == ["webauthn"]
        && claims.auth_time <= Utc::now()
        && claims.auth_time >= Utc::now() - chrono::Duration::seconds(300)
    {
        StepUp::Fresh
    } else {
        StepUp::Stale
    }
}

/// Public view of a run. Metadata only — never a lane body.
fn run_view(run: &StoredObservationRun) -> serde_json::Value {
    json!({
        "id": run.id,
        "job_id": run.job_id,
        "origin": run.target_origin,
        "tier": run.tier,
        "control_state": run.control_state,
        "quiescence": run.quiescence,
        "handoff_queued": run.handoff_queued,
        "driver": if run.lease_holder.is_some() { "human" } else { "agent" },
        "lease_expires_at": run.lease_expires_at,
        "blocked_reason": run.blocked_reason,
        "next_seq": run.next_seq,
        "expires_at": run.expires_at,
        "closed_at": run.closed_at,
        "version": run.version,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
        // What observes the run: a sealed log, or, for a run the Host opened
        // with no viewer key to seal to, its hook records alone.
        "observation": hook_records::observation_kind(run),
        // Explicit non-disclosure, mirroring the rotation routes.
        "secrets_returned": false,
        "observation_included": false,
    })
}

async fn load(
    st: &AppState,
    headers: &HeaderMap,
    run_id: &str,
    attachment: Attachment,
) -> Result<(Caller, String, StoredObservationRun), Response> {
    let who = resolve_caller(st, headers)?;
    let organization_id = resolve_caller_organization(st, &who, headers)?.to_string();
    let run = st
        .db
        .get_observation_run(&organization_id, run_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "observation run could not be read");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response()
        })?
        .ok_or_else(|| {
            (StatusCode::NOT_FOUND, Json(json!({"error": "not_found"}))).into_response()
        })?;
    let lease_held_by_other = run
        .lease_holder
        .as_deref()
        .is_some_and(|holder| !holder_is_caller(&who, holder));
    authorize_attach(
        relation(&who, &run),
        attachment,
        step_up(st, headers),
        lease_held_by_other,
    )
    .map_err(refusal)?;
    if attachment == Attachment::View {
        if let Err(response) = stream_authority::ensure_view_authority(st, headers).await {
            return Err(response);
        }
    }
    Ok((who, organization_id, run))
}

fn holder_is_caller(who: &Caller, holder: &str) -> bool {
    match who {
        Caller::Operator => false,
        Caller::Session { subject, .. } => same_principal_subject(subject, holder),
    }
}

/// `GET /api/v1/agent/runs` — the caller's own runs, newest first.
pub async fn list_runs(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id.to_string(),
        Err(response) => return response,
    };
    let runs = match st.db.list_observation_runs(&organization_id, 100).await {
        Ok(runs) => runs,
        Err(error) => {
            tracing::error!(%error, "observation runs could not be listed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response();
        }
    };
    // Filtered by entitlement, not merely by tenant: an organization is not a
    // person, and a run belongs to whoever's credential it rotates.
    let mine: Vec<_> = runs
        .iter()
        .filter(|run| relation(&who, run) == ViewerRelation::CredentialOwner)
        .map(run_view)
        .collect();
    Json(json!({"runs": mine, "secrets_returned": false})).into_response()
}

/// `GET /api/v1/agent/runs/{id}` — one run's state.
pub async fn get_run(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::View).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    // Metadata beside metadata: how many verdicts the run met and of which
    // kinds, never what they were about (ADR 0159).
    let summary = match hook_records::summary_of(&st, &organization_id, &run.id).await {
        Ok(summary) => summary,
        Err(response) => return response,
    };
    let mut view = run_view(&run);
    view["hook_records"] = summary;
    Json(view).into_response()
}

fn subject_of(who: &Caller) -> Option<String> {
    match who {
        Caller::Operator => None,
        Caller::Session { subject, .. } => Some(subject.clone()),
    }
}

#[cfg(test)]
#[path = "agent_runs_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "agent_runs_tests_tail.rs"]
mod tests_tail;

#[cfg(test)]
#[path = "agent_run_credentials_tests.rs"]
mod credentials_tests;
