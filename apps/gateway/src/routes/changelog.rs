//! Host-readable secret/config changelog (metadata only).
//!
//! Lists project-scoped events from the durable `secret_changelog` table
//! (cursor-paged by `seq`; the in-memory ring is only a cache / fallback).
//! Never returns secret values — only key names, version ids, and sync
//! target metadata.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{is_allowed_changelog_event_type, RecordSecretChangelog};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    limit: usize,
    /// Durable-store cursor: return rows with seq strictly below this.
    #[serde(default)]
    before_seq: Option<i64>,
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
    let caller = match resolve_caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    if !caller.can_configure_integrations() {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "forbidden"}))).into_response();
    }
    if project_id.trim().is_empty() || project_id.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_project_id"})),
        )
            .into_response();
    }
    let organization_id = caller.organization(st.connection_organization).to_string();
    let limit = query.limit.clamp(1, 200);
    // Host-owned store: filter by the authenticated organization, never by a
    // caller-supplied project id across tenants.
    let events = match st
        .connection_broker
        .list_changelog(&organization_id, &project_id, limit, query.before_seq)
        .await
    {
        Ok(events) => events,
        Err(e) => return crate::routes::connections::broker_error(&e),
    };
    let next_cursor = events.iter().filter_map(|e| e.seq).min();
    (
        StatusCode::OK,
        Json(json!({
            "project_id": project_id,
            "events": events,
            "next_before_seq": next_cursor,
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
    if !caller.can_configure_integrations() {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "forbidden"}))).into_response();
    }
    if body.project_id.trim().is_empty() || body.event_type.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_body"})),
        )
            .into_response();
    }
    if !is_allowed_changelog_event_type(&body.event_type) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_event_type"})),
        )
            .into_response();
    }
    let organization_id = caller.organization(st.connection_organization).to_string();
    if let Some(claimed) = body.organization_id.as_deref() {
        if claimed != organization_id {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "forbidden"}))).into_response();
        }
    }
    let actor_id = match &caller {
        crate::middleware::auth::Caller::Operator => Some("operator".into()),
        crate::middleware::auth::Caller::Session { subject, .. } => Some(subject.clone()),
    };
    let entry = match st
        .connection_broker
        .record_changelog(RecordSecretChangelog {
            event_type: body.event_type,
            project_id: body.project_id,
            organization_id: Some(organization_id),
            actor_id,
            config_id: body.config_id,
            environment: body.environment,
            key_names: body.key_names,
            version_id: body.version_id,
            target_id: body.target_id,
            content_version: body.content_version,
            occurred_at: None,
            metadata: body.metadata,
        })
        .await
    {
        Ok(entry) => entry,
        Err(e) => return crate::routes::connections::broker_error(&e),
    };
    let serialized = serde_json::to_value(&entry).unwrap_or_else(|_| json!({}));
    (StatusCode::CREATED, Json(serialized)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{HeaderMap, Request, StatusCode};
    use opensesame_domain::OrganizationRole;
    use tower::ServiceExt;

    async fn app() -> (axum::Router, crate::app_state::AppState) {
        let state = crate::app_state::test_demo_state().await;
        let router = crate::routes::router(state.clone());
        (router, state)
    }

    fn with_headers(mut request: Request<Body>, headers: &HeaderMap) -> Request<Body> {
        for (name, value) in headers {
            request.headers_mut().insert(name, value.clone());
        }
        request
    }

    async fn post_record(
        router: axum::Router,
        headers: HeaderMap,
        project: String,
        key_name: &'static str,
        version: String,
    ) -> axum::response::Response {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/changelog")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({
                    "event_type": "secret.value.changed",
                    "project_id": project,
                    "key_names": [key_name],
                    "version_id": version,
                })
                .to_string(),
            ))
            .unwrap();
        router
            .oneshot(with_headers(request, &headers))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn list_returns_metadata_without_secret_values() {
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
        let record_request = Request::builder()
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
        let record_request = with_headers(record_request, &record_headers);
        let record_response = router.clone().oneshot(record_request).await.unwrap();
        assert_eq!(record_response.status(), StatusCode::CREATED);
        let record_body = axum::body::to_bytes(record_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let record_json: serde_json::Value = serde_json::from_slice(&record_body).unwrap();
        let record_text = record_json.to_string();
        assert!(!record_text.contains("must-not-appear"));
        assert!(!record_text.contains("nope"));
        assert!(!record_text.contains("leak"));

        let list_request = Request::builder()
            .method("GET")
            .uri(format!(
                "/api/v1/projects/{}/changelog?limit=10",
                boot.project
            ))
            .body(Body::empty())
            .unwrap();
        let list_request = with_headers(list_request, &headers);
        let list_response = router.oneshot(list_request).await.unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
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
        let (router, _) = app().await;
        let request = Request::builder()
            .method("GET")
            .uri("/api/v1/projects/project_x/changelog")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert!(
            response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::FORBIDDEN,
            "unexpected status {}",
            response.status()
        );
    }

    #[tokio::test]
    async fn list_does_not_leak_another_organization_changelog() {
        let (router, state) = app().await;
        let boot = state.bootstrap.lock().unwrap().clone().unwrap();
        let owner = crate::app_state::test_session_headers(
            &state,
            &format!("prn_{}", boot.principal.as_uuid()),
            boot.org,
            OrganizationRole::Owner,
        );
        let mut record_headers = owner.clone();
        record_headers.insert(
            axum::http::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        let record_request = Request::builder()
            .method("POST")
            .uri("/api/v1/changelog")
            .body(Body::from(
                serde_json::json!({
                    "event_type": "secret.value.changed",
                    "project_id": boot.project.to_string(),
                    "key_names": ["DATABASE_URL"]
                })
                .to_string(),
            ))
            .unwrap();
        let record_request = with_headers(record_request, &record_headers);
        let record_response = router.clone().oneshot(record_request).await.unwrap();
        assert_eq!(record_response.status(), StatusCode::CREATED);

        let foreign = opensesame_domain::OrganizationId::new();
        let other = crate::app_state::test_session_headers(
            &state,
            "prn_other",
            foreign,
            OrganizationRole::Owner,
        );
        let list_request = Request::builder()
            .method("GET")
            .uri(format!(
                "/api/v1/projects/{}/changelog?limit=10",
                boot.project
            ))
            .body(Body::empty())
            .unwrap();
        let list_request = with_headers(list_request, &other);
        let list_response = router.oneshot(list_request).await.unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
        let events = list_json["events"].as_array().expect("events");
        assert!(events.is_empty(), "cross-tenant changelog must be empty");
        assert!(!list_json.to_string().contains("DATABASE_URL"));
    }

    #[tokio::test]
    async fn record_rejects_unknown_event_types() {
        let (router, state) = app().await;
        let boot = state.bootstrap.lock().unwrap().clone().unwrap();
        let mut headers = crate::app_state::test_session_headers(
            &state,
            &format!("prn_{}", boot.principal.as_uuid()),
            boot.org,
            OrganizationRole::Owner,
        );
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/changelog")
            .body(Body::from(
                serde_json::json!({
                    "event_type": "secret.value.exfiltrated",
                    "project_id": boot.project.to_string()
                })
                .to_string(),
            ))
            .unwrap();
        let request = with_headers(request, &headers);
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn concurrent_records_from_two_orgs_never_mix() {
        let (router, state) = app().await;
        let project = state
            .bootstrap
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .to_string();
        let org_a = crate::app_state::test_session_headers(
            &state,
            "prn_a",
            opensesame_domain::OrganizationId::new(),
            OrganizationRole::Owner,
        );
        let org_b = crate::app_state::test_session_headers(
            &state,
            "prn_b",
            opensesame_domain::OrganizationId::new(),
            OrganizationRole::Owner,
        );
        let mut joins = Vec::new();
        for i in 0..16 {
            joins.push(tokio::spawn(post_record(
                router.clone(),
                org_a.clone(),
                project.clone(),
                "ORG_A_KEY",
                format!("v{i}"),
            )));
            joins.push(tokio::spawn(post_record(
                router.clone(),
                org_b.clone(),
                project.clone(),
                "ORG_B_KEY",
                format!("v{i}"),
            )));
        }
        for join in joins {
            assert_eq!(join.await.unwrap().status(), StatusCode::CREATED);
        }
        for (headers, forbidden) in [(&org_a, "ORG_B_KEY"), (&org_b, "ORG_A_KEY")] {
            let list_request = Request::builder()
                .method("GET")
                .uri(format!("/api/v1/projects/{project}/changelog?limit=200"))
                .body(Body::empty())
                .unwrap();
            let list_request = with_headers(list_request, headers);
            let response = router.clone().oneshot(list_request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let text = json.to_string();
            assert!(!text.contains(forbidden), "{text}");
            assert_eq!(json["events"].as_array().unwrap().len(), 16);
        }
    }
}
