use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use opensesame_provider_openbao::CredentialAuthority;
use serde_json::json;

use crate::app_state::AppState;

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
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"not_ready","reason":e.to_string()})),
        ),
    }
}

pub async fn authority(State(st): State<AppState>) -> impl IntoResponse {
    let ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    Json(json!({"quorum_ok": ok, "class_a2_a3": if ok {"available"} else {"fail_closed"}}))
}

pub async fn degraded(State(st): State<AppState>) -> impl IntoResponse {
    let ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    Json(json!({
        "authority": if ok {"ok"} else {"degraded"},
        "a0_local_e2ee": "available",
        "a2_authority_required": if ok {"available"} else {"denied"}
    }))
}

pub async fn providers(State(st): State<AppState>) -> impl IntoResponse {
    let mut openfga = json!({"configured": false});
    if let Some(c) = &st.openfga {
        openfga = match c.health().await {
            Ok(()) => json!({"configured": true, "status": "ok"}),
            Err(e) => json!({"configured": true, "status": "error", "error": e.to_string()}),
        };
    }
    let mut openbao = json!({"configured": false});
    if let Some(a) = &st.openbao {
        openbao = match a.health().await {
            Ok(h) => json!({"configured": true, "sealed": h.sealed, "quorum_ok": h.quorum_ok}),
            Err(e) => json!({"configured": true, "status": "error", "error": e.to_string()}),
        };
    }
    Json(json!({
        "openfga": openfga,
        "openbao": openbao,
        "agent_api": "connection_ref",
        "secret_ref_agent_facing": false
    }))
}
