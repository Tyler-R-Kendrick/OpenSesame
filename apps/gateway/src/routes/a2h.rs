//! The callback an A2H gateway posts a human's reply to (ADR 0078, A2H v1.0).
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
    authority_for, verify_callback, A2hResponse, ExpectedReply, ResponseAuthority, VerifyError,
};
use serde_json::json;

use crate::app_state::AppState;

/// Header carrying `t=<unix>,v1=<base64>`.
const SIGNATURE_HEADER: &str = "x-a2h-signature";
/// Header carrying the gateway's per-attempt delivery id.
///
/// Logged for correlation with the gateway's own records during an incident,
/// and deliberately *not* the idempotency key: it changes per attempt, while
/// the thing that must be applied once is the interaction. `already_applied`
/// keys on the delivery row's state instead, which is stable across retries.
const DELIVERY_HEADER: &str = "x-a2h-delivery-id";

/// `POST /api/v1/a2h/callback`
///
/// Unauthenticated by design — the signature *is* the authentication, which is
/// what lets a third-party gateway reach it without holding a session. Every
/// refusal answers the same way for the same reason a claim link does: the
/// shape of the response must not tell an unsigned caller whether a given
/// interaction exists.
pub async fn callback(State(st): State<AppState>, headers: HeaderMap, body: String) -> Response {
    let Some(signature) = header(&headers, SIGNATURE_HEADER) else {
        return refused();
    };
    let attempt = header(&headers, DELIVERY_HEADER).unwrap_or_default();
    let Ok(response) = serde_json::from_str::<A2hResponse>(&body) else {
        return refused();
    };
    // The message id we minted is the delivery-ledger row id, so the reply
    // names the row it answers and we do not need a second lookup table.
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
        // A delivered row has already had its reply applied; the transport is
        // at-least-once, so a redelivery is expected rather than suspicious.
        already_applied: delivery.state == "delivered",
        now_unix: Utc::now().timestamp(),
    };
    if let Err(error) = verify_callback(&secret, &signature, &body, &response, &expected) {
        return match error {
            // Idempotency is a success from the gateway's point of view: it did
            // its job, and repeating the retry forever helps nobody.
            VerifyError::Duplicate => accepted("already applied"),
            _ => refused(),
        };
    }

    let Some(decision) = response.decision else {
        return accepted("acknowledged");
    };
    let Ok(authority) = authority_for(delivery_intent(&delivery), decision) else {
        return accepted("no decision to apply");
    };

    match authority {
        ResponseAuthority::Acknowledge => {
            tracing::info!(
                delivery_id = %delivery.id,
                attempt,
                origin = %delivery.subject_id,
                "a2h reply acknowledged; the run keeps waiting for a real attach",
            );
        }
        ResponseAuthority::Cancel => {
            tracing::info!(
                delivery_id = %delivery.id,
                attempt,
                origin = %delivery.subject_id,
                "a2h reply cancelled the run",
            );
        }
    }
    if let Err(error) = st
        .db
        .mark_security_delivered(&delivery.id, Utc::now())
        .await
    {
        tracing::warn!(%error, delivery_id = %delivery.id, "a2h reply applied but not recorded");
    }
    accepted("applied")
}

/// Which intent this delivery carried, so the reply is judged against what was
/// actually asked.
fn delivery_intent(
    delivery: &opensesame_storage::StoredSecurityDelivery,
) -> opensesame_a2h::IntentType {
    serde_json::from_str::<serde_json::Value>(&delivery.payload_json)
        .ok()
        .and_then(|payload| opensesame_agent_events::AgentEvent::from_payload(&payload))
        .and_then(|event| opensesame_a2h::intent_for(event.phase))
        .unwrap_or(opensesame_a2h::IntentType::Inform)
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
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
