//! Experimental AAuth draft-10 HTTP surface.
//!
//! Disabled unless `OPENSESAME_AAUTH_EXPERIMENTAL=true`. Never claims protocol
//! conformance — only exposes lossless mapping helpers for interoperability experiments.
//! Mapping helpers require session or operator auth when enabled.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use opensesame_domain::{Capability, CapabilitySet, ResourceSelector};
use opensesame_protocol_aauth::{
    assert_scopes_within_ceiling, map_agent, map_person, mission_to_governance_context, Agent,
    Mission, Person,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::require_session_or_operator;

fn aauth_enabled() -> bool {
    std::env::var("OPENSESAME_AAUTH_EXPERIMENTAL")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[derive(Deserialize)]
pub struct MapPersonBody {
    pub id: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct MapAgentBody {
    pub id: String,
    pub instance_id: String,
}

#[derive(Deserialize)]
pub struct MissionBody {
    /// Base64-encoded exact mission bytes (byte-stable digest).
    pub bytes_b64: String,
}

#[derive(Deserialize)]
pub struct ScopeCeilingBody {
    pub scopes: Vec<String>,
    pub current_actions: Vec<String>,
}

fn disabled() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "aauth_profile_disabled",
            "message": "Set OPENSESAME_AAUTH_EXPERIMENTAL=true to enable experimental AAuth draft-10 mapping endpoints. This is not a conformance claim.",
            "profile": "aauth-draft-10-experimental"
        })),
    )
        .into_response()
}

pub async fn status() -> impl IntoResponse {
    if !aauth_enabled() {
        return disabled();
    }
    Json(json!({
        "enabled": true,
        "profile": "aauth-draft-10-experimental",
        "maturity": "experimental",
        "conformance_claim": false,
        "endpoints": [
            "/experimental/aauth/v1/map/person",
            "/experimental/aauth/v1/map/agent",
            "/experimental/aauth/v1/mission/digest",
            "/experimental/aauth/v1/scope/check"
        ]
    }))
    .into_response()
}

pub async fn map_person_handler(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<MapPersonBody>,
) -> impl IntoResponse {
    if !aauth_enabled() {
        return disabled();
    }
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let mapped = map_person(&Person {
        id: body.id,
        display_name: body.display_name,
    });
    Json(json!({
        "principal_id": mapped.principal_id.to_string(),
        "source_person_id": mapped.source_person_id,
    }))
    .into_response()
}

pub async fn map_agent_handler(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<MapAgentBody>,
) -> impl IntoResponse {
    if !aauth_enabled() {
        return disabled();
    }
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let mapped = map_agent(&Agent {
        id: body.id,
        instance_id: body.instance_id,
    });
    Json(json!({
        "actor_id": mapped.actor_id.to_string(),
        "instance_id": mapped.instance_id.to_string(),
        "source_agent_id": mapped.source_agent_id,
        "source_instance_id": mapped.source_instance_id,
    }))
    .into_response()
}

pub async fn mission_digest(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<MissionBody>,
) -> impl IntoResponse {
    if !aauth_enabled() {
        return disabled();
    }
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let Ok(bytes) = STANDARD.decode(body.bytes_b64.as_bytes()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_bytes_b64"})),
        )
            .into_response();
    };
    let gov = mission_to_governance_context(&Mission {
        bytes: bytes.clone(),
    });
    let again = mission_to_governance_context(&Mission { bytes });
    if gov.mission_digest != again.mission_digest {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "mission_digest_unstable"})),
        )
            .into_response();
    }
    Json(json!({
        "mission_digest": gov.mission_digest,
        "mission_bytes_len": gov.mission_bytes_len,
    }))
    .into_response()
}

pub async fn scope_check(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ScopeCeilingBody>,
) -> impl IntoResponse {
    if !aauth_enabled() {
        return disabled();
    }
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let ceiling = CapabilitySet::new(
        body.current_actions
            .into_iter()
            .map(|a| Capability::new(a, ResourceSelector::exact("*")))
            .collect(),
    );
    match assert_scopes_within_ceiling(&body.scopes, &ceiling) {
        Ok(()) => Json(json!({
            "allowed": true,
            "new_task_required": false,
            "error": null,
        }))
        .into_response(),
        Err(_) => Json(json!({
            "allowed": false,
            "new_task_required": true,
            "error": "mcp_scope_outside_task",
        }))
        .into_response(),
    }
}
