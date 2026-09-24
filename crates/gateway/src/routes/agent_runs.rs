//! Watching a sandboxed run, and taking the page (ADR 0081).
//!
//! Three surfaces, and the split between them is the design:
//!
//! - **Read** — what runs exist and where they are. Metadata only; ADR 0076 §5
//!   keeps bodies out of any listing, so a run row never carries a frame, a
//!   rationale, or a page.
//! - **Observe** — the sealed log, streamed. The gateway relays ciphertext it
//!   cannot read, so this route is a courier: it decides *who may read the
//!   stream*, and the viewer key decides *what they can make of it*.
//! - **Control** — request the page, take it, hand it back. Every transition
//!   goes through `crates/session-observe`'s lease machine and is written under
//!   the version it was decided on, so two gateway processes cannot both grant
//!   it.
//!
//! Entitlement is `authorize_attach`: the credential's owner, and nobody else.
//! Not a delegate, not an operator, not an agent surface.

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{sse::Event, IntoResponse, Response, Sse},
    Json,
};
use chrono::Utc;
use futures::stream::Stream;
use opensesame_session_observe::{
    authorize_attach, AttachRefusal, Attachment, ControlLease, ControlState, HandoffOutcome,
    Quiescence, StepUp, ViewerRelation,
};
use opensesame_storage::{ObservationControlUpdate, StoredObservationRun};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{
    resolve_caller, resolve_caller_organization, same_principal_subject, Caller,
};

/// How often the observe stream looks for new entries.
///
/// The log is a database table, not a broadcast channel, so a tail is a poll.
/// 500ms is chosen against what the stream actually carries: frames are
/// admitted at a rate the mask solver bounds (ADR 0081 §3), and the action lane
/// moves at the speed of a browser step. A tighter loop would spend queries to
/// deliver the same events.
const TAIL_POLL: Duration = Duration::from_millis(500);

/// Consecutive *idle* polls before the connection closes and the client
/// reconnects. Reset by any progress, so an active run is never cut off
/// mid-step for having been watched a while.
const TAIL_MAX_TICKS: u32 = 600;

/// Longest a control lease is held without being renewed.
///
/// When it expires the run parks — it never returns to the agent (ADR 0081 §7).
pub const LEASE_SECONDS: i64 = 900;

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
    match load(&st, &headers, &run_id, Attachment::View).await {
        Ok((_, _, run)) => Json(run_view(&run)).into_response(),
        Err(response) => response,
    }
}

#[derive(Debug, Deserialize)]
pub struct ObserveQuery {
    /// Last sequence number the client already has. Omit to read from the
    /// beginning — the same call the replay overlay makes.
    #[serde(default = "default_after")]
    pub after: i64,
}

const fn default_after() -> i64 {
    -1
}

/// `GET /api/v1/agent/runs/{id}/observe` — the sealed log, tailed.
///
/// Live and replay are the same read at different cursors (ADR 0081 §1): a
/// viewer passes its last position and gets the tail, the overlay passes an
/// earlier one and gets a seek. There is no second pipeline, so there is no
/// code that could be live-only and therefore no redaction that could apply on
/// one path and not the other.
///
/// Every event is relayed as the ciphertext it was sealed as. The gateway is a
/// courier here in the strict sense: it cannot read what it is forwarding.
pub async fn observe(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<ObserveQuery>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::View).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let authority = match stream_authority::StreamAuthority::capture(&st, &headers) {
        Ok(authority) => authority,
        Err(response) => return response,
    };
    let stream = tail(st, organization_id, run.id, query.after, authority);
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

/// Cursor and buffer for one open observe connection.
struct Tail {
    st: AppState,
    organization_id: String,
    run_id: String,
    cursor: i64,
    idle_ticks: u32,
    pending: std::collections::VecDeque<Event>,
    authority: stream_authority::StreamAuthority,
}

#[path = "agent_run_stream_authority.rs"]
mod stream_authority;

#[cfg(test)]
#[path = "agent_run_stream_tests.rs"]
mod stream_tests;

