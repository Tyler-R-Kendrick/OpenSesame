//! Watching a sandboxed run, and taking the page (ADR 0078).
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
/// admitted at a rate the mask solver bounds (ADR 0078 §3), and the action lane
/// moves at the speed of a browser step. A tighter loop would spend queries to
/// deliver the same events.
const TAIL_POLL: Duration = Duration::from_millis(500);

/// Consecutive *idle* polls before the connection closes and the client
/// reconnects. Reset by any progress, so an active run is never cut off
/// mid-step for having been watched a while.
const TAIL_MAX_TICKS: u32 = 600;

/// Longest a control lease is held without being renewed.
///
/// When it expires the run parks — it never returns to the agent (ADR 0078 §7).
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
/// An operator is `Operator` even when it could read the row: ADR 0078 §8's
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

/// Whether this caller has authenticated recently enough to drive.
///
/// Session callers reach the gateway through the same bearer path every other
/// route uses; a dedicated step-up factor is not yet wired, so this reports
/// `Fresh` for a session and `Stale` for anything else. The check is here
/// rather than absent so the entitlement rule is complete and the seam is one
/// function, not a search.
const fn step_up(who: &Caller) -> StepUp {
    match who {
        Caller::Session { .. } => StepUp::Fresh,
        Caller::Operator => StepUp::Stale,
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
        step_up(&who),
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
/// Live and replay are the same read at different cursors (ADR 0078 §1): a
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
    let stream = tail(st, organization_id, run.id, query.after);
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
}

fn tail(
    st: AppState,
    organization_id: String,
    run_id: String,
    after: i64,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let seed = Tail {
        st,
        organization_id,
        run_id,
        cursor: after,
        idle_ticks: 0,
        pending: std::collections::VecDeque::new(),
    };
    futures::stream::unfold(seed, |mut tail| async move {
        loop {
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
) -> Response {
    let lease_expires_at = holder
        .as_ref()
        .map(|_| (Utc::now() + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339());
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
        .update_observation_control(&update, &Utc::now().to_rfc3339())
        .await
    {
        Ok(Some(updated)) => Json(run_view(&updated)).into_response(),
        Ok(None) => (
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
    let response = commit(&st, &organization_id, &run, lease, run.lease_holder.clone()).await;
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
    // is its own edge for exactly that reason (ADR 0078 §7).
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
    commit(&st, &organization_id, &run, lease, Some(holder)).await
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
    commit(&st, &organization_id, &run, lease, None).await
}

fn subject_of(who: &Caller) -> Option<String> {
    match who {
        Caller::Operator => None,
        Caller::Session { subject, .. } => Some(subject.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{test_demo_state, test_session_headers};
    use axum::{body::Body, http::Request, Router};
    use opensesame_domain::OrganizationRole;
    use opensesame_storage::StoredObservationRun;
    use serde_json::Value;
    use tower::ServiceExt;

    const ALICE: &str = "user:alice";
    const BOB: &str = "user:bob";

    fn seed(id: &str, owner: &str, org: &str, state: &str) -> StoredObservationRun {
        StoredObservationRun {
            id: id.into(),
            organization_id: org.into(),
            job_id: "job:1".into(),
            target_origin: "https://example.com".into(),
            tier: "t4".into(),
            control_state: state.into(),
            quiescence: "quiescent".into(),
            handoff_queued: false,
            lease_holder: None,
            lease_expires_at: None,
            owner_principal_id: owner.into(),
            viewer_key_id: "xkey:viewer-1".into(),
            next_seq: 0,
            blocked_reason: None,
            expires_at: "2026-12-31T00:00:00+00:00".into(),
            closed_at: None,
            version: 1,
            created_at: "2026-08-31T00:00:00+00:00".into(),
            updated_at: "2026-08-31T00:00:00+00:00".into(),
        }
    }

    async fn send(
        app: &Router,
        headers: &HeaderMap,
        method: &str,
        uri: &str,
    ) -> (StatusCode, Value) {
        let builder = Request::builder().method(method).uri(uri).header(
            "authorization",
            headers.get("authorization").unwrap().as_bytes(),
        );
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    struct Fixture {
        app: Router,
        state: AppState,
        org: String,
        alice: HeaderMap,
        bob: HeaderMap,
    }

    async fn fixture() -> Fixture {
        let state = test_demo_state().await;
        let org = state.connection_organization;
        let alice = test_session_headers(&state, ALICE, org, OrganizationRole::Owner);
        let bob = test_session_headers(&state, BOB, org, OrganizationRole::Owner);
        Fixture {
            app: crate::routes::router(state.clone()),
            state,
            org: org.to_string(),
            alice,
            bob,
        }
    }

    #[tokio::test]
    async fn the_owner_reads_a_run_and_nobody_else_learns_it_exists() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();

        let (status, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
        assert_eq!(status, StatusCode::OK, "{view}");
        assert_eq!(view["origin"], json!("https://example.com"));
        assert_eq!(view["observation_included"], json!(false));

        // Same organization, different person. 404 rather than 403: whether a
        // run exists is itself account information, and a 403 confirms it.
        let (status, _) = send(&f.app, &f.bob, "GET", "/api/v1/agent/runs/run:1").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_listing_is_scoped_to_the_person_not_the_tenant() {
        let f = fixture().await;
        for (id, owner) in [("run:a", ALICE), ("run:b", BOB)] {
            f.state
                .db
                .create_observation_run(&seed(id, owner, &f.org, "agent_driving"))
                .await
                .unwrap();
        }
        let (status, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs").await;
        assert_eq!(status, StatusCode::OK);
        let runs = view["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1, "{view}");
        assert_eq!(runs[0]["id"], json!("run:a"));
    }

    #[tokio::test]
    async fn a_run_row_never_carries_a_body() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();
        f.state
            .db
            .append_observation_event(&opensesame_storage::ObservationAppend {
                organization_id: &f.org,
                run_id: "run:1",
                lane: "action",
                of_step: None,
                layout_epoch: None,
                payload: b"sealed-bytes",
                recorded_at: "2026-08-31T00:00:00+00:00",
            })
            .await
            .unwrap();

        let (_, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
        let rendered = view.to_string();
        assert!(!rendered.contains("sealed-bytes"), "{rendered}");
        // ADR 0076 §5: a listing never reaches into the log.
        let (_, listing) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs").await;
        assert!(!listing.to_string().contains("sealed-bytes"));
    }

    #[tokio::test]
    async fn taking_the_page_requires_the_run_to_be_parked_first() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
            .await
            .unwrap();

        // There is no path that takes the page out from under a driving agent.
        let (status, _) = send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/control").await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Ask, and the agent parks at its next step.
        let (status, body) =
            send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/handoff").await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(body["status"], json!("accepted"));
    }

    #[tokio::test]
    async fn one_driver_at_a_time_and_the_holder_is_recorded() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
            .await
            .unwrap();

        let (status, view) =
            send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/control").await;
        assert_eq!(status, StatusCode::OK, "{view}");
        assert_eq!(view["driver"], json!("human"));
        assert!(view["lease_expires_at"].is_string());

        // A second person in the same organization is not a second driver, and
        // is not even told the run is there.
        let (status, _) = send(&f.app, &f.bob, "POST", "/api/v1/agent/runs/run:1/control").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn releasing_does_not_resume_autonomy() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
            .await
            .unwrap();
        send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/control").await;

        let (status, view) =
            send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/release").await;
        assert_eq!(status, StatusCode::OK, "{view}");
        // Not agent_driving: the runner re-asserts the run's preconditions
        // against the page before it drives again (ADR 0078 §6).
        assert_eq!(view["control_state"], json!("resume_requested"));
        assert_eq!(view["driver"], json!("agent"));
    }

    #[tokio::test]
    async fn only_the_holder_may_release() {
        let f = fixture().await;
        let mut held = seed("run:1", ALICE, &f.org, "human_driving");
        held.lease_holder = Some(BOB.into());
        held.lease_expires_at = Some("2026-12-31T00:00:00+00:00".into());
        f.state.db.create_observation_run(&held).await.unwrap();

        // Alice owns the credential but Bob holds the lease: she cannot end his
        // turn, and the refusal names contention rather than ownership.
        let (status, _) = send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/release").await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn a_suspended_run_is_claimed_by_a_person_never_resumed_into() {
        let f = fixture().await;
        f.state
            .db
            .create_observation_run(&seed("run:1", ALICE, &f.org, "suspended"))
            .await
            .unwrap();
        let (status, view) =
            send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/control").await;
        assert_eq!(status, StatusCode::OK, "{view}");
        assert_eq!(view["control_state"], json!("human_driving"));
    }

    #[tokio::test]
    async fn a_handoff_inside_the_critical_section_is_queued_and_says_so() {
        let f = fixture().await;
        let mut mid_submit = seed("run:1", ALICE, &f.org, "agent_driving");
        mid_submit.quiescence = "critical".into();
        f.state
            .db
            .create_observation_run(&mid_submit)
            .await
            .unwrap();

        let (status, body) =
            send(&f.app, &f.alice, "POST", "/api/v1/agent/runs/run:1/handoff").await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        // Reported, not dropped: a request that vanishes teaches people to
        // press the button again.
        assert_eq!(body["status"], json!("queued"));

        let (_, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
        assert_eq!(view["control_state"], json!("agent_driving"));
        assert_eq!(view["handoff_queued"], json!(true));
    }
}
