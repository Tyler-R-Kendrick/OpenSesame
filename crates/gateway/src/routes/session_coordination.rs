//! Seats and endings over HTTP (ADR 0079 §2, §7).
//!
//! The two things a coordination session needs that a sharing session did not:
//! a way to put somebody in the room who needs no keys, and a way to say the
//! room is closed.
//!
//! Every handler follows the same order the rest of this feature does —
//! resolve the caller from the transport, read the session in the caller's own
//! organization, ask [`Reach`] — and every refusal is the same `404`, because
//! distinguishing "not allowed" from "no such session" would confirm that a
//! private session exists.
//!
//! **Seating and granting are separate acts, and stay separate.** Nothing here
//! writes a grant. Raising somebody to participant says they *may* be given
//! reach; what they are then given is a second decision with its own scope and
//! its own expiry, on `POST .../grants`. Collapsing the two would mean every
//! grant silently promoted its subject, and that the operator's "let them
//! watch" and their "let them read" were the same click.
//!
//! **A closed session is checked once.** [`crate::shared_session_fence::Reach::of`]
//! denies every non-operator on a closed session, so no handler here or
//! anywhere else needs its own check and none of them can forget it. The
//! operator keeps their standing, which lets them read what happened and hands
//! over nothing: running a session has never been a reach into the vault.
//!
//! **Lowering somebody is not revoking them.** `POST .../members` refuses to
//! turn a participant who still holds live grants into an observer, rather
//! than quietly revoking on their behalf. The operator revokes first, because
//! revocation is the act that has a consequence they should see: ADR 0079 §3's
//! re-keying, which lowering a mode does not perform.

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_domain::{SessionMembership, SessionMode};
use serde::Deserialize;
use serde_json::json;

use super::shared_sessions::join::{mode_from, mode_str};
use super::shared_sessions::{announce, bad_request, not_found, standing, unavailable};
use crate::app_state::AppState;
use crate::middleware::auth::parse_principal;
use crate::session_channel::SessionEvent;

/// What a member's seat looks like from outside.
///
/// Who, in what mode, since when. Not their grants: which rows a colleague can
/// reach is the operator's business and stays in the operator's view of the
/// roster, exactly as it does on `GET /api/v1/shared-sessions/{id}`.
fn seat_entry(seat: &SessionMembership) -> serde_json::Value {
    json!({
        "principal_id": seat.principal_id.to_string(),
        "mode": mode_str(seat.mode),
        "admitted_at": seat.admitted_at.to_rfc3339(),
    })
}

