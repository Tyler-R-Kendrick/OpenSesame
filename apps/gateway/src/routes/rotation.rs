//! Credential rotation routes (WP-9).
//!
//! Jobs and policies are pool-backed through the connection broker — no
//! process-local registry, so parallel tests and restarts see the same durable
//! rows. Agents and MCP callers may request rotation, but responses never
//! include new secret material — only job ids, machine states, and status.
//! Policy configuration (`/api/v1/rotation/policies`) is owner/admin gated
//! like the other integration-configuration surfaces.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{
    execute_connection_rotation, parse_interval, request_rotation, RotationTarget,
    UpsertRotationPolicy, EVENT_ROTATION_REQUESTED,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};

#[allow(clippy::result_large_err)]
fn authorize(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    resolve_caller(st, headers)
}

/// Policy configuration is an integration-configuration surface: owner/admin
/// sessions or the operator only (same gate as sync targets).
#[allow(clippy::result_large_err)]
fn authorize_policies(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to configure rotation policies"
            })),
        )
            .into_response());
    }
    Ok(who)
}

fn caller_organization(
    st: &AppState,
    who: &Caller,
    headers: &axum::http::HeaderMap,
) -> Result<opensesame_domain::OrganizationId, Response> {
    resolve_caller_organization(st, who, headers)
}

fn secrets_never_returned(mut view: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = view.as_object_mut() {
        // Explicit non-disclosure: agents never receive credential material.
        obj.insert("secrets_returned".into(), json!(false));
    }
    view
}

fn broker_error(error: &opensesame_connection_broker::BrokerError) -> Response {
    (
        StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({"error": error.code(), "hint": error.hint()})),
    )
        .into_response()
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

#[allow(clippy::result_large_err)]
fn target_from_body(body: &RotationRequestBody) -> Result<RotationTarget, Response> {
    match (
        body.connection_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        body.store_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    ) {
        (Some(connection_id), None) => Ok(RotationTarget::Connection {
            connection_id: connection_id.to_string(),
        }),
        (None, Some(path)) => {
            if path.contains("..") || path.contains('\0') {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "invalid_request",
                        "hint": "store_path must not traverse"
                    })),
                )
                    .into_response());
            }
            Ok(RotationTarget::StorePath {
                path: path.to_string(),
            })
        }
        (Some(_), Some(_)) => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_request",
                "hint": "provide exactly one of connection_id or store_path"
            })),
        )
            .into_response()),
        (None, None) => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_request",
                "hint": "connection_id or store_path is required"
            })),
        )
            .into_response()),
    }
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

    let target = match target_from_body(&body) {
        Ok(target) => target,
        Err(resp) => return resp,
    };

    if let Err(response) = validate_target(&st, &organization_id, &target).await {
        return response;
    }

    let mut policy_id = None;
    if let Some(interval) = body.interval.as_deref().filter(|s| !s.trim().is_empty()) {
        let Some(duration) = parse_interval(interval) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_request",
                    "hint": "interval must look like `30s`, `5m`, `24h`, `7d`, or raw seconds"
                })),
            )
                .into_response();
        };
        match st
            .connection_broker
            .upsert_rotation_policy(
                &organization_id.to_string(),
                UpsertRotationPolicy {
                    id: None,
                    target: target.clone(),
                    interval_seconds: duration.as_secs(),
                    enabled: true,
                },
            )
            .await
        {
            Ok(policy) => policy_id = Some(policy.id),
            Err(e) => return broker_error(&e),
        }
    }

    let bus = st.task_bus.read().await;
    let job = match request_rotation(
        st.connection_broker.as_ref(),
        bus.as_ref(),
        target.clone(),
        body.project_id.clone(),
        &organization_id.to_string(),
        policy_id,
    )
    .await
    {
        Ok(job) => job,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "bus_publish_failed", "hint": e.hint()})),
            )
                .into_response();
        }
    };

    let mut response = job.public_view();
    if let Some(obj) = response.as_object_mut() {
        obj.insert("event_type".into(), json!(EVENT_ROTATION_REQUESTED));
    }
    let response = secrets_never_returned(response);

    if body.execute_now && matches!(target, RotationTarget::Connection { .. }) {
        let execution = execute_connection_rotation(
            st.connection_broker.as_ref(),
            bus.as_ref(),
            &organization_id,
            &job.id,
        )
        .await;
        if let Ok(done) = execution {
            let view = secrets_never_returned(done.public_view());
            return (StatusCode::OK, Json(view)).into_response();
        }
        if let Ok(Some(failed)) = st
            .connection_broker
            .get_rotation_job(&organization_id.to_string(), &job.id)
            .await
        {
            let view = secrets_never_returned(failed.public_view());
            return (StatusCode::CONFLICT, Json(view)).into_response();
        }
    }

    (StatusCode::ACCEPTED, Json(response)).into_response()
}

