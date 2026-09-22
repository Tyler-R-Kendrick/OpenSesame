//! Operator routes over the certificate lifecycle (ADR 0132).
//!
//! Every handler is configurator-gated exactly like `taskbus_config`
//! (`resolve_caller` → `can_configure_integrations`); none of them reads
//! transport evidence, so an admitted mTLS peer never reaches one — mTLS is
//! not an alternate operator login.
//!
//! **No response here can carry private key material.** The issuance view is
//! public PEM (leaf + issuer) and metadata; the revocation view is a
//! thumbprint and the bound enforced per layer; the trust view is anchors,
//! which are public by construction. The human-only reveal
//! (`managed_certs::reveal_managed_key`) lives on its own route and is
//! untouched. `boundary_tests.rs` asserts the source of this file names no
//! reveal path, and the status structs' `Debug` is walked for key material.
//!
//! Bodies are bounded: axum's `Json` plus the per-document ceilings in
//! [`super::trust`] and `transport::bindings`. Every DTO is
//! `deny_unknown_fields`.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};
use crate::transport_lifecycle::{crl, facts, issuance, revocation, trust};

/// The routes this module contributes, merged by the coordinator in
/// `routes::router`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/operator/transport/certificates",
            post(issue_certificate),
        )
        .route(
            "/api/v1/operator/transport/certificates/revoke",
            post(revoke_certificate),
        )
        .route(
            "/api/v1/operator/transport/trust",
            get(get_trust).put(put_trust),
        )
        .route("/api/v1/operator/transport/facts/{target}", get(get_facts))
        .route("/api/v1/operator/transport/renewals", get(get_renewals))
}

fn require_configurator(state: &AppState, headers: &HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(state, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to administer transport certificates",
            })),
        )
            .into_response());
    }
    Ok(who)
}

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn refuse(code: u16, error: &str, hint: &str) -> Response {
    (status(code), Json(json!({ "error": error, "hint": hint }))).into_response()
}

/// `POST /api/v1/operator/transport/certificates`
///
/// Issues a host-managed transport identity under the caller's organization.
/// The response is public material only.
pub async fn issue_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<issuance::TransportIssuanceRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let who = match require_configurator(&state, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let Ok(Json(request)) = body else {
        return refuse(
            400,
            "invalid_request",
            "body is not a transport issuance request",
        );
    };
    let organization = who.organization(state.connection_organization);
    let actor = who.actor_subject().to_owned();
    match issuance::issue_for_transport(&state, &organization, request, &actor).await {
        Ok(issued) => (StatusCode::CREATED, Json(json!({ "certificate": issued }))).into_response(),
        Err(error) => {
            let detail = match &error {
                issuance::IssuanceError::Policy(violations) => json!(violations
                    .iter()
                    .map(|violation| json!({
                        "field": violation.field,
                        "reason": violation.reason,
                    }))
                    .collect::<Vec<_>>()),
                other => json!(other.to_string()),
            };
            (
                status(error.http_status()),
                Json(json!({ "error": error.code(), "hint": detail })),
            )
                .into_response()
        }
    }
}

/// `POST /api/v1/operator/transport/certificates/revoke`
///
/// The response states the bound actually enforced for new handshakes,
/// existing connections, stored bindings, tokens and offline state — never a
/// single "revoked" that reads as fleet-wide.
pub async fn revoke_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<revocation::RevokeRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let who = match require_configurator(&state, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let Ok(Json(request)) = body else {
        return refuse(400, "invalid_request", "body is not a revocation request");
    };
    let organization = who.organization(state.connection_organization);
    match revocation::revoke_transport(&state, &organization, request).await {
        Ok(outcome) => (StatusCode::OK, Json(json!({ "revocation": outcome }))).into_response(),
        Err(error) => refuse(error.http_status(), error.code(), &error.to_string()),
    }
}

