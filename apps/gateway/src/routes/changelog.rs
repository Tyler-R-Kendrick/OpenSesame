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
use opensesame_connection_broker::{
    is_allowed_changelog_event_type, list_secret_changelog, record_secret_changelog,
    RecordSecretChangelog,
};
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
    let caller = match resolve_caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    if !caller.can_configure_integrations() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "forbidden"})),
        )
            .into_response();
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
    let events = list_secret_changelog(&organization_id, &project_id, limit);
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
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "forbidden"})),
            )
                .into_response();
        }
    }
    let actor_id = match &caller {
        crate::middleware::auth::Caller::Operator => Some("operator".into()),
        crate::middleware::auth::Caller::Session { subject, .. } => Some(subject.clone()),
    };
    let entry = record_secret_changelog(RecordSecretChangelog {
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
    });
    let serialized = serde_json::to_value(&entry).unwrap_or_else(|_| json!({}));
    (StatusCode::CREATED, Json(serialized)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use opensesame_domain::OrganizationRole;
    use tower::ServiceExt;

    async fn app() -> (axum::Router, crate::app_state::AppState) {
        let state = crate::app_state::test_demo_state().await;
        let router = crate::routes::router(state.clone());
        (router, state)
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
        let mut record_req = Request::builder()
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
        for (k, v) in record_headers.iter() {
            record_req.headers_mut().insert(k, v.clone());
        }
        let record_res = router.clone().oneshot(record_req).await.unwrap();
        assert_eq!(record_res.status(), StatusCode::CREATED);

        let foreign = opensesame_domain::OrganizationId::new();
        let other = crate::app_state::test_session_headers(
            &state,
            "prn_other",
            foreign,
            OrganizationRole::Owner,
        );
        let mut list_req = Request::builder()
            .method("GET")
            .uri(format!(
                "/api/v1/projects/{}/changelog?limit=10",
                boot.project
            ))
            .body(Body::empty())
            .unwrap();
        for (k, v) in other.iter() {
            list_req.headers_mut().insert(k, v.clone());
        }
        let list_res = router.oneshot(list_req).await.unwrap();
        assert_eq!(list_res.status(), StatusCode::OK);
        let list_body = axum::body::to_bytes(list_res.into_body(), usize::MAX)
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
        let mut req = Request::builder()
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
        for (k, v) in headers.iter() {
            req.headers_mut().insert(k, v.clone());
        }
        let res = router.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
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
            for headers in [&org_a, &org_b] {
                let mut req = Request::builder()
                    .method("POST")
                    .uri("/api/v1/changelog")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "event_type": "secret.value.changed",
                            "project_id": project,
                            "key_names": [if headers.get(axum::http::header::AUTHORIZATION)
                                == org_a.get(axum::http::header::AUTHORIZATION) { "ORG_A_KEY" } else { "ORG_B_KEY" }],
                            "version_id": format!("v{i}")
                        })
                        .to_string(),
                    ))
                    .unwrap();
                for (k, v) in headers.iter() {
                    req.headers_mut().insert(k, v.clone());
                }
                let r = router.clone();
                joins.push(tokio::spawn(async move { r.oneshot(req).await.unwrap() }));
            }
        }
        for join in joins {
            assert_eq!(join.await.unwrap().status(), StatusCode::CREATED);
        }
        for (headers, forbidden) in [(&org_a, "ORG_B_KEY"), (&org_b, "ORG_A_KEY")] {
            let mut list = Request::builder()
                .method("GET")
                .uri(format!("/api/v1/projects/{project}/changelog?limit=200"))
                .body(Body::empty())
                .unwrap();
            for (k, v) in headers.iter() {
                list.headers_mut().insert(k, v.clone());
            }
            let res = router.clone().oneshot(list).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK);
            let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let text = json.to_string();
            assert!(!text.contains(forbidden), "{text}");
            assert_eq!(json["events"].as_array().unwrap().len(), 16);
        }
    }
}
