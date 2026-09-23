//! Operator transport routes: status, service bindings, and the enforcement
//! probe.
//!
//! Reads (`status`) are gated like `routes/taskbus_config.rs` — a Host
//! session whose role may configure integrations, or the deployment operator
//! token. Everything deployment-scoped is the deployment operator's alone:
//! the binding set (which carries `Deployment`-scoped bindings and every
//! organization's bindings side by side) is read and replaced, and the
//! enforcement probe is started, only by `Caller::Operator`. An owner or
//! admin of *an* organization is not an administrator of the deployment, so
//! their session gets `403` there. Transport evidence is deliberately *not*
//! a way in here: mTLS is not an alternate operator login, so an admitted
//! service peer that never presented a session gets the same 403 anyone
//! else would.
//!
//! Every body is bounded and rejects unknown fields; the status body is
//! `TransportStatusView` exactly, with no path, distinguished name, socket,
//! key, or cross-tenant topology in it.

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};

use super::bindings::{self, PutError, MAX_BINDINGS_BYTES};
use super::probe::{self, ProbeTarget};
use super::status;

/// Largest verify body; it carries one word.
const VERIFY_BODY_BYTES: usize = 1024;

/// The operator transport surface.
#[must_use]
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/operator/transport/status", get(get_status))
        .route(
            "/api/v1/operator/transport/bindings",
            get(get_bindings)
                .put(put_bindings)
                .layer(DefaultBodyLimit::max(MAX_BINDINGS_BYTES)),
        )
        .route(
            "/api/v1/operator/transport/verify",
            post(verify).layer(DefaultBodyLimit::max(VERIFY_BODY_BYTES)),
        )
}

#[allow(clippy::result_large_err)]
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
                "hint": "owner or admin role required to read transport configuration"
            })),
        )
            .into_response());
    }
    Ok(who)
}

/// Deployment-scoped reads and writes: the operator credential only. An
/// organization's owner or admin session is refused — its role is scoped to
/// its own organization, and these routes are not.
#[allow(clippy::result_large_err)]
pub(crate) fn require_deployment_operator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(), Response> {
    match resolve_caller(st, headers)? {
        Caller::Operator => Ok(()),
        Caller::Session { .. } => Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "the deployment operator credential is required for deployment-scoped transport configuration"
            })),
        )
            .into_response()),
    }
}

fn unconfigured() -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "transport": null,
            "hint": "no transport listener or service bindings are configured on this host"
        })),
    )
        .into_response()
}

pub async fn get_status(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    let Some(runtime) = st.transport.as_ref() else {
        return unconfigured();
    };
    let facts = runtime
        .status
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let managed = crate::transport::ManagedIdentityResolver::capability(&st);
    let view = status::view(runtime, &facts, &managed, &st.transport_lifecycle);
    (StatusCode::OK, Json(view)).into_response()
}

pub async fn get_bindings(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_deployment_operator(&st, &headers) {
        return resp;
    }
    let Some(runtime) = st.transport.as_ref() else {
        return unconfigured();
    };
    // Another gateway sharing the store may have replaced the set; report
    // (and admit on) what is stored rather than this process's older copy.
    if let Err(error) =
        bindings::refresh(&st.db, runtime.bindings_source, runtime.bindings.as_ref()).await
    {
        tracing::warn!(code = error.code(), "service bindings refresh failed");
    }
    (
        StatusCode::OK,
        Json(json!({
            "source": runtime.bindings_source,
            "bindings": runtime.binding_set(),
        })),
    )
        .into_response()
}

/// Compare-and-set replacement. The caller sends the revision it read; a
/// stale revision is refused so two operators cannot overwrite each other
/// blind, and the env file always wins over the store.
pub async fn put_bindings(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = require_deployment_operator(&st, &headers) {
        return resp;
    }
    let Some(runtime) = st.transport.as_ref() else {
        return unconfigured();
    };
    let proposed = match bindings::parse_bounded(&body) {
        Ok(set) => set,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": error.code(), "hint": error.to_string()})),
            )
                .into_response()
        }
    };
    match bindings::put_cas(
        &st.db,
        runtime.bindings_source,
        Some(runtime.bindings.as_ref()),
        proposed,
    )
    .await
    {
        Ok(stored) => (
            StatusCode::OK,
            Json(json!({ "source": runtime.bindings_source, "bindings": stored })),
        )
            .into_response(),
        Err(error) => put_refusal(&error),
    }
}

fn put_refusal(error: &PutError) -> Response {
    match error {
        PutError::EnvOverride => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "env_override",
                "hint": "OPENSESAME_SERVICE_BINDINGS_FILE is set on this host; edit the file or unset it"
            })),
        )
            .into_response(),
        PutError::StaleRevision { current } => (
            StatusCode::CONFLICT,
            Json(json!({"error": "stale_revision", "revision": current})),
        )
            .into_response(),
        PutError::Invalid(inner) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": inner.code(), "hint": inner.to_string()})),
        )
            .into_response(),
        PutError::Storage(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "internal"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyBody {
    /// One of `host-tls`, `worker`, `identity-mapping`. Never a host, URL,
    /// port, or address.
    pub target: String,
}

pub async fn verify(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<VerifyBody>,
) -> Response {
    if let Err(resp) = require_deployment_operator(&st, &headers) {
        return resp;
    }
    let Some(runtime) = st.transport.as_ref() else {
        return unconfigured();
    };
    let Some(target) = ProbeTarget::parse(&body.target) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_request",
                "hint": "target must be host-tls, worker, or identity-mapping"
            })),
        )
            .into_response();
    };
    let plan = match probe::plan(runtime, target) {
        Ok(plan) => plan,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": error.code()})),
            )
                .into_response()
        }
    };
    match probe::run(&plan, runtime.generation()).await {
        Ok(outcome) => {
            status::record_enforcement(&runtime.status, outcome.clone());
            (StatusCode::OK, Json(json!({ "enforcement": outcome }))).into_response()
        }
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": error.code()})),
        )
            .into_response(),
    }
}
