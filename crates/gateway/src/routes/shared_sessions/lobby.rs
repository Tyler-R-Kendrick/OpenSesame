//! Opening a session, and finding a public one to ask into (ADR 0079 §7,
//! ADR 0137).
//!
//! The two roads a person takes before they have any standing in a session.
//! Split from [`super`] so the admission policy — who lets an asker in — is
//! read and written in one place: the operator states it when opening, and
//! the discovery record tells an asker which answer to expect.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_domain::{
    Admission, JoinDecision, JoinRequest, SessionAdmission, SessionId, SessionMembership,
    SessionVisibility,
};
use opensesame_storage::StoredSession;
use serde::Deserialize;
use serde_json::json;

use super::{announce, bad_request, caller_principal, unavailable, visibility_str};
use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;
use crate::session_channel::SessionEvent;

#[derive(Deserialize)]
pub struct OpenSessionRequest {
    display_name: String,
    /// `private` (default) or `public`. A public session accepts join
    /// requests from strangers; a private one is not discoverable at all.
    visibility: Option<String>,
    /// `operator` (default): the operator admits or refuses each ask.
    /// `observer_on_ask`: whoever asks is seated at once as an observer,
    /// holding nothing — public sessions only (ADR 0137).
    admission: Option<String>,
}

/// The visibility and admission a body asks for, or the refusal. A policy
/// that cannot apply — admitting on ask where nobody can ask — is refused
/// rather than quietly stored.
#[allow(clippy::result_large_err)]
fn policy(body: &OpenSessionRequest) -> Result<(SessionVisibility, SessionAdmission), Response> {
    let visibility = match body.visibility.as_deref() {
        None | Some("private") => SessionVisibility::Private,
        Some("public") => SessionVisibility::Public,
        Some(_) => return Err(bad_request("session_visibility", "private or public")),
    };
    let admission = match body.admission.as_deref() {
        None => SessionAdmission::Operator,
        Some(raw) => SessionAdmission::parse(raw)
            .ok_or_else(|| bad_request("session_admission", "operator or observer_on_ask"))?,
    };
    if !admission.fits(visibility) {
        return Err(bad_request(
            "session_admission",
            "only a public session admits on ask",
        ));
    }
    Ok((visibility, admission))
}

/// `POST /api/v1/shared-sessions` — open one. The caller becomes its operator.
pub async fn open(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<OpenSessionRequest>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let (principal, organization) = match caller_principal(&caller) {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };

    let display_name = body.display_name.trim().to_string();
    if display_name.is_empty() || display_name.chars().count() > 120 {
        return bad_request("session_display_name", "1 to 120 characters");
    }
    let (visibility, admission) = match policy(&body) {
        Ok(policy) => policy,
        Err(resp) => return resp,
    };

    let session = StoredSession {
        id: SessionId::new(),
        organization_id: organization.to_string(),
        operator_principal_id: principal,
        display_name,
        visibility,
        created_at: Utc::now(),
        closed_at: None,
    };
    match st.db.create_session_admitting(&session, admission).await {
        Ok(()) => (
            StatusCode::CREATED,
            Json(json!({
                "id": session.id.to_string(),
                "display_name": session.display_name,
                "visibility": visibility_str(session.visibility),
                "admission": admission.as_str(),
                "operator_principal_id": principal.to_string(),
                "created_at": session.created_at.to_rfc3339(),
            })),
        )
            .into_response(),
        Err(error) => unavailable(&error),
    }
}

#[derive(Deserialize)]
pub struct DiscoverQuery {
    visibility: Option<String>,
}

/// `GET /api/v1/shared-sessions?visibility=public` — the discovery record.
///
/// A name, an id, and how an ask is answered. Not the vault, not the items,
/// not the roster, not who runs it (ADR 0079 §7). Private sessions are never
/// listed here under any query — the parameter is validated rather than
/// defaulted, so a caller who omits it gets a refusal instead of a listing
/// they did not ask for.
pub async fn discover(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<DiscoverQuery>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let (_, organization) = match caller_principal(&caller) {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };
    if query.visibility.as_deref() != Some("public") {
        return bad_request(
            "session_visibility",
            "only public sessions are discoverable",
        );
    }
    let organization = organization.to_string();
    let listed = st.db.public_sessions(&organization).await;
    let on_ask = st.db.sessions_admitting_on_ask(&organization).await;
    match (listed, on_ask) {
        (Ok(sessions), Ok(on_ask)) => Json(json!({
            "sessions": sessions
                .iter()
                .map(|session| json!({
                    "id": session.id.to_string(),
                    "display_name": session.display_name,
                    "admission": if on_ask.contains(&session.id) {
                        SessionAdmission::ObserverOnAsk
                    } else {
                        SessionAdmission::Operator
                    }.as_str(),
                }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        (Err(error), _) | (_, Err(error)) => unavailable(&error),
    }
}

/// Seat an asker under the session's own policy (ADR 0137): as an observer,
/// holding nothing, decided in the operator's name because the operator made
/// this decision once for everybody when they opened the session. The seat
/// is written before the decision, as [`super::join::decide_join_request`] does; if the
/// decision then fails the request stays pending for the operator to answer.
pub(super) async fn admit_on_ask(
    st: &AppState,
    session: &StoredSession,
    request: &JoinRequest,
) -> Response {
    let now = Utc::now();
    let decided_by = session.operator_principal_id;
    let admission = Admission::Observer;
    let seat = SessionMembership::new(
        session.id,
        request.requester_principal_id,
        admission.mode(),
        decided_by,
        now,
    );
    if let Err(error) = st
        .db
        .upsert_session_membership(&session.organization_id, &seat)
        .await
    {
        return unavailable(&error);
    }
    let decision = JoinDecision::Admitted { admission };
    if let Err(error) = st
        .db
        .decide_join_request(
            &session.organization_id,
            request.id,
            decision,
            decided_by,
            now,
            None,
        )
        .await
    {
        return unavailable(&error);
    }
    announce(
        st,
        session.id,
        SessionEvent::ParticipantJoined {
            principal_id: request.requester_principal_id,
            mode: admission.mode(),
        },
    );
    (
        StatusCode::CREATED,
        Json(json!({
            "id": request.id.to_string(),
            "decision": "admitted",
            "mode": super::join::mode_str(admission.mode()),
        })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod admission_tests;
