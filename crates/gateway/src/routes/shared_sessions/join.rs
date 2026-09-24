//! Join requests: a stranger asking in, and the operator's answer
//! (ADR 0079 §7).
//!
//! Split from [`super::shared_sessions`] because deciding is the one place in
//! this feature where three things land together — a decision, a seat, and
//! sometimes a grant — and the rule tying them is worth reading in one piece.
//!
//! **Admission is a named seat.** ADR 0079 said admission *is* a grant, so
//! that nobody could be admitted into the room with nothing. Coordination
//! sessions make the first half wrong and the second half more important: an
//! observer really is admitted holding nothing, so the operator says
//! `observer` and that is the seat. What is still unrepresentable is an
//! admission that says neither — the body carries a mode, the mode decides
//! whether a grant is required, and a body that disagrees with itself is
//! refused rather than resolved.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_domain::{
    Admission, JoinDecision, JoinRequest, JoinRequestId, PrincipalId, SessionAdmission,
    SessionGrant, SessionId, SessionMembership, SessionMode, SessionVisibility,
};
use serde::Deserialize;
use serde_json::json;

use super::lobby::admit_on_ask;
use super::{
    announce, bad_request, grant_from, not_found, operator_entry, standing, unavailable,
    GrantRequest,
};
use crate::app_state::AppState;
use crate::session_channel::SessionEvent;

#[derive(Deserialize)]
pub struct AskToJoinRequest {
    note: Option<String>,
}

/// `POST /api/v1/shared-sessions/{id}/join-requests` — a stranger asks in.
///
/// Only a public session accepts one. A private session answers `404` to a
/// non-participant here exactly as it does everywhere else, so this route
/// cannot be used to probe for private sessions by id.
pub async fn ask_to_join(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<AskToJoinRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if session.visibility != SessionVisibility::Public && !reach.may_see_session() {
        return not_found();
    }
    if session.closed_at.is_some() {
        return not_found();
    }
    if reach.may_see_session() {
        return bad_request("already_in_session", "you are already in this session");
    }

    let admission = match st
        .db
        .session_admission(&session.organization_id, session.id)
        .await
    {
        Ok(admission) => admission,
        Err(error) => return unavailable(&error),
    };
    let request = match JoinRequest::new(
        JoinRequestId::new(),
        session.id,
        principal,
        body.note.clone(),
        Utc::now(),
    ) {
        Ok(request) => request,
        Err(error) => return bad_request("join_request_refused", &error.to_string()),
    };
    match st
        .db
        .insert_join_request(&session.organization_id, &request)
        .await
    {
        // A session that admits on ask seats the asker now (ADR 0137).
        Ok(()) if admission == SessionAdmission::ObserverOnAsk => {
            admit_on_ask(&st, &session, &request).await
        }
        // The requester learns their request is pending and nothing else: no
        // roster, no channel, no peer (ADR 0079 §7).
        Ok(()) => {
            announce(
                &st,
                session.id,
                SessionEvent::JoinRequested {
                    request_id: request.id,
                },
            );
            (
                StatusCode::ACCEPTED,
                Json(json!({"id": request.id.to_string(), "decision": "pending"})),
            )
                .into_response()
        }
        Err(error) => {
            // The partial unique index refuses a second pending ask from the
            // same principal. Asking twice is the same ask, so report the
            // state rather than an error.
            tracing::debug!(%error, "join request refused by the store");
            (
                StatusCode::CONFLICT,
                Json(json!({"error": "join_request_pending"})),
            )
                .into_response()
        }
    }
}

