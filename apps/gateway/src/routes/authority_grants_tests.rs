//! HTTP oracles for generalized authority issue (ADR 0120).

use crate::app_state::{test_demo_state, test_session_headers, AppState};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use serde_json::{json, Value};
use tower::ServiceExt;

struct Fixture {
    app: Router,
    organization: OrganizationId,
    owner: HeaderMap,
    domain_id: String,
}

async fn request(
    app: &Router,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    *builder.headers_mut().unwrap() = headers.clone();
    let body = body.map_or_else(Body::empty, |body| {
        builder
            .headers_mut()
            .unwrap()
            .insert("content-type", "application/json".parse().unwrap());
        Body::from(body.to_string())
    });
    let response = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

async fn fixture() -> Fixture {
    let state = test_demo_state().await;
    let organization = OrganizationId::new();
    state
        .db
        .create_organization(&organization, "realm-issue")
        .await
        .unwrap();
    let domain_id = format!("adom:{}", organization);
    assert!(state
        .db
        .create_access_domain(&opensesame_storage::authority::NewAccessDomain {
            id: &domain_id,
            organization_id: &organization.to_string(),
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap());
    let owner_id = PrincipalId::new();
    Fixture {
        app: crate::routes::router(state.clone()),
        owner: test_session_headers(
            &state,
            &owner_id.to_string(),
            organization,
            OrganizationRole::Owner,
        ),
        organization,
        domain_id,
    }
}

async fn seed_grant(state: &AppState, organization_id: &str, grant_id: &str) {
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(grant_id)
    .bind(organization_id)
    .bind(
        json!({
            "id": grant_id,
            "actions": ["read"],
            "resources": ["connection:alpha"],
            "connection_id": "connection:alpha",
            "parent_grant_id": Value::Null,
            "delegation_depth": 0,
            "created_at": (Utc::now() - Duration::hours(1)).to_rfc3339(),
            "expires_at": (Utc::now() + Duration::hours(24)).to_rfc3339(),
        })
        .to_string(),
    )
    .bind(Utc::now().to_rfc3339())
    .execute(state.db.pool())
    .await
    .unwrap();
}

fn issue_body(domain_id: &str) -> Value {
    json!({
        "domain_id": domain_id,
        "issuance_basis": "root",
        "lineage_digest": "digest:lineage",
        "policy_digest": "digest:policy",
        "delegation_depth_remaining": 1,
        "not_before": (Utc::now() - Duration::minutes(1)).to_rfc3339(),
        "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
        "entries": [{
            "resource_selector": "resource:A",
            "provider_operation_id": "connection.invoke:connection:alpha",
            "action_set": ["read"],
            "parameter_constraints": {"method": ["GET"]},
            "audience_set": ["https://provider.example"],
            "manifest_digest": "digest:manifest"
        }]
    })
}

#[tokio::test]
async fn issue_writes_authority_and_members_are_forbidden() {
    let state = test_demo_state().await;
    let organization = OrganizationId::new();
    state
        .db
        .create_organization(&organization, "realm-issue-2")
        .await
        .unwrap();
    let domain_id = format!("adom:{}", organization);
    assert!(state
        .db
        .create_access_domain(&opensesame_storage::authority::NewAccessDomain {
            id: &domain_id,
            organization_id: &organization.to_string(),
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap());
    let grant_id = "grant:root";
    seed_grant(&state, &organization.to_string(), grant_id).await;
    let owner_id = PrincipalId::new();
    let member_id = PrincipalId::new();
    let owner = test_session_headers(
        &state,
        &owner_id.to_string(),
        organization,
        OrganizationRole::Owner,
    );
    let member = test_session_headers(
        &state,
        &member_id.to_string(),
        organization,
        OrganizationRole::Member,
    );
    let app = crate::routes::router(state.clone());
    let path = format!("/api/v1/organizations/{organization}/grants/{grant_id}/authority");

    let (status, body) = request(&app, &member, "POST", &path, Some(issue_body(&domain_id))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let (status, body) = request(&app, &owner, "POST", &path, Some(issue_body(&domain_id))).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["status"], "issued");
    assert_eq!(body["grant_id"], grant_id);

    let fenced = state
        .db
        .fenced_authority(&organization.to_string(), grant_id, Utc::now())
        .await
        .unwrap();
    assert!(fenced.is_some(), "issued authority must pass the fence");
}

#[tokio::test]
async fn missing_grant_is_refused() {
    let f = fixture().await;
    let path = format!(
        "/api/v1/organizations/{}/grants/grant:missing/authority",
        f.organization
    );
    let (status, body) = request(
        &f.app,
        &f.owner,
        "POST",
        &path,
        Some(issue_body(&f.domain_id)),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

#[tokio::test]
async fn unsupported_platform_is_refused_and_writes_nothing() {
    let state = test_demo_state().await;
    let organization = OrganizationId::new();
    state
        .db
        .create_organization(&organization, "realm-issue-ios")
        .await
        .unwrap();
    let domain_id = format!("adom:{organization}");
    assert!(state
        .db
        .create_access_domain(&opensesame_storage::authority::NewAccessDomain {
            id: &domain_id,
            organization_id: &organization.to_string(),
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap());
    let grant_id = "grant:root";
    seed_grant(&state, &organization.to_string(), grant_id).await;
    let owner = test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        organization,
        OrganizationRole::Owner,
    );
    let app = crate::routes::router(state.clone());
    let path = format!("/api/v1/organizations/{organization}/grants/{grant_id}/authority");
    for platform in ["apple-ios", "discord-live", "blocky-live-saas"] {
        let mut body = issue_body(&domain_id);
        body["enforcement_platform"] = serde_json::json!(platform);
        let (status, resp) = request(&app, &owner, "POST", &path, Some(body)).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{platform} {resp}"
        );
        assert_eq!(resp["error"], "enforcement_refused", "{platform}");
        assert_eq!(resp["platform"], platform);
        assert!(
            state
                .db
                .fenced_authority(&organization.to_string(), grant_id, Utc::now())
                .await
                .unwrap()
                .is_none(),
            "{platform} must not mint a sidecar"
        );
    }
}

#[tokio::test]
async fn at_control_role_admin_cannot_issue_export_or_policy_edit() {
    let state = test_demo_state().await;
    let organization = OrganizationId::new();
    state
        .db
        .create_organization(&organization, "realm-control-role")
        .await
        .unwrap();
    let domain_id = format!("adom:{organization}");
    assert!(state
        .db
        .create_access_domain(&opensesame_storage::authority::NewAccessDomain {
            id: &domain_id,
            organization_id: &organization.to_string(),
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap());
    let admin = test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        organization,
        OrganizationRole::Admin,
    );
    let owner = test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        organization,
        OrganizationRole::Owner,
    );
    let app = crate::routes::router(state.clone());
    seed_grant(&state, &organization.to_string(), "grant:ordinary").await;
    let ordinary = format!("/api/v1/organizations/{organization}/grants/grant:ordinary/authority");
    let (status, body) = request(
        &app,
        &admin,
        "POST",
        &ordinary,
        Some(issue_body(&domain_id)),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "admin may issue ordinary use {body}"
    );

    for reserved in ["credential.export", "policy.edit"] {
        let grant_id = format!("grant:{}", reserved.replace('.', "-"));
        seed_grant(&state, &organization.to_string(), &grant_id).await;
        let path = format!("/api/v1/organizations/{organization}/grants/{grant_id}/authority");
        let mut body = issue_body(&domain_id);
        body["entries"][0]["action_set"] = json!([reserved]);
        let (status, resp) = request(&app, &admin, "POST", &path, Some(body.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{reserved} {resp}");
        assert_eq!(resp["error"], "forbidden");
        assert!(
            resp["hint"]
                .as_str()
                .unwrap_or("")
                .contains("higher-scope issuance"),
            "{reserved} {resp}"
        );
        let (status, resp) = request(&app, &owner, "POST", &path, Some(body)).await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "owner is higher-scope issuance for {reserved}: {resp}"
        );
    }
}

#[tokio::test]
async fn depth_above_ceiling_is_bad_request() {
    let f = fixture().await;
    let path = format!(
        "/api/v1/organizations/{}/grants/grant:root/authority",
        f.organization
    );
    let mut body = issue_body(&f.domain_id);
    body["delegation_depth_remaining"] = serde_json::json!(9);
    let (status, resp) = request(&f.app, &f.owner, "POST", &path, Some(body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{resp}");
}
