//! Credential rotation request routes (WP-E).
//!
//! Agents and MCP callers may request rotation, but responses never include new
//! secret material — only job ids, status, and opaque credential version hints.

use std::sync::{Arc, OnceLock};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{
    execute_connection_rotation, request_rotation, RotationPolicy, RotationRegistry,
    RotationTarget, EVENT_ROTATION_REQUESTED,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};

fn registry() -> &'static Arc<RotationRegistry> {
    static REGISTRY: OnceLock<Arc<RotationRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Arc::new(RotationRegistry::new()))
}

#[allow(clippy::result_large_err)]
fn authorize(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    resolve_caller(st, headers)
}

const OPERATOR_ORGANIZATION_HEADER: &str = "x-opensesame-organization";

fn caller_organization(
    st: &AppState,
    who: &Caller,
    headers: &axum::http::HeaderMap,
) -> Result<opensesame_domain::OrganizationId, Response> {
    let selected = headers.get(OPERATOR_ORGANIZATION_HEADER);
    match who {
        Caller::Operator => match selected {
            Some(raw) => match raw.to_str().ok().and_then(|value| {
                opensesame_domain::OrganizationId::parse(value)
                    .ok()
                    .filter(|id| id.to_string() == value)
            }) {
                Some(id) => Ok(id),
                _ => Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "invalid_request",
                        "hint": "x-opensesame-organization must be a canonical organization id"
                    })),
                )
                    .into_response()),
            },
            None => Ok(who.organization(st.connection_organization)),
        },
        Caller::Session { .. } => {
            if selected.is_some() {
                Err((
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "error": "forbidden",
                        "hint": "sessions cannot select an organization header"
                    })),
                )
                    .into_response())
            } else {
                Ok(who.organization(st.connection_organization))
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RotationRequestBody {
    /// Connection id to rotate (authority-plane credentials).
    pub connection_id: Option<String>,
    /// Sealed-store logical path (metadata schedule only on Host).
    pub store_path: Option<String>,
    pub project_id: Option<String>,
    /// Optional schedule interval (`24h`, `3600`, …). Stored without secrets.
    pub interval: Option<String>,
    /// When true, attempt refresh immediately after enqueue (operator/session).
    #[serde(default)]
    pub execute_now: bool,
}

/// `POST /api/v1/rotations` — enqueue rotation; never returns secrets.
pub async fn request(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<RotationRequestBody>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    let target = match (
        body.connection_id.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.store_path.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(connection_id), None) => RotationTarget::Connection {
            connection_id: connection_id.to_string(),
        },
        (None, Some(path)) => RotationTarget::StorePath {
            path: path.to_string(),
        },
        (Some(_), Some(_)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_request",
                    "hint": "provide exactly one of connection_id or store_path"
                })),
            )
                .into_response();
        }
        (None, None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_request",
                    "hint": "connection_id or store_path is required"
                })),
            )
                .into_response();
        }
    };

    let mut policy_id = None;
    if let Some(interval) = body.interval.filter(|s| !s.trim().is_empty()) {
        let policy = registry().upsert_policy(RotationPolicy::new(
            interval,
            target.clone(),
            body.project_id.clone(),
            Some(organization_id.to_string()),
        ));
        policy_id = Some(policy.id);
    }

    let job = match request_rotation(
        registry(),
        st.task_bus.as_ref(),
        target.clone(),
        body.project_id.clone(),
        Some(organization_id.to_string()),
        policy_id,
    )
    .await
    {
        Ok(job) => job,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "bus_publish_failed", "hint": e.to_string()})),
            )
                .into_response();
        }
    };

    let mut response = job.public_view();
    if let Some(obj) = response.as_object_mut() {
        obj.insert("event_type".into(), json!(EVENT_ROTATION_REQUESTED));
        // Explicit non-disclosure: agents never receive credential material.
        obj.insert("secrets_returned".into(), json!(false));
    }

    if body.execute_now {
        if let RotationTarget::Connection { .. } = &target {
            match execute_connection_rotation(
                registry(),
                st.task_bus.as_ref(),
                st.connection_broker.as_ref(),
                &organization_id,
                &job.id,
            )
            .await
            {
                Ok(done) => {
                    let mut view = done.public_view();
                    if let Some(obj) = view.as_object_mut() {
                        obj.insert("secrets_returned".into(), json!(false));
                    }
                    return (StatusCode::OK, Json(view)).into_response();
                }
                Err(_) => {
                    if let Some(failed) = registry().get_job(&job.id) {
                        let mut view = failed.public_view();
                        if let Some(obj) = view.as_object_mut() {
                            obj.insert("secrets_returned".into(), json!(false));
                        }
                        return (StatusCode::CONFLICT, Json(view)).into_response();
                    }
                }
            }
        }
    }

    (StatusCode::ACCEPTED, Json(response)).into_response()
}

/// `GET /api/v1/rotations/{id}` — job status only (no secrets).
pub async fn get_job(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let _who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    match registry().get_job(&id) {
        Some(job) => {
            let mut view = job.public_view();
            if let Some(obj) = view.as_object_mut() {
                obj.insert("secrets_returned".into(), json!(false));
            }
            Json(view).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "not_found", "hint": "rotation job not found"})),
        )
            .into_response(),
    }
}

/// `GET /api/v1/rotations` — list jobs (metadata only).
pub async fn list_jobs(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    let _who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let jobs: Vec<_> = registry()
        .list_jobs()
        .into_iter()
        .map(|j| {
            let mut view = j.public_view();
            if let Some(obj) = view.as_object_mut() {
                obj.insert("secrets_returned".into(), json!(false));
            }
            view
        })
        .collect();
    Json(json!({"rotations": jobs, "secrets_returned": false})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_connection_broker::RotationStatus;
    use opensesame_task_bus::InMemoryTaskBus;

    #[tokio::test]
    async fn requested_event_has_no_secret_payload() {
        let reg = RotationRegistry::new();
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &reg,
            &bus,
            RotationTarget::Connection {
                connection_id: "connection:test".into(),
            },
            None,
            Some("org:test".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(job.status, RotationStatus::Requested);
        let view = job.public_view().to_string();
        assert!(!view.contains("access_token"));
        assert!(!view.contains("\"password\""));
        assert_eq!(job.public_view()["secrets_returned"], serde_json::Value::Null);
    }
}