async fn validate_target(
    st: &AppState,
    organization_id: &opensesame_domain::OrganizationId,
    target: &RotationTarget,
) -> Result<(), Response> {
    let RotationTarget::Connection { connection_id } = target else {
        return Ok(());
    };
    if st
        .connection_broker
        .get_connection(organization_id, connection_id)
        .await
        .is_ok()
    {
        return Ok(());
    }
    Err((
        StatusCode::NOT_FOUND,
        Json(json!({"error": "connection_not_found"})),
    )
        .into_response())
}

/// `GET /api/v1/rotations/{id}` — job status only (no secrets).
pub async fn get_job(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .get_rotation_job(&organization_id.to_string(), &id)
        .await
    {
        Ok(Some(job)) => Json(secrets_never_returned(job.public_view())).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "not_found", "hint": "rotation job not found"})),
        )
            .into_response(),
        Err(e) => broker_error(&e),
    }
}

/// `GET /api/v1/rotations` — list jobs (metadata only).
pub async fn list_jobs(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .list_rotation_jobs(&organization_id.to_string(), 100)
        .await
    {
        Ok(jobs) => {
            let jobs: Vec<_> = jobs
                .into_iter()
                .map(|j| secrets_never_returned(j.public_view()))
                .collect();
            Json(json!({"rotations": jobs, "secrets_returned": false})).into_response()
        }
        Err(e) => broker_error(&e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyPutBody {
    /// Existing policy id to update; omit to create.
    pub id: Option<String>,
    pub connection_id: Option<String>,
    pub store_path: Option<String>,
    /// Schedule interval (`24h`, `3600`, …).
    pub interval: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// `GET /api/v1/rotation/policies` — durable policies (owner/admin gated).
pub async fn list_policies(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize_policies(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .list_rotation_policies(&organization_id.to_string())
        .await
    {
        Ok(policies) => {
            let policies: Vec<_> = policies
                .into_iter()
                .map(|p| secrets_never_returned(p.public_view()))
                .collect();
            Json(json!({"policies": policies, "secrets_returned": false})).into_response()
        }
        Err(e) => broker_error(&e),
    }
}

/// `PUT /api/v1/rotation/policies` — upsert one durable policy (owner/admin
/// gated). Values never appear anywhere on this surface.
pub async fn put_policy(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PolicyPutBody>,
) -> Response {
    let who = match authorize_policies(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    let target = match target_from_body(&RotationRequestBody {
        connection_id: body.connection_id.clone(),
        store_path: body.store_path.clone(),
        project_id: None,
        interval: None,
        execute_now: false,
    }) {
        Ok(target) => target,
        Err(resp) => return resp,
    };
    if let RotationTarget::Connection { connection_id } = &target {
        if st
            .connection_broker
            .get_connection(&organization_id, connection_id)
            .await
            .is_err()
        {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "connection_not_found"})),
            )
                .into_response();
        }
    }
    let Some(duration) = parse_interval(&body.interval) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_request",
                "hint": "interval must look like `30s`, `5m`, `24h`, `7d`, or raw seconds"
            })),
        )
            .into_response();
    };

    match st
        .connection_broker
        .upsert_rotation_policy(
            &organization_id.to_string(),
            UpsertRotationPolicy {
                id: body.id,
                target,
                interval_seconds: duration.as_secs(),
                enabled: body.enabled,
            },
        )
        .await
    {
        Ok(policy) => Json(secrets_never_returned(policy.public_view())).into_response(),
        Err(e) => broker_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_connection_broker::RotationStatus;
    use opensesame_task_bus::{InMemoryTaskBus, TaskBus as _};

    #[tokio::test]
    async fn requested_event_has_no_secret_payload() {
        let db = opensesame_storage::Db::connect_memory().await.unwrap();
        let broker = opensesame_connection_broker::ConnectionBroker::new(
            db.pool().clone(),
            opensesame_connection_broker::BrokerConfig::in_memory(
                Some([9u8; 32]),
                "http://127.0.0.1:8787",
            ),
        )
        .unwrap();
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &broker,
            &bus,
            RotationTarget::Connection {
                connection_id: "connection:test".into(),
            },
            None,
            "org:test",
            None,
        )
        .await
        .unwrap();
        assert_eq!(job.status, RotationStatus::Requested);
        let view = job.public_view().to_string();
        assert!(!view.contains("access_token"));
        assert!(!view.contains("\"password\""));
        assert_eq!(
            job.public_view()["secrets_returned"],
            serde_json::Value::Null
        );
        let events = bus.drain(10).await.unwrap();
        assert!(!events[0].data.to_string().contains("access_token"));
    }

    use crate::app_state::{test_demo_state, test_session_headers, AppState};
    use axum::body::Body;
    use axum::http::Request;
    use opensesame_domain::OrganizationRole;
    use tower::ServiceExt;

    async fn send(
        st: &AppState,
        headers: &axum::http::HeaderMap,
        method: &str,
        uri: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header(
                "authorization",
                headers.get("authorization").unwrap().as_bytes(),
            )
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = crate::routes::router(st.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn policy_routes_are_owner_admin_gated() {
        let st = test_demo_state().await;
        let org = st.connection_organization;
        let member = test_session_headers(&st, "principal:member", org, OrganizationRole::Member);
        let body = json!({"store_path": "Dev/api-token", "interval": "24h"});
        let (status, _) = send(
            &st,
            &member,
            "PUT",
            "/api/v1/rotation/policies",
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(&st, &member, "GET", "/api/v1/rotation/policies", json!({})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let (status, created) = send(&st, &admin, "PUT", "/api/v1/rotation/policies", body).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["interval_seconds"], 86_400);
        assert_eq!(created["enabled"], true);
        assert_eq!(created["secrets_returned"], false);

        let (status, listed) =
            send(&st, &admin, "GET", "/api/v1/rotation/policies", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["policies"].as_array().unwrap().len(), 1);
        let text = listed.to_string();
        assert!(!text.contains("access_token"));
        assert!(!text.contains("client_secret"));

        // Update in place: disable it, keeping the same id.
        let id = created["id"].as_str().unwrap();
        let (status, updated) = send(
            &st,
            &admin,
            "PUT",
            "/api/v1/rotation/policies",
            json!({"id": id, "store_path": "Dev/api-token", "interval": "1h", "enabled": false}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["id"], id);
        assert_eq!(updated["interval_seconds"], 3600);
        assert_eq!(updated["enabled"], false);

        // Garbage interval is refused.
        let (status, _) = send(
            &st,
            &admin,
            "PUT",
            "/api/v1/rotation/policies",
            json!({"store_path": "Dev/api-token", "interval": "soon"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn jobs_are_durable_and_value_blind_across_router_instances() {
        let st = test_demo_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);

        let (status, accepted) = send(
            &st,
            &admin,
            "POST",
            "/api/v1/rotations",
            json!({"store_path": "Dev/api-token", "interval": "24h"}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
        assert_eq!(accepted["state"], "scheduled");
        assert_eq!(accepted["secrets_returned"], false);
        assert!(
            accepted["policy_id"].is_string(),
            "interval creates a policy"
        );
        let id = accepted["id"].as_str().unwrap().to_string();

        // No static registry: a fresh router over the same state (pool) still
        // sees the job.
        let (status, fetched) = send(
            &st,
            &admin,
            "GET",
            &format!("/api/v1/rotations/{id}"),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched["id"], id.as_str());
        assert_eq!(fetched["secrets_returned"], false);

        let (status, listed) = send(&st, &admin, "GET", "/api/v1/rotations", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["rotations"].as_array().unwrap().len(), 1);
        let text = listed.to_string();
        assert!(!text.contains("access_token"));
        assert!(!text.contains("refresh_token"));
        assert!(!text.contains("\"password\""));
    }
}