/// `GET /api/v1/shared-sessions/{id}/join-requests` — who is waiting.
pub async fn list_join_requests(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.is_operator() {
        return not_found();
    }
    match st.db.pending_join_requests(session.id).await {
        Ok(requests) => Json(json!({
            "requests": requests
                .iter()
                .map(|request| json!({
                    "id": request.id.to_string(),
                    "requester_principal_id": request.requester_principal_id.to_string(),
                    // Untrusted text written by somebody with no standing in
                    // the session. Bounded by the domain at 280 characters;
                    // whatever renders it escapes it.
                    "note": request.note,
                    "requested_at": request.requested_at.to_rfc3339(),
                }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(error) => unavailable(&error),
    }
}

#[derive(Deserialize)]
pub struct DecideRequest {
    /// `admitted` or `refused`.
    decision: String,
    /// `observer` or `participant`. Required for `admitted`, forbidden for
    /// `refused`. There is no default: an operator letting somebody in says
    /// whether that person may be given keys, and inferring it from whether a
    /// grant happens to be attached would make a missing field decide it.
    mode: Option<String>,
    /// Required for a `participant` admission and forbidden for every other
    /// shape. A grant beside an observer admission is the contradiction this
    /// route exists to refuse: a key wrapped for somebody the operator just
    /// said needs none, which ADR 0079 §3 cannot take back.
    grant: Option<GrantRequest>,
}

/// `POST /api/v1/shared-sessions/{id}/join-requests/{request_id}/decide`
pub async fn decide_join_request(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, request_id)): Path<(String, String)>,
    Json(body): Json<DecideRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.is_operator() {
        return not_found();
    }
    let Ok(request_id) = JoinRequestId::parse(&request_id) else {
        return not_found();
    };
    let waiting = match st
        .db
        .join_request(&session.organization_id, request_id)
        .await
    {
        Ok(Some(found)) if found.session_id == session.id => found,
        Ok(_) => return not_found(),
        Err(error) => return unavailable(&error),
    };
    if waiting.decision != JoinDecision::Pending {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "join_request_decided"})),
        )
            .into_response();
    }

    let now = Utc::now();
    let seated = waiting.requester_principal_id;
    let (decision, minted) = match decision_from(&body, session.id, seated, principal, now) {
        Ok(shape) => shape,
        Err(resp) => return resp,
    };

    // The seat is written before the decision, and only for an admission. A
    // decision that then fails leaves a seat nobody was told about, which the
    // operator can see and end; the other order would leave an admitted
    // requester with no standing at all and no way to notice.
    if let JoinDecision::Admitted { admission } = decision {
        let seat = SessionMembership::new(session.id, seated, admission.mode(), principal, now);
        if let Err(error) = st
            .db
            .upsert_session_membership(&session.organization_id, &seat)
            .await
        {
            return unavailable(&error);
        }
    }

    match st
        .db
        .decide_join_request(
            &session.organization_id,
            request_id,
            decision,
            principal,
            now,
            minted.as_ref(),
        )
        .await
    {
        Ok(()) => {
            if let JoinDecision::Admitted { admission } = decision {
                announce(
                    &st,
                    session.id,
                    SessionEvent::ParticipantJoined {
                        principal_id: seated,
                        mode: admission.mode(),
                    },
                );
            }
            if let Some(grant) = minted.as_ref() {
                announce(
                    &st,
                    session.id,
                    SessionEvent::GrantAdded {
                        grant_id: grant.id,
                        subject_principal_id: grant.subject_principal_id,
                        role: grant.role,
                        expires_at: grant.expires_at,
                    },
                );
            }
            Json(json!({
                "id": request_id.to_string(),
                "decision": match decision {
                    JoinDecision::Admitted { .. } => "admitted",
                    JoinDecision::Refused | JoinDecision::Pending => "refused",
                },
                "mode": match decision {
                    JoinDecision::Admitted { admission } => Some(mode_str(admission.mode())),
                    JoinDecision::Refused | JoinDecision::Pending => None,
                },
                "grant": minted.as_ref().map(operator_entry),
            }))
            .into_response()
        }
        Err(error) => unavailable(&error),
    }
}

/// The decision a body states, and the grant it mints — or the refusal. A
/// body that disagrees with itself is refused rather than resolved: see the
/// module note.
#[allow(clippy::result_large_err)] // axum's Response is the refusal, as in every handler here
fn decision_from(
    body: &DecideRequest,
    session_id: SessionId,
    seated: PrincipalId,
    principal: PrincipalId,
    now: DateTime<Utc>,
) -> Result<(JoinDecision, Option<SessionGrant>), Response> {
    let shape = |detail: &str| Err(bad_request("decision_shape", detail));
    match (body.decision.as_str(), body.mode.as_deref()) {
        ("refused", None) if body.grant.is_some() => shape("a refusal mints no grant"),
        ("refused", None) => Ok((JoinDecision::Refused, None)),
        ("refused", Some(_)) => shape("a refusal seats nobody"),
        ("admitted", Some("observer")) if body.grant.is_some() => {
            shape("an observer is seated holding nothing; admit them as a participant to grant")
        }
        ("admitted", Some("observer")) => Ok((
            JoinDecision::Admitted {
                admission: Admission::Observer,
            },
            None,
        )),
        ("admitted", Some("participant")) => {
            let Some(spec) = body.grant.as_ref() else {
                return shape("admitting a participant needs the grant it mints");
            };
            if spec.subject_principal_id.is_some() {
                return shape(
                    "an admission grants the requester; naming another subject is refused",
                );
            }
            // The requester is the subject, structurally: `grant_from` takes
            // it as a parameter, so there is no body field that could disagree.
            let grant = grant_from(spec, session_id, seated, principal, now)?;
            Ok((
                JoinDecision::Admitted {
                    admission: Admission::Participant { grant_id: grant.id },
                },
                Some(grant),
            ))
        }
        ("admitted", _) => shape("admit as observer or participant"),
        _ => shape("admitted or refused"),
    }
}

/// How a seat is spelled on the wire.
pub(crate) fn mode_str(mode: SessionMode) -> &'static str {
    match mode {
        SessionMode::Observer => "observer",
        SessionMode::Participant => "participant",
    }
}

/// Read a seat from a request body.
pub(crate) fn mode_from(raw: &str) -> Option<SessionMode> {
    match raw {
        "observer" => Some(SessionMode::Observer),
        "participant" => Some(SessionMode::Participant),
        _ => None,
    }
}