/// `GET /api/v1/shared-sessions/{id}/members` — who is in the room.
///
/// Participants and observers alike, because knowing who else is present is
/// the point of being present. An observer sees this list and learns nothing
/// about the vault from it: a mode is not a scope.
pub async fn list_members(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_see_session() {
        return not_found();
    }
    match st.db.active_session_memberships(session.id).await {
        Ok(seats) => Json(json!({
            "operator_principal_id": session.operator_principal_id.to_string(),
            "closed_at": session.closed_at.map(|at| at.to_rfc3339()),
            "members": seats.iter().map(seat_entry).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(error) => unavailable(&error),
    }
}

#[derive(Deserialize)]
pub struct SeatRequest {
    /// Who to seat.
    principal_id: String,
    /// `observer`, `participant`, or `none` to end the seat.
    ///
    /// No default. An operator putting somebody in a room says whether that
    /// person may be given keys, and a missing field must never decide it.
    mode: String,
}

/// `POST /api/v1/shared-sessions/{id}/members` — seat, raise, lower, remove.
///
/// One route for all four because they are one statement — "this principal's
/// standing in this session is now *this*" — and splitting them would make the
/// caller work out which case it is in. A caller that guessed wrong is exactly
/// how somebody ends up holding two seats in two modes, which the store's
/// primary key on the pair refuses anyway.
///
/// The operator cannot be seated. Running a session is a role and being in it
/// is a seat; conflating them is how "manages the sharing" quietly becomes "is
/// in the room with reach" (ADR 0079 §6), and there is no seat an operator
/// needs in order to manage.
pub async fn seat_member(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<SeatRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_admit() {
        return not_found();
    }
    if session.closed_at.is_some() {
        return bad_request("session_closed", "a closed session seats nobody");
    }
    let Some(subject) = parse_principal(&body.principal_id) else {
        return bad_request("member_principal", "not a principal id");
    };
    if subject == session.operator_principal_id {
        return bad_request(
            "member_principal",
            "the operator runs the session rather than sitting in it",
        );
    }

    let now = Utc::now();
    let held = match st.db.session_membership(session.id, subject).await {
        Ok(found) => found,
        Err(error) => return unavailable(&error),
    };

    let seat = match (body.mode.as_str(), held) {
        ("none", None) => {
            // Removing somebody who was never here. Idempotent rather than a
            // 404: the operator's intent is satisfied.
            return Json(json!({"principal_id": subject.to_string(), "mode": "none"}))
                .into_response();
        }
        ("none", Some(seat)) => seat.ended(now),
        (wanted, held) => {
            let Some(wanted) = mode_from(wanted) else {
                return bad_request("member_mode", "observer, participant or none");
            };
            let existing = held
                .filter(SessionMembership::is_active)
                .unwrap_or_else(|| {
                    SessionMembership::new(session.id, subject, wanted, principal, now)
                });
            match wanted {
                SessionMode::Participant => match existing.raised_to_participant() {
                    Ok(seat) => seat,
                    Err(error) => return bad_request("member_mode", &error.to_string()),
                },
                SessionMode::Observer => {
                    // Refused while they still hold reach: an observer holding
                    // a wrapped key is the contradiction the mode exists to
                    // rule out, and lowering into it would make the invariant
                    // a lie every later check has to re-test.
                    let live = match st.db.live_grant_count(session.id, subject, now).await {
                        Ok(count) => count,
                        Err(error) => return unavailable(&error),
                    };
                    match existing.lowered_to_observer(live) {
                        Ok(seat) => seat,
                        Err(error) => return bad_request("member_mode", &error.to_string()),
                    }
                }
            }
        }
    };

    if let Err(error) = st
        .db
        .upsert_session_membership(&session.organization_id, &seat)
        .await
    {
        return unavailable(&error);
    }

    if seat.is_active() {
        announce(
            &st,
            session.id,
            SessionEvent::ParticipantJoined {
                principal_id: subject,
                mode: seat.mode,
            },
        );
    } else {
        announce(
            &st,
            session.id,
            SessionEvent::ParticipantLeft {
                principal_id: subject,
            },
        );
    }

    Json(json!({
        "principal_id": subject.to_string(),
        "mode": if seat.is_active() { mode_str(seat.mode) } else { "none" },
    }))
    .into_response()
}

/// `POST /api/v1/shared-sessions/{id}/close` — end it.
///
/// Idempotent: closing a closed session is `200`, because the operator's
/// intent — "this is over" — is satisfied either way, and a `409` would only
/// invite a retry loop.
///
/// Three things happen in one transaction, and the response says which
/// (`opensesame_storage::Db::close_session`): the session shuts, every seat is
/// given up, and **every grant the session minted** is revoked. Reach the
/// session merely *referenced* is left exactly as it was, because it belongs
/// to another road — a project membership, a longer-lived grant — and ending a
/// meeting must not withdraw somebody's project access.
///
/// The note repeats what revoking one grant already says: withdrawing stops
/// new authorizations and does not un-read what was opened. Closing a session
/// is the moment an operator is most likely to believe otherwise, so it is the
/// moment worth saying it.
pub async fn close(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_admit() {
        return not_found();
    }
    let now = Utc::now();
    match st
        .db
        .close_session(&session.organization_id, session.id, now)
        .await
    {
        Ok(closed) => {
            if closed {
                announce(
                    &st,
                    session.id,
                    SessionEvent::SessionClosed { closed_at: now },
                );
            }
            Json(json!({
                "closed": true,
                "closed_at": now.to_rfc3339(),
                "already_closed": !closed,
                "note": "Every grant this session minted is revoked. Reach it only referenced is untouched. Re-key the vault or the row to make future versions unreadable to a former participant who kept ciphertext.",
            }))
            .into_response()
        }
        Err(error) => unavailable(&error),
    }
}

#[cfg(test)]
#[path = "session_coordination/tests.rs"]
mod tests;
