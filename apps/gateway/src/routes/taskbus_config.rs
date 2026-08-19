//! Operator TaskBus / NATS configuration routes.
//!
//! Pages configures Host; Host reaches NATS (Tailscale or loopback). Browser
//! never opens `nats://`.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_task_bus::TaskBusBackend;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;
use crate::taskbus_config::{self, TaskBusConfigView, TaskBusSource};

fn require_configurator(st: &AppState, headers: &axum::http::HeaderMap) -> Result<(), Response> {
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
    Ok(())
}

fn view(
    resolved: &taskbus_config::ResolvedTaskBus,
    status: &str,
    last_error: Option<String>,
) -> TaskBusConfigView {
    TaskBusConfigView {
        backend: taskbus_config::backend_label(resolved.backend).into(),
        nats_url: resolved.nats_url.as_deref().map(taskbus_config::redact_nats_url),
        source: resolved.source.clone(),
        status: status.into(),
        last_error,
    }
}

pub async fn get_config(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
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
            (StatusCode::OK, Json(json!({ "taskbus": view(&resolved, status, None) }))).into_response()
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

pub async fn ping(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
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
mod tests {
    use crate::app_state::{self, test_env, test_session_headers, AppState};
    use crate::config::{Args, DEV_OPERATOR_TOKEN};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        test_env::lock()
    }

    async fn memory_state() -> AppState {
        std::env::remove_var("NATS_URL");
        std::env::remove_var("OPENSESAME_TASKBUS");
        app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap()
    }

    async fn call(
        state: &AppState,
        method: &str,
        path: &str,
        headers: Option<axum::http::HeaderMap>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        match headers {
            Some(map) => {
                for (name, value) in map.iter() {
                    request = request.header(name, value);
                }
            }
            None => {
                request = request.header(
                    "authorization",
                    format!("Bearer operator:{DEV_OPERATOR_TOKEN}"),
                );
            }
        }
        let request = match body {
            Some(value) => request
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = crate::routes::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn member_cannot_read_or_write_taskbus() {
        let _guard = env_lock();
        let state = memory_state().await;
        let headers = test_session_headers(
            &state,
            "prn_member",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Member,
        );
        let (status, _) =
            call(&state, "GET", "/api/v1/operator/taskbus", Some(headers.clone()), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            Some(headers),
            Some(json!({"backend": "memory"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn unauthenticated_is_rejected() {
        let _guard = env_lock();
        let state = memory_state().await;
        let request = Request::builder()
            .method("GET")
            .uri("/api/v1/operator/taskbus")
            .body(Body::empty())
            .unwrap();
        let response = crate::routes::router(state).oneshot(request).await.unwrap();
        assert!(
            response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::FORBIDDEN,
            "got {}",
            response.status()
        );
    }

    #[tokio::test]
    async fn operator_round_trips_memory_and_rejects_http_nats_url() {
        let _guard = env_lock();
        let state = memory_state().await;
        let (status, body) = call(&state, "GET", "/api/v1/operator/taskbus", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["taskbus"]["backend"], "memory");

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({"backend": "nats", "nats_url": "http://127.0.0.1:4222"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({"backend": "memory"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["applied"], true);
        assert_eq!(body["taskbus"]["backend"], "memory");

        let (status, body) =
            call(&state, "POST", "/api/v1/operator/taskbus/ping", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn env_override_blocks_put() {
        let _guard = env_lock();
        let prev_taskbus = std::env::var_os("OPENSESAME_TASKBUS");
        let prev_nats = std::env::var_os("NATS_URL");
        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        std::env::remove_var("NATS_URL");
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({"backend": "memory"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"], "env_override");

        match prev_taskbus {
            Some(v) => std::env::set_var("OPENSESAME_TASKBUS", v),
            None => std::env::remove_var("OPENSESAME_TASKBUS"),
        }
        match prev_nats {
            Some(v) => std::env::set_var("NATS_URL", v),
            None => std::env::remove_var("NATS_URL"),
        }
    }

    #[tokio::test]
    async fn operator_persists_nats_url_when_unreachable() {
        let _guard = env_lock();
        let state = memory_state().await;
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({
                "backend": "nats",
                "nats_url": "nats://127.0.0.1:59999"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["applied"], false);
        assert_eq!(body["taskbus"]["backend"], "nats");
        assert_eq!(body["taskbus"]["nats_url"], "nats://127.0.0.1:59999");

        let (status, body) = call(&state, "GET", "/api/v1/operator/taskbus", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["taskbus"]["backend"], "nats");
        assert_eq!(body["taskbus"]["source"], "stored");

        let (status, body) =
            call(&state, "POST", "/api/v1/operator/taskbus/ping", None, None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["ok"], false);
    }

    #[tokio::test]
    async fn put_rejects_nats_without_url() {
        let _guard = env_lock();
        let state = memory_state().await;
        let (status, _) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({"backend": "nats"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    /// Wire-contract suite: every operator TaskBus response matches the Zod
    /// contract shape (snake_case, no secret fields, required keys).
    fn assert_taskbus_contract(view: &Value) {
        let obj = view.as_object().expect("taskbus object");
        for key in [
            "access_token",
            "refresh_token",
            "client_secret",
            "webhook_secret",
            "private_key",
            "pem",
        ] {
            assert!(!obj.contains_key(key), "forbidden key {key} in {view}");
        }
        let backend = obj.get("backend").and_then(|v| v.as_str()).unwrap();
        assert!(backend == "memory" || backend == "nats", "{backend}");
        let source = obj.get("source").and_then(|v| v.as_str()).unwrap();
        assert!(
            matches!(source, "env" | "stored" | "default"),
            "{source}"
        );
        assert!(obj.get("status").and_then(|v| v.as_str()).is_some());
        if let Some(url) = obj.get("nats_url").and_then(|v| v.as_str()) {
            let lower = url.to_ascii_lowercase();
            assert!(
                lower.starts_with("nats://") || lower.starts_with("tls://"),
                "nats_url={url}"
            );
        }
    }

    #[tokio::test]
    async fn operator_responses_match_wire_contract() {
        let _guard = env_lock();
        let state = memory_state().await;
        let (status, body) = call(&state, "GET", "/api/v1/operator/taskbus", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_taskbus_contract(&body["taskbus"]);

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({"backend": "memory"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_taskbus_contract(&body["taskbus"]);
        assert!(body.get("applied").and_then(|v| v.as_bool()).is_some());

        let (status, body) =
            call(&state, "POST", "/api/v1/operator/taskbus/ping", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["ok"].as_bool().unwrap());
        assert_taskbus_contract(&body["taskbus"]);
    }

    /// Live JetStream: PUT nats + ping must apply when NATS_URL is reachable.
    #[tokio::test]
    #[ignore = "requires live NATS JetStream (NATS_URL)"]
    async fn live_nats_operator_put_and_ping_apply() {
        let _guard = env_lock();
        let url = std::env::var("NATS_URL").expect("NATS_URL");
        std::env::remove_var("OPENSESAME_TASKBUS");
        std::env::remove_var("NATS_URL");
        let state = memory_state().await;
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/operator/taskbus",
            None,
            Some(json!({ "backend": "nats", "nats_url": url })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_taskbus_contract(&body["taskbus"]);
        assert_eq!(body["applied"], true, "{body}");
        assert_eq!(body["taskbus"]["backend"], "nats");

        let (status, body) =
            call(&state, "POST", "/api/v1/operator/taskbus/ping", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true, "{body}");
        assert_taskbus_contract(&body["taskbus"]);
    }
}
