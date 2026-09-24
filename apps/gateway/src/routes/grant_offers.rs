//! Grant-offer activation and revoke (ADR 0120). Same realm auth as access domains.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use opensesame_domain::OrganizationId;
use opensesame_storage::authority::{ActivationOutcome, OfferActivation};
use serde::Deserialize;
use serde_json::json;

use super::secret_configs::access::hidden;
use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/organizations/{organization}/grant-offers/{id}/activate",
            post(activate),
        )
        .route(
            "/api/v1/organizations/{organization}/grant-offers/{id}/revoke",
            post(revoke),
        )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivateBody {
    beneficiary_principal_id: String,
    grant_id: String,
    cohort_revision: i64,
    membership_source: String,
    #[allow(dead_code)]
    membership_issuer: String,
    idempotency_key: String,
}

#[allow(clippy::result_large_err)]
fn authorize_realm(
    st: &AppState,
    headers: &HeaderMap,
    path_organization: &str,
) -> Result<(Caller, OrganizationId), Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to manage grant offers"
            })),
        )
            .into_response());
    }
    let organization = resolve_caller_organization(st, &who, headers)?;
    if organization.to_string() != path_organization {
        return Err(hidden());
    }
    Ok((who, organization))
}

fn unavailable() -> Response {
    StatusCode::SERVICE_UNAVAILABLE.into_response()
}

async fn activate(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, offer_id)): Path<(String, String)>,
    Json(body): Json<ActivateBody>,
) -> Response {
    let (who, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let org = organization.to_string();
    let writer = who.actor_subject();
    let Ok(outcome) = st
        .db
        .activate_grant_offer(&OfferActivation {
            offer_id: &offer_id,
            organization_id: &org,
            beneficiary_principal_id: &body.beneficiary_principal_id,
            grant_id: &body.grant_id,
            cohort_revision: body.cohort_revision,
            membership_source: &body.membership_source,
            membership_issuer: writer,
            idempotency_key: &body.idempotency_key,
        })
        .await
    else {
        return unavailable();
    };
    match outcome {
        ActivationOutcome::Bound => Json(json!({"status": "bound"})).into_response(),
        ActivationOutcome::Duplicate => (
            StatusCode::CONFLICT,
            Json(json!({"error": "duplicate", "status": "duplicate"})),
        )
            .into_response(),
        ActivationOutcome::Refused => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "refused"})),
        )
            .into_response(),
    }
}

async fn revoke(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, offer_id)): Path<(String, String)>,
) -> Response {
    let (_, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    match st
        .db
        .revoke_grant_offer(&organization.to_string(), &offer_id)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => hidden(),
        Err(_) => unavailable(),
    }
}

#[cfg(test)]
#[path = "grant_offers_tests.rs"]
mod tests;
