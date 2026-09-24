//! The callback an A2H gateway posts a human's reply to (ADR 0081, A2H v1.0).
//!
//! Nothing here trusts the caller. The gateway sits between a run and the person
//! who owns it, so a forged reply is a way to cancel somebody's rotation, and
//! `crates/a2h`'s [`verify_callback`] is what stands in the way: HMAC in
//! constant time, then a timestamp tolerance, then the message id we actually
//! sent, then idempotency.
//!
//! What a verified reply can do is deliberately small. [`ResponseAuthority`]
//! has two variants and neither of them starts anything — see
//! `crates/a2h`'s `intent` module for why that is a property of the system
//! rather than a policy: taking the page needs the viewer key, and resuming
//! autonomy needs a re-assertion against a DOM. A phone has neither.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_a2h::{
    authority_for, verify_callback, A2hResponse, ExpectedReply, ResponseAuthority,
};
use opensesame_storage::a2h_replies::{ReplyDecision, ReplyOutcome};
use serde_json::json;

use crate::app_state::AppState;

/// Header carrying `t=<unix>,v1=<base64>`.
const SIGNATURE_HEADER: &str = "x-a2h-signature";

/// `POST /api/v1/a2h/callback`
///
/// Unauthenticated by design — the signature *is* the authentication, which is
/// what lets a third-party gateway reach it without holding a session. Every
/// refusal answers the same way for the same reason a claim link does: the
/// shape of the response must not tell an unsigned caller whether a given
/// interaction exists.
pub async fn callback(State(st): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if body.len() > 65536 {
        return refused();
    }
    let Some(signature) = header(&headers, SIGNATURE_HEADER) else {
        return refused();
    };
    let Ok(response) = serde_json::from_str::<A2hResponse>(&body) else {
        return refused();
    };
    let Ok(Some(delivery)) = st.db.get_security_delivery(&response.responds_to).await else {
        return refused();
    };
    let Ok(Some(hook)) = st
        .db
        .get_security_hook(&delivery.organization_id, &delivery.hook_id)
        .await
    else {
        return refused();
    };
    let Ok(secret) = crate::security::delivery::open_hook_secret(&st, &hook) else {
        return refused();
    };
    let expected = ExpectedReply {
        message_id: &delivery.id,
        already_applied: false, // Outbound delivery status says nothing about a reply.
        now_unix: Utc::now().timestamp(),
    };
    if verify_callback(&secret, &signature, &body, &response, &expected).is_err() {
        return refused();
    }
    let event =
        serde_json::from_str::<opensesame_security_events::SecurityNotice>(&delivery.payload_json)
            .ok()
            .and_then(|notice| opensesame_agent_events::AgentEvent::from_payload(&notice.payload));
    let authority = response
        .decision
        .and_then(|decision| authority_for(delivery_intent(&delivery), decision).ok())
        .unwrap_or(ResponseAuthority::Acknowledge);
    let decision = match authority {
        ResponseAuthority::Acknowledge => ReplyDecision::Acknowledge,
        ResponseAuthority::Cancel => {
            let Some(event) = &event else {
                return refused();
            };
            if event.run.organization_id != delivery.organization_id {
                return refused();
            }
            ReplyDecision::Cancel {
                run_id: &event.run.run_id,
                owner: &event.run.owner_principal_id,
                valid_until: event.responds_by.map_or(0, |deadline| deadline.timestamp()),
            }
        }
    };
    let digest = opensesame_claims::hash_secret(&body);
    match st
        .db
        .apply_a2h_reply(
            &delivery.id,
            &delivery.organization_id,
            &digest,
            decision,
            &Utc::now().to_rfc3339(),
        )
        .await
    {
        Ok(ReplyOutcome::Applied) => accepted("applied"),
        Ok(ReplyOutcome::Duplicate) => accepted("already_applied"),
        Ok(ReplyOutcome::DeadLetter) => accepted("dead_letter"),
        Ok(ReplyOutcome::Conflict) => {
            tracing::warn!(delivery_id = %delivery.id, "a2h reply digest conflict");
            refused()
        }
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"reply_retry_required"})),
        )
            .into_response(),
    }
}

/// Which intent this delivery carried, so the reply is judged against what was
/// actually asked.
///
/// The ledger stores the shared envelope (ADR 0080 §1), so the agent family's
/// own payload is one field in.
///
/// `Inform` is the fallback rather than an error because it is the *narrow*
/// reading: `authority_for(Inform, _)` settles nothing, so a payload this
/// cannot parse can never be read as consent to cancel somebody's run. A reply
/// that does nothing is recoverable; a cancel nobody asked for is not.
fn delivery_intent(
    delivery: &opensesame_storage::StoredSecurityDelivery,
) -> opensesame_a2h::IntentType {
    serde_json::from_str::<opensesame_security_events::SecurityNotice>(&delivery.payload_json)
        .ok()
        .and_then(|notice| opensesame_agent_events::AgentEvent::from_payload(&notice.payload))
        .map_or(opensesame_a2h::IntentType::Inform, |event| {
            opensesame_a2h::intent_for(event.phase)
        })
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    if headers.get_all(name).iter().count() != 1 {
        return None;
    }
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 256)
        .map(str::to_string)
}

/// One refusal for every failed check.
///
/// A signed caller learns nothing from it and an unsigned one learns nothing
/// either — including whether the interaction it named exists.
fn refused() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "invalid_request"})),
    )
        .into_response()
}

fn accepted(outcome: &str) -> Response {
    (StatusCode::OK, Json(json!({"status": outcome}))).into_response()
}