/// `GET /api/v1/agent/runs/{id}/log` — one page of the sealed log.
///
/// The same read as `observe`, without holding a connection open. Two callers
/// want this rather than a stream: the replay overlay, which seeks and pages
/// rather than follows, and anything scripted, for which an SSE stream that
/// stays open until it times out is a hang rather than a result.
///
/// Entries are relayed as the ciphertext they were sealed as, exactly as the
/// stream relays them. `sealed: true` says so rather than leaving a caller to
/// discover it.
pub async fn read_log(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<ObserveQuery>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::View).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let entries = match st
        .db
        .read_observation_events(&organization_id, &run.id, query.after, OBSERVE_BATCH)
        .await
    {
        Ok(entries) => entries,
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "observation log could not be read");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response();
        }
    };
    let next = entries.last().map_or(query.after, |entry| entry.seq);
    let rendered: Vec<_> = entries
        .iter()
        .map(|entry| {
            json!({
                "seq": entry.seq,
                "lane": entry.lane,
                "of_step": entry.of_step,
                "layout_epoch": entry.layout_epoch,
                "sealed_payload": base64_std(&entry.payload),
                "recorded_at": entry.recorded_at,
            })
        })
        .collect();
    Json(json!({
        "run_id": run.id,
        "entries": rendered,
        "next_after": next,
        "run_next_seq": run.next_seq,
        "sealed": true,
        "secrets_returned": false,
    }))
    .into_response()
}

fn tail(
    st: AppState,
    organization_id: String,
    run_id: String,
    after: i64,
    authority: stream_authority::StreamAuthority,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let seed = Tail {
        st,
        organization_id,
        run_id,
        cursor: after,
        idle_ticks: 0,
        pending: std::collections::VecDeque::new(),
        authority,
    };
    futures::stream::unfold(seed, |mut tail| async move {
        loop {
            if !tail.authority.active(&tail.st, &tail.run_id).await {
                return None;
            }
            if let Some(event) = tail.pending.pop_front() {
                return Some((Ok(event), tail));
            }
            if tail.idle_ticks >= TAIL_MAX_TICKS {
                return None;
            }
            let batch = tail
                .st
                .db
                .read_observation_events(
                    &tail.organization_id,
                    &tail.run_id,
                    tail.cursor,
                    OBSERVE_BATCH,
                )
                .await
                .unwrap_or_default();
            if batch.is_empty() {
                tail.idle_ticks += 1;
                tokio::time::sleep(TAIL_POLL).await;
                continue;
            }
            // Progress resets the idle budget: a connection that is actively
            // carrying a run should not be cut off mid-run for having been open
            // a while.
            tail.idle_ticks = 0;
            for entry in batch {
                tail.cursor = entry.seq;
                tail.pending.extend(sse_event(&entry));
            }
        }
    })
}

/// One log entry as an SSE frame.
///
/// The payload is relayed as the ciphertext it was sealed as: this route is a
/// courier in the strict sense, and there is no branch here that could read it.
fn sse_event(entry: &opensesame_storage::StoredObservationEvent) -> Option<Event> {
    Event::default()
        .json_data(json!({
            "seq": entry.seq,
            "lane": entry.lane,
            "of_step": entry.of_step,
            "layout_epoch": entry.layout_epoch,
            "sealed": base64_std(&entry.payload),
            "recorded_at": entry.recorded_at,
        }))
        .ok()
}

/// Events read per poll.
const OBSERVE_BATCH: usize = 64;

fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

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
    let Ok(claims) = super::host_authorizations::browser_claims(st, headers) else {
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

fn subject_of(who: &Caller) -> Option<String> {
    match who {
        Caller::Operator => None,
        Caller::Session { subject, .. } => Some(subject.clone()),
    }
}

#[cfg(test)]
#[path = "agent_runs_tests.rs"]
mod tests;

// —— the driver's half of the step channel (ADR 0079 §4) ————————————

/// `POST /api/v1/agent/runs/{id}/steps/claim` — take the run's outstanding step.
///
/// The driver here is the owner's own browser, so the entitlement is the same
/// one that gates watching: a run belongs to whoever's credential it rotates,
/// and nobody else may drive it. Claiming is `Attachment::Control` for exactly
/// that reason — issuing input events into an authenticated third-party session
/// is the thing control means.
///
/// Returns 204 when there is nothing to do, so a polling driver has a cheap
/// answer rather than an error to interpret.
pub async fn claim_step(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Response {
    let (who, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await
    {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let Some(claimant) = subject_of(&who) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    let now = Utc::now();
    let expires_at = now + chrono::Duration::seconds(opensesame_storage::STEP_CLAIM_SECONDS);
    match st
        .db
        .claim_runner_step(
            &organization_id,
            &run.id,
            &claimant,
            &now.to_rfc3339(),
            &expires_at.to_rfc3339(),
        )
        .await
    {
        Ok(Some(step)) => Json(json!({
            "run_id": step.run_id,
            "seq": step.seq,
            // The StepRequest, verbatim. It names a credential reference and a
            // selector; it has no field able to carry a value.
            "request": serde_json::from_str::<serde_json::Value>(&step.request_json)
                .unwrap_or(serde_json::Value::Null),
            "claim_expires_at": step.claim_expires_at,
            "secrets_returned": false,
        }))
        .into_response(),
        // Nothing pending, or somebody else holds a live claim. A polling
        // driver wants a cheap answer here, not an error to interpret.
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "runner step could not be claimed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct OutcomeBody {
    /// The `StepOutcome`. Validated as JSON here and interpreted by the
    /// executor, which is the side that knows what it asked for.
    pub outcome: serde_json::Value,
}

/// `POST /api/v1/agent/runs/{id}/steps/{seq}/outcome` — report what happened.
///
/// Only the claimant may, and a claim that lapsed is not a claim. A driver that
/// went away and came back finds its step taken and is told so, rather than
/// settling a step somebody else is now executing.
pub async fn settle_step(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((run_id, seq)): Path<(String, i64)>,
    Json(body): Json<OutcomeBody>,
) -> Response {
    let (who, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await
    {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let Some(claimant) = subject_of(&who) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    let Ok(encoded) = serde_json::to_string(&body.outcome) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_request", "hint": "outcome is not encodable"})),
        )
            .into_response();
    };
    match st
        .db
        .settle_runner_step(
            &organization_id,
            &run.id,
            seq,
            &claimant,
            &encoded,
            &Utc::now().to_rfc3339(),
        )
        .await
    {
        Ok(true) => (StatusCode::OK, Json(json!({"status": "settled"}))).into_response(),
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "not_the_claimant",
                "hint": "this step is not yours to settle; claim it again"
            })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "runner step could not be settled");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod step_channel_tests {
    use super::tests::{fixture, seed};
    use axum::http::StatusCode;
    use serde_json::json;

    const ALICE: &str = "principal:00000000-0000-4000-8000-000000000011";

    #[tokio::test]
    async fn a_driver_claims_a_step_then_settles_it() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();
        f.state
            .db
            .enqueue_runner_step(
                &f.org,
                "run:1",
                0,
                r#"{"step":"navigate","url":"https://example.com"}"#,
                "2026-08-31T00:00:00+00:00",
            )
            .await
            .unwrap();

        let (status, claimed) = f
            .browser
            .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{claimed}");
        assert_eq!(claimed["seq"], json!(0));
        assert_eq!(claimed["request"]["step"], json!("navigate"));
        assert_eq!(claimed["secrets_returned"], json!(false));

        let (status, settled) = f
            .browser
            .send(
                &f.app,
                "POST",
                "/api/v1/agent/runs/run:1/steps/0/outcome",
                Some(json!({"outcome": {"outcome": "done"}})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{settled}");
        assert_eq!(settled["status"], json!("settled"));
    }

    #[tokio::test]
    async fn nothing_to_do_answers_cheaply() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();
        let (status, _) = f
            .browser
            .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn somebody_elses_run_is_not_drivable_and_does_not_admit_it_exists() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();
        f.state
            .db
            .enqueue_runner_step(
                &f.org,
                "run:1",
                0,
                r#"{"step":"navigate","url":"https://example.com"}"#,
                "2026-08-31T00:00:00+00:00",
            )
            .await
            .unwrap();

        let (status, _) = f
            .other_browser
            .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_step_nobody_claimed_cannot_be_settled() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();
        f.state
            .db
            .enqueue_runner_step(
                &f.org,
                "run:1",
                0,
                r##"{"step":"submit","selector":"#save"}"##,
                "2026-08-31T00:00:00+00:00",
            )
            .await
            .unwrap();

        let (status, body) = f
            .browser
            .send(
                &f.app,
                "POST",
                "/api/v1/agent/runs/run:1/steps/0/outcome",
                Some(json!({"outcome": {"outcome": "done"}})),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"], json!("not_the_claimant"));
    }
}
