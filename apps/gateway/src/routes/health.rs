use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use opensesame_provider_openbao::CredentialAuthority;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::require_operator;

pub async fn live() -> impl IntoResponse {
    "ok"
}

pub async fn ready(State(st): State<AppState>) -> impl IntoResponse {
    if st.production_bootstrap_misconfigured() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status":"not_ready",
                "reason":"demo_bootstrap_forbidden_in_production"
            })),
        );
    }
    match st.db.authority_quorum_ok().await {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({
                "status": "ready",
                "distributed_task_authority": st.distributed_task_authority,
            })),
        ),
        Ok(false) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"not_ready","reason":"authority_quorum"})),
        ),
        Err(e) => {
            // `/health/ready` is public: a backend error string can carry the DSN
            // (host, user, password) or an upstream URL. Log it, answer a code.
            tracing::warn!(error = %e, "authority quorum probe failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status":"not_ready","reason":"authority_unavailable"})),
            )
        }
    }
}

pub async fn authority(State(st): State<AppState>) -> impl IntoResponse {
    let ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    Json(json!({"ok": ok}))
}

pub async fn degraded(State(st): State<AppState>) -> impl IntoResponse {
    let ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    Json(json!({"ok": ok}))
}

pub async fn providers(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // Provider wiring + backend errors are operator diagnostics, not public health.
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let mut openfga = json!({"configured": false});
    if let Some(c) = &st.openfga {
        openfga = match c.health().await {
            Ok(()) => json!({"configured": true, "status": "ok"}),
            Err(e) => json!({
                "configured": true,
                "status": "error",
                "error": opensesame_redaction::redact_text(&e.to_string()),
            }),
        };
    }
    let mut openbao = json!({"configured": false});
    if let Some(a) = &st.openbao {
        openbao = match a.health().await {
            Ok(h) => json!({"configured": true, "sealed": h.sealed, "quorum_ok": h.quorum_ok}),
            Err(e) => json!({
                "configured": true,
                "status": "error",
                "error": opensesame_redaction::redact_text(&e.to_string()),
            }),
        };
    }
    Json(json!({
        "openfga": openfga,
        "openbao": openbao,
        "agent_api": "connection_ref",
        "secret_ref_agent_facing": false
    }))
    .into_response()
}
