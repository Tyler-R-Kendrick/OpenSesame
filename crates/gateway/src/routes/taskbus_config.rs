//! Operator `TaskBus` / NATS configuration routes.
//!
//! Pages configures Host; Host reaches NATS (Tailscale or loopback). Browser
//! never opens `nats://`. The browser never holds a deployment operator
//! token — a Host session (local mint or Identity-approved owner/admin)
//! is the Pages credential, matching `taskBusOpenApi` sessionBearer.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_task_bus::{NatsTransportPublic, TaskBusBackend};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};
use crate::taskbus_config::{self, TaskBusConfigView, TaskBusSource};

fn require_configurator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to configure TaskBus"
            })),
        )
            .into_response());
    }
    Ok(who)
}

fn view(
    resolved: &taskbus_config::ResolvedTaskBus,
    status: &str,
    last_error: Option<String>,
) -> TaskBusConfigView {
    TaskBusConfigView {
        backend: taskbus_config::backend_label(resolved.backend).into(),
        nats_url: resolved
            .nats_url
            .as_deref()
            .map(taskbus_config::redact_nats_url),
        source: resolved.source.clone(),
        status: status.into(),
        last_error,
        // References and booleans only: the view type cannot carry a path,
        // a seed or a token, so an operator GET never discloses material.
        transport: resolved.transport.view(),
    }
}

pub async fn get_config(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    match taskbus_config::resolve(&st.db).await {
        Ok(resolved) => {
            let status = if matches!(resolved.source, TaskBusSource::Env) {
                "env_override"
            } else {
                "ok"
            };
            (
                StatusCode::OK,
                Json(json!({ "taskbus": view(&resolved, status, None) })),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutBody {
    pub backend: String,
    #[serde(default)]
    pub nats_url: Option<String>,
    /// Run the one-time provisioning action (create the stream and both
    /// durable consumers) with the provisioner credential before applying.
    /// Default false: a runtime apply never provisions on a secure profile.
    #[serde(default)]
    pub provision: bool,
    /// Optional public transport policy to store. `deny_unknown_fields` on
    /// `NatsTransportPublic` means a caller cannot smuggle a path, a seed or
    /// a token through here — only references the deployment plane resolves.
    #[serde(default)]
    pub transport: Option<NatsTransportPublic>,
}

pub async fn put_config(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PutBody>,
) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    if matches!(
        taskbus_config::resolve(&st.db).await.map(|r| r.source),
        Ok(TaskBusSource::Env)
    ) {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "env_override",
                "hint": "OPENSESAME_TASKBUS / NATS_URL is set on the Host process — unset env to use stored config, or change Compose env"
            })),
        )
            .into_response();
    }

    let backend = match body.backend.trim().to_ascii_lowercase().as_str() {
        "memory" | "inmemory" | "in-memory" => TaskBusBackend::Memory,
        "nats" | "jetstream" => TaskBusBackend::Nats,
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_request","hint": format!("backend must be memory|nats, got {other}")})),
            )
                .into_response();
        }
    };

    if let Some(public) = body.transport.as_ref() {
        if let Err(error) = taskbus_config::persist_transport(&st.db, public).await {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_request","hint": error.to_string()})),
            )
                .into_response();
        }
    }

    if let Err(error) = taskbus_config::persist(&st.db, backend, body.nats_url.as_deref()).await {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint": error.to_string()})),
        )
            .into_response();
    }

    let resolved = match taskbus_config::resolve(&st.db).await {
        Ok(r) => r,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": error.to_string()})),
            )
                .into_response();
        }
    };

    if body.provision {
        if let Err(error) = taskbus_config::provision(&resolved).await {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({
                    "taskbus": view(&resolved, "provisioning_failed", Some(error.to_string())),
                    "applied": false,
                    "hint": "The provisioning identity could not create the stream or the durable consumers",
                })),
            )
                .into_response();
        }
    }

    match taskbus_config::build_bus(&resolved).await {
        Ok(bus) => {
            *st.task_bus.write().await = bus;
            (
                StatusCode::OK,
                Json(json!({
                    "taskbus": view(&resolved, "applied", None),
                    "applied": true,
                })),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::OK,
            Json(json!({
                "taskbus": view(&resolved, "stored_reconnect_failed", Some(error.to_string())),
                "applied": false,
                "hint": "Config saved; Host could not connect yet — fix reachability (Tailscale) and Ping",
            })),
        )
            .into_response(),
    }
}

pub async fn ping(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    let resolved = match taskbus_config::resolve(&st.db).await {
        Ok(r) => r,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": error.to_string()})),
            )
                .into_response();
        }
    };
    match taskbus_config::build_bus(&resolved).await {
        Ok(_bus) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "taskbus": view(&resolved, "reachable", None),
            })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "ok": false,
                "taskbus": view(&resolved, "unreachable", Some(error.to_string())),
                "hint": "Host could not reach NATS — check Tailscale / NATS_URL from the Host process network",
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
#[path = "taskbus_config_tests.rs"]
mod tests;
