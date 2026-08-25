//! Delegation offer lifecycle over HTTP (ADR 0044).
//!
//! The broker enforces every fence (`crates/connection-broker/src/delegation.rs`);
//! this layer only decides who is asking. Subjects come from the transport —
//! session or operator — never from a request body. Present and claim are the
//! two surfaces a *link-holder* reaches: present is authenticated by the token
//! itself (holding it is the credential being spent), while claim additionally
//! requires a session, because a delegation must bind to somebody the gateway
//! can name again at exercise time.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::delegation::{ClaimOfferRequest, MintOfferRequest};
use opensesame_connection_broker::error::BrokerError;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};

/// The organization the caller acts in. Sessions carry one; an operator
/// without a session acts in the bootstrap organization, as elsewhere.
fn caller_org(
    st: &AppState,
    caller: &Caller,
) -> Result<opensesame_domain::OrganizationId, Response> {
    match caller {
        Caller::Session {
            organization_id, ..
        } => Ok(*organization_id),
        Caller::Operator => st
            .bootstrap
            .lock()
            .unwrap()
            .as_ref()
            .map(|b| b.org)
            .ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"bootstrap_unavailable"})),
                )
                    .into_response()
            }),
    }
}

fn caller_subject(caller: &Caller) -> String {
    match caller {
        Caller::Session { subject, .. } => subject.clone(),
        Caller::Operator => "user:demo".into(),
    }
}

fn broker_error(e: &BrokerError) -> Response {
    let status = match e {
        BrokerError::ConnectionNotFound => StatusCode::NOT_FOUND,
        BrokerError::StateExpired => StatusCode::GONE,
        BrokerError::InvalidState => StatusCode::CONFLICT,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    // Broker errors are typed and value-free; redact anyway before the wire,
    // because this surface outlives today's error set.
    let msg = opensesame_redaction::redact_text(&e.to_string());
    (status, Json(json!({"error": e.code(), "detail": msg}))).into_response()
}

/// `POST /api/v1/delegations` — owner mints an offer.
pub async fn mint(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<MintOfferRequest>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let organization = match caller_org(&st, &caller) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .mint_delegation_offer(
            &organization,
            &caller_subject(&caller),
            body,
            &st.claim_pepper,
        )
        .await
    {
        Ok(minted) => (StatusCode::CREATED, Json(json!(minted))).into_response(),
        Err(e) => broker_error(&e),
    }
}

#[derive(Deserialize)]
pub struct PresentRequest {
    claim_token: String,
}

/// `POST /api/v1/delegations/present` — spend the offer's one presentation.
///
/// No session: the token is the credential being spent, and demanding an
/// account before showing the manifest would push guests to accept unseen.
pub async fn present(State(st): State<AppState>, Json(body): Json<PresentRequest>) -> Response {
    match st
        .connection_broker
        .present_delegation_offer(&body.claim_token)
        .await
    {
        Ok(offer) => Json(json!({"offer": offer})).into_response(),
        Err(e) => broker_error(&e),
    }
}

/// `POST /api/v1/delegations/claim` — complete a presented offer.
pub async fn claim(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ClaimOfferRequest>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .claim_delegation_offer(body, &caller_subject(&caller), &st.claim_pepper)
        .await
    {
        Ok(delegations) => (
            StatusCode::CREATED,
            Json(json!({"delegations": delegations})),
        )
            .into_response(),
        Err(e) => broker_error(&e),
    }
}

/// `GET /api/v1/delegations` — where the caller is owner or claimant.
pub async fn list(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let organization = match caller_org(&st, &caller) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .list_delegations_for(&organization, &caller_subject(&caller))
        .await
    {
        Ok(delegations) => Json(json!({"delegations": delegations})).into_response(),
        Err(e) => broker_error(&e),
    }
}

/// `GET /api/v1/delegations/offers` — offers the caller minted.
pub async fn list_offers(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let organization = match caller_org(&st, &caller) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .list_delegation_offers(&organization, &caller_subject(&caller))
        .await
    {
        Ok(offers) => Json(json!({"offers": offers})).into_response(),
        Err(e) => broker_error(&e),
    }
}

/// `DELETE /api/v1/delegations/offers/{id}` — revoke the offer and, if it was
/// claimed, every delegation in its set.
pub async fn revoke_offer(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let organization = match caller_org(&st, &caller) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .revoke_delegation_offer(&organization, &caller_subject(&caller), &id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(&e),
    }
}

/// `DELETE /api/v1/delegations/{id}` — owner revokes; claimant drops their own.
pub async fn revoke(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let organization = match caller_org(&st, &caller) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .revoke_delegation(&organization, &caller_subject(&caller), &id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(&e),
    }
}

#[derive(Deserialize)]
pub struct NarrowRequest {
    #[serde(default)]
    actions: Option<Vec<String>>,
    #[serde(default)]
    resources: Option<Vec<String>>,
    #[serde(default)]
    expires_in_seconds: Option<i64>,
}

/// `POST /api/v1/delegations/{id}/narrow` — attenuation-only edit
/// (ADR 0046 decision 10). Widening is refused in the domain layer.
pub async fn narrow(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<NarrowRequest>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let organization = match caller_org(&st, &caller) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .narrow_delegation(
            &organization,
            &caller_subject(&caller),
            &id,
            body.actions,
            body.resources,
            body.expires_in_seconds,
        )
        .await
    {
        Ok(delegation) => Json(json!({"delegation": delegation})).into_response(),
        Err(e) => broker_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;

    #[tokio::test]
    async fn adversarial_every_authority_surface_requires_a_caller() {
        // Present is the deliberate exception: the token is the credential.
        let state = crate::app_state::test_demo_state().await;
        let anonymous = axum::http::HeaderMap::new();
        let responses = [
            mint(
                State(state.clone()),
                anonymous.clone(),
                Json(MintOfferRequest {
                    items: vec![],
                    ttl_seconds: None,
                }),
            )
            .await,
            claim(
                State(state.clone()),
                anonymous.clone(),
                Json(ClaimOfferRequest {
                    claim_token: "osc_dlg_x.y".into(),
                    user_code: "AAAA-BBBB".into(),
                    accepted_item_ids: vec![],
                }),
            )
            .await,
            list(State(state.clone()), anonymous.clone()).await,
            list_offers(State(state.clone()), anonymous.clone()).await,
        ];
        for response in responses {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[tokio::test]
    async fn contract_presenting_an_unknown_token_is_not_found() {
        // Reached by URL alone: the answer must not say whether anything exists.
        let state = crate::app_state::test_demo_state().await;
        let response = present(
            State(state.clone()),
            Json(PresentRequest {
                claim_token: "osc_dlg_nope.nothing".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