/// `GET /api/v1/operator/transport/trust`
pub async fn get_trust(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_configurator(&state, &headers) {
        return response;
    }
    let now = chrono::Utc::now();
    match trust::load(&state).await {
        Ok(stored) => {
            let base: Vec<String> = state
                .transport_lifecycle
                .base_trust()
                .keys()
                .map(|profile| profile.name.clone())
                .collect();
            (
                StatusCode::OK,
                Json(json!({
                    "trust": stored,
                    "deployment_plane_profiles": base,
                    // A configured CRL past its nextUpdate reads `degraded`
                    // here; it is never silently treated as fresh.
                    "revocation": crl::status(&state, now),
                })),
            )
                .into_response()
        }
        Err(error) => refuse(400, error.code(), &error.to_string()),
    }
}

/// The `PUT` body: the set plus the explicit force flag.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PutTrustBody {
    #[serde(flatten)]
    pub set: trust::TrustProfileSet,
    /// Remove a profile an enabled binding still names. Audited.
    #[serde(default)]
    pub force: bool,
}

/// `PUT /api/v1/operator/transport/trust`
///
/// Compare-and-set on `revision`. Refused whole when an anchor does not
/// build, when a profile an enabled binding names would disappear without
/// `force`, or when the resulting generation will not activate — in which
/// case the previous anchors keep serving and nothing else is substituted.
pub async fn put_trust(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<PutTrustBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let who = match require_configurator(&state, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let Ok(Json(body)) = body else {
        return refuse(400, "invalid_request", "body is not a trust profile set");
    };
    let actor = who.actor_subject().to_owned();
    match trust::put_cas(&state, body.set, &actor, body.force).await {
        Ok(set) => (StatusCode::OK, Json(json!({ "trust": set }))).into_response(),
        Err(error) => refuse(error.http_status(), error.code(), &error.to_string()),
    }
}

/// `GET /api/v1/operator/transport/facts/{target}`
///
/// Issued, delivered, loaded, active, superseded, expired, revoked and
/// enforcement-observed, each on its own, so a renewal that succeeded is
/// never read as an installation that happened.
pub async fn get_facts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(target): Path<String>,
) -> Response {
    if let Err(response) = require_configurator(&state, &headers) {
        return response;
    }
    if target.len() > 128 || !target.chars().all(|c| c.is_ascii_graphic()) {
        return refuse(400, "invalid_request", "target is not a bounded ascii name");
    }
    match facts::load(&state, &target).await {
        Ok(loaded) => (
            StatusCode::OK,
            Json(json!({
                "target": target,
                "summary": loaded.summary(),
                "runtime": loaded.runtime_status(),
                "history": loaded.history,
            })),
        )
            .into_response(),
        Err(error) => refuse(500, "storage_error", &error.to_string()),
    }
}

/// `GET /api/v1/operator/transport/renewals`
///
/// The retry queue: what is backing off, what parked, and how many failures
/// the queue refused to take. A parked certificate is the visible failure
/// ADR 0052 §11 asks for; it also rang the bell as a `SecurityNotice`.
pub async fn get_renewals(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_configurator(&state, &headers) {
        return response;
    }
    let (queued, parked, overflowed) = state.transport_lifecycle.with_scheduler(|scheduler| {
        (
            scheduler.queue_len(),
            scheduler
                .parked()
                .into_iter()
                .map(|retry| {
                    json!({
                        "certificate_id": retry.certificate_id,
                        "attempts": retry.attempts,
                        "last_code": retry.last_code,
                    })
                })
                .collect::<Vec<_>>(),
            scheduler.overflowed,
        )
    });
    (
        StatusCode::OK,
        Json(json!({
            "queued": queued,
            "parked": parked,
            "refused_for_queue_bound": overflowed,
            "max_queue": crate::transport_lifecycle::renewal::MAX_QUEUE,
            "max_attempts": crate::transport_lifecycle::renewal::MAX_ATTEMPTS,
        })),
    )
        .into_response()
}
