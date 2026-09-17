//! HTTP oracles for access-domain forest routes (ADR 0120).

use crate::app_state::{test_demo_state, test_session_headers, AppState};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use opensesame_storage::authority::{AuthorityIssue, PermissionEntry};
use serde_json::{json, Value};
use tower::ServiceExt;

struct Fixture {
    app: Router,
    state: AppState,
    organization: OrganizationId,
    other: OrganizationId,
    owner: HeaderMap,
    member: HeaderMap,
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

fn operator_headers(state: &AppState, organization: OrganizationId) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    headers.insert(
        "x-opensesame-organization",
        organization.to_string().parse().unwrap(),
    );
    headers
}

async fn fixture() -> Fixture {
    let state = test_demo_state().await;
    let organization = OrganizationId::new();
    let other = OrganizationId::new();
    state
        .db
        .create_organization(&organization, "realm-a")
        .await
        .unwrap();
    state
        .db
        .create_organization(&other, "realm-b")
        .await
        .unwrap();
    let owner_id = PrincipalId::new();
    let member_id = PrincipalId::new();
    Fixture {
        app: crate::routes::router(state.clone()),
        owner: test_session_headers(
            &state,
            &owner_id.to_string(),
            organization,
            OrganizationRole::Owner,
        ),
        member: test_session_headers(
            &state,
            &member_id.to_string(),
            organization,
            OrganizationRole::Member,
        ),
        state,
        organization,
        other,
    }
}

fn path(org: OrganizationId, suffix: &str) -> String {
    format!("/api/v1/organizations/{org}/access-domains{suffix}")
}

async fn seed_grant(db: &opensesame_storage::Db, organization_id: &str, grant_id: &str) {
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
    .execute(db.pool())
    .await
    .unwrap();
}

#[tokio::test]
async fn create_forest_lists_and_reads_domains() {
    let f = fixture().await;
    let org = f.organization;
    let (status, root) = request(
        &f.app,
        &f.owner,
        "POST",
        &path(org, ""),
        Some(json!({"id": "adom:root"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{root}");
    assert_eq!(root["id"], "adom:root");
    assert_eq!(root["depth"], 0);

    let (status, child) = request(
        &f.app,
        &f.owner,
        "POST",
        &path(org, ""),
        Some(json!({"id": "adom:child", "parent_id": "adom:root"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    assert_eq!(child["parent_id"], "adom:root");
    assert_eq!(child["depth"], 1);

    let (status, listed) = request(&f.app, &f.owner, "GET", &path(org, ""), None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["items"].as_array().unwrap().len(), 2);

    let (status, got) = request(&f.app, &f.owner, "GET", &path(org, "/adom:child"), None).await;
    assert_eq!(status, StatusCode::OK, "{got}");
    assert_eq!(got["id"], "adom:child");
}

#[tokio::test]
async fn refuse_cross_realm_parent_and_path_mismatch() {
    let f = fixture().await;
    let (status, _) = request(
        &f.app,
        &operator_headers(&f.state, f.organization),
        "POST",
        &path(f.organization, ""),
        Some(json!({"id": "adom:one"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Parent exists in another realm — storage refuses; route surfaces 422.
    let other_op = operator_headers(&f.state, f.other);
    let (status, body) = request(
        &f.app,
        &other_op,
        "POST",
        &path(f.other, ""),
        Some(json!({"id": "adom:crossed", "parent_id": "adom:one"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], "refused");

    // Session for org A cannot address org B's path.
    let (status, body) = request(
        &f.app,
        &f.owner,
        "POST",
        &path(f.other, ""),
        Some(json!({"id": "adom:sneak"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    let (status, body) = request(
        &f.app,
        &f.member,
        "POST",
        &path(f.organization, ""),
        Some(json!({"id": "adom:member"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}

#[tokio::test]
async fn terminate_fences_descendant_authority() {
    let f = fixture().await;
    let org = f.organization.to_string();
    let (status, root) = request(
        &f.app,
        &f.owner,
        "POST",
        &path(f.organization, ""),
        Some(json!({"id": "adom:platform"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{root}");
    let (status, child) = request(
        &f.app,
        &f.owner,
        "POST",
        &path(f.organization, ""),
        Some(json!({"id": "adom:prod", "parent_id": "adom:platform"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{child}");

    seed_grant(&f.state.db, &org, "grant:prod").await;
    let issued = f
        .state
        .db
        .issue_authority(
            &AuthorityIssue {
                grant_id: "grant:prod",
                organization_id: &org,
                domain_id: "adom:prod",
                parent_grant_id: None,
                issuance_basis: "root",
                lineage_digest: "digest:lineage",
                policy_digest: "digest:policy",
                role_revision: None,
                offer_id: None,
                delegation_depth_remaining: 0,
                not_before: Utc::now() - Duration::minutes(1),
                expires_at: Utc::now() + Duration::hours(1),
                evidence_id: None,
            },
            &[PermissionEntry {
                resource_selector: "resource:A".into(),
                provider_operation_id: "connection.invoke:connection:alpha".into(),
                action_set_json: "[\"read\"]".into(),
                parameter_constraints_json: "{}".into(),
                audience_set_json: "[]".into(),
                manifest_digest: "digest:manifest".into(),
            }],
        )
        .await
        .unwrap();
    assert!(issued);
    assert!(f
        .state
        .db
        .fenced_authority(&org, "grant:prod", Utc::now())
        .await
        .unwrap()
        .is_some());

    let (status, terminated) = request(
        &f.app,
        &f.owner,
        "POST",
        &path(f.organization, "/adom:platform/terminate"),
        Some(json!({"expected_revision": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{terminated}");
    assert_eq!(terminated["lifecycle"], "terminated");

    assert!(
        f.state
            .db
            .fenced_authority(&org, "grant:prod", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "terminating an ancestor must fence descendant authority immediately"
    );
}
