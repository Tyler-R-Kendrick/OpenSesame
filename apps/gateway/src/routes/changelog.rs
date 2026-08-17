//! Host-readable secret/config changelog (metadata only).
//!
//! Lists project-scoped events recorded via
//! [`opensesame_connection_broker::record_secret_changelog`]. Never returns
//! secret values — only key names, version ids, and sync target metadata.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{list_secret_changelog, record_secret_changelog, RecordSecretChangelog};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    50
}

/// `GET /api/v1/projects/{project_id}/changelog`
pub async fn list_for_project(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Response {
    if let Err(resp) = resolve_caller(&st, &headers) {
        return resp;
    }
    if project_id.trim().is_empty() || project_id.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_project_id"})),
        )
            .into_response();
    }
    let limit = query.limit.clamp(1, 200);
    let events = list_secret_changelog(&project_id, limit);
    // Authz gate: session/operator already required. Project membership is
    // enforced by Identity/project APIs; Host returns only metadata rows that
    // were recorded for this project id.
    (
        StatusCode::OK,
        Json(json!({
            "project_id": project_id,
            "events": events,
        })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct RecordBody {
    event_type: String,
    project_id: String,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    actor_id: Option<String>,
    #[serde(default)]
    config_id: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    key_names: Vec<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    content_version: Option<String>,
    #[serde(default)]
    metadata: serde_json::Map<String, serde_json::Value>,
}

/// Operator/internal record endpoint for Host-plane changelog rows.
/// Agents must not use this to retrieve secrets — the body rejects values and
/// the response echoes redacted metadata only.
pub async fn record(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<RecordBody>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    // Humans/operators only — not a general agent write surface.
    if !matches!(
        caller,
        crate::middleware::auth::Caller::Operator
            | crate::middleware::auth::Caller::Session { .. }
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "forbidden"})),
        )
            .into_response();
    }
    if body.project_id.trim().is_empty() || body.event_type.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_body"})),
        )
            .into_response();
    }
    let entry = record_secret_changelog(RecordSecretChangelog {
        event_type: body.event_type,
        project_id: body.project_id,
        organization_id: body.organization_id,
        actor_id: body.actor_id,
        config_id: body.config_id,
        environment: body.environment,
        key_names: body.key_names,
        version_id: body.version_id,
        target_id: body.target_id,
        content_version: body.content_version,
        occurred_at: None,
        metadata: body.metadata,
    });
    let serialized = serde_json::to_value(&entry).unwrap_or_else(|_| json!({}));
    (StatusCode::CREATED, Json(serialized)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use opensesame_connection_broker::clear_secret_changelog_for_tests;
    use opensesame_domain::OrganizationRole;
    use tower::ServiceExt;

    async fn app() -> (axum::Router, crate::app_state::AppState) {
        let state = crate::app_state::test_demo_state().await;
        let router = crate::routes::router(state.clone());
        (router, state)
    }

    #[tokio::test]
    async fn list_returns_metadata_without_secret_values() {
        clear_secret_changelog_for_tests();
        let (router, state) = app().await;
        let boot = state.bootstrap.lock().unwrap().clone().unwrap();
        let headers = crate::app_state::test_session_headers(
            &state,
            &format!("prn_{}", boot.principal.as_uuid()),
            boot.org,
            OrganizationRole::Owner,
        );

        let mut record_headers = headers.clone();
        record_headers.insert(
            axum::http::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        let record_req = Request::builder()
            .method("POST")
            .uri("/api/v1/changelog")
            .body(Body::from(
                serde_json::json!({
                    "event_type": "secret.value.changed",
                    "project_id": boot.project.to_string(),
                    "config_id": "cfg_1",
                    "environment": "production",
                    "key_names": ["API_TOKEN"],
                    "version_id": "ver_1",
                    "metadata": {
                        "value": "must-not-appear",
                        "password": "nope",
                        "token": "leak"
                    }
                })
                .to_string(),
            ))
            .unwrap();
        // Attach auth headers
        let mut record_req = record_req;
        for (k, v) in record_headers.iter() {
            record_req.headers_mut().insert(k, v.clone());
        }
        let record_res = router.clone().oneshot(record_req).await.unwrap();
        assert_eq!(record_res.status(), StatusCode::CREATED);
        let record_body = axum::body::to_bytes(record_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let record_json: serde_json::Value = serde_json::from_slice(&record_body).unwrap();
        let record_text = record_json.to_string();
        assert!(!record_text.contains("must-not-appear"));
        assert!(!record_text.contains("nope"));
        assert!(!record_text.contains("leak"));

        let list_req = Request::builder()
            .method("GET")
            .uri(format!(
                "/api/v1/projects/{}/changelog?limit=10",
                boot.project
            ))
            .body(Body::empty())
            .unwrap();
        let mut list_req = list_req;
        for (k, v) in headers.iter() {
            list_req.headers_mut().insert(k, v.clone());
        }
        let list_res = router.oneshot(list_req).await.unwrap();
        assert_eq!(list_res.status(), StatusCode::OK);
        let list_body = axum::body::to_bytes(list_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
        let events = list_json["events"].as_array().expect("events");
        assert!(!events.is_empty());
        let text = list_json.to_string();
        assert!(!text.contains("must-not-appear"));
        assert_eq!(events[0]["event_type"], "secret.value.changed");
        assert_eq!(events[0]["key_names"][0], "API_TOKEN");
    }

    #[tokio::test]
    async fn list_requires_auth() {
        clear_secret_changelog_for_tests();
        let (router, _) = app().await;
        let req = Request::builder()
            .method("GET")
            .uri("/api/v1/projects/project_x/changelog")
            .body(Body::empty())
            .unwrap();
        let res = router.oneshot(req).await.unwrap();
        assert!(
            res.status() == StatusCode::UNAUTHORIZED || res.status() == StatusCode::FORBIDDEN,
            "unexpected status {}",
            res.status()
        );
    }
}
