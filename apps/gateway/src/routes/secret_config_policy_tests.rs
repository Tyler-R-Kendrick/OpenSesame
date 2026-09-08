//! HTTP oracles for durable metadata policy; no direct broker permission bypass.
use crate::app_state::{test_demo_state, test_session_headers, AppState};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

struct Fixture {
    app: Router,
    state: AppState,
    organization: OrganizationId,
    owner: HeaderMap,
    admin: HeaderMap,
    member: HeaderMap,
    member_id: PrincipalId,
    admin_id: PrincipalId,
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
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

fn operator(state: &AppState, organization: Option<OrganizationId>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    if let Some(org) = organization {
        headers.insert(
            "x-opensesame-organization",
            org.to_string().parse().unwrap(),
        );
    }
    headers
}

async fn role(
    f: &Fixture,
    principal: PrincipalId,
    role: Value,
    revision: u64,
) -> (StatusCode, Value) {
    request(
        &f.app,
        &operator(&f.state, Some(f.organization)),
        "PUT",
        &format!(
            "/api/v1/organizations/{}/config-members/{principal}",
            f.organization
        ),
        Some(json!({"role":role,"expected_revision":revision})),
    )
    .await
}

async fn fixture() -> Fixture {
    let mut state = test_demo_state().await;
    state.connection_broker = Arc::new(
        ConnectionBroker::new(
            state.db.pool().clone(),
            BrokerConfig::in_memory(Some([42; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    let organization = OrganizationId::new();
    let owner_id = PrincipalId::new();
    let admin_id = PrincipalId::new();
    let member_id = PrincipalId::new();
    let f = Fixture {
        app: crate::routes::router(state.clone()),
        owner: test_session_headers(
            &state,
            &owner_id.to_string(),
            organization,
            OrganizationRole::Owner,
        ),
        admin: test_session_headers(
            &state,
            &admin_id.to_string(),
            organization,
            OrganizationRole::Admin,
        ),
        member: test_session_headers(
            &state,
            &member_id.to_string(),
            organization,
            OrganizationRole::Member,
        ),
        state,
        organization,
        member_id,
        admin_id,
    };
    for (id, name) in [
        (owner_id, "owner"),
        (admin_id, "admin"),
        (member_id, "member"),
    ] {
        assert_eq!(role(&f, id, json!(name), 0).await.0, StatusCode::OK);
    }
    f
}

async fn create(f: &Fixture, headers: &HeaderMap, project: &str, slug: &str) -> String {
    let (status, body) = request(
        &f.app,
        headers,
        "POST",
        &format!("/api/v1/projects/{project}/configs"),
        Some(json!({"slug":slug,"environment":"development"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_str().unwrap().to_owned()
}

async fn grant(
    f: &Fixture,
    actor: &HeaderMap,
    project: &str,
    metadata: bool,
    keys: bool,
) -> StatusCode {
    request(
        &f.app,
        actor,
        "PUT",
        &format!("/api/v1/projects/{project}/config-access/{}", f.member_id),
        Some(json!({"metadata_read":metadata,"keys_read":keys})),
    )
    .await
    .0
}

async fn hidden(f: &Fixture, headers: &HeaderMap, path: &str) {
    let (status, body) = request(&f.app, headers, "GET", path, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {body}");
    assert_eq!(body, json!({"error":"not_found"}));
}

#[tokio::test]
async fn metadata_and_keys_are_independent_across_projects_and_organizations() {
    let f = fixture().await;
    let a = create(&f, &f.owner, "project-a", "owner-created").await;
    let b = create(&f, &f.admin, "project-b", "admin-created").await;
    assert_eq!(
        grant(&f, &f.owner, "project-a", true, false).await,
        StatusCode::NO_CONTENT
    );
    let (status, caps) = request(
        &f.app,
        &f.member,
        "GET",
        "/api/v1/projects/project-a/config-access",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(caps["capabilities"], json!(["config.metadata.read"]));
    assert_eq!(
        request(
            &f.app,
            &f.member,
            "GET",
            &format!("/api/v1/configs/{a}"),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    for path in [
        format!("/api/v1/configs/{a}/secrets"),
        format!("/api/v1/configs/{b}"),
        "/api/v1/projects/project-b/configs".into(),
        "/api/v1/configs/absent".into(),
    ] {
        hidden(&f, &f.member, &path).await;
    }
    let foreign = OrganizationId::new();
    let foreign_config = create(
        &f,
        &operator(&f.state, Some(foreign)),
        "project-a",
        "foreign",
    )
    .await;
    hidden(&f, &f.owner, &format!("/api/v1/configs/{foreign_config}")).await;
    let foreign_member = test_session_headers(
        &f.state,
        &f.member_id.to_string(),
        foreign,
        OrganizationRole::Member,
    );
    hidden(&f, &foreign_member, &format!("/api/v1/configs/{a}")).await;
    let (_, listed) = request(
        &f.app,
        &f.member,
        "GET",
        "/api/v1/projects/project-a/configs",
        None,
    )
    .await;
    assert!(!listed.to_string().contains(&foreign_config));
    assert_eq!(
        grant(&f, &f.member, "project-b", true, true).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn comparison_versions_and_changelog_repeat_the_key_permission_check() {
    let f = fixture().await;
    let a = create(&f, &f.owner, "project-a", "a").await;
    let b = create(&f, &f.owner, "project-b", "b").await;
    let write = request(
        &f.app,
        &f.owner,
        "PUT",
        &format!("/api/v1/configs/{a}/secrets"),
        Some(json!({"secrets":{"POLICY_TEST_KEY":"test-value-not-returned"}})),
    )
    .await;
    assert_eq!(write.0, StatusCode::OK);
    assert_eq!(
        grant(&f, &f.admin, "project-a", true, false).await,
        StatusCode::NO_CONTENT
    );
    let paths = [
        format!("/api/v1/configs/{a}/secrets/POLICY_TEST_KEY/versions"),
        format!("/api/v1/configs/{a}/compare/{a}"),
        "/api/v1/projects/project-a/changelog".into(),
    ];
    for path in &paths {
        hidden(&f, &f.member, path).await;
    }
    assert_eq!(
        grant(&f, &f.admin, "project-a", true, true).await,
        StatusCode::NO_CONTENT
    );
    for path in &paths {
        let (status, body) = request(&f.app, &f.member, "GET", path, None).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(!body.to_string().contains("test-value-not-returned"));
    }
    hidden(&f, &f.member, &format!("/api/v1/configs/{a}/compare/{b}")).await;
    hidden(&f, &f.member, &format!("/api/v1/configs/{b}/compare/{a}")).await;
    assert_eq!(
        request(
            &f.app,
            &f.member,
            "POST",
            "/api/v1/changelog",
            Some(json!({"event_type":"secret.value.changed","project_id":"project-a"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        grant(&f, &f.owner, "project-a", false, false).await,
        StatusCode::NO_CONTENT
    );
    for path in &paths {
        hidden(&f, &f.member, path).await;
    }
}

#[tokio::test]
async fn cached_admin_session_cannot_survive_downgrade_or_restore_its_ceiling() {
    let f = fixture().await;
    let config = create(&f, &f.admin, "project-a", "before-downgrade").await;
    assert_eq!(
        role(&f, f.admin_id, json!("member"), 1).await.0,
        StatusCode::OK
    );
    hidden(&f, &f.admin, &format!("/api/v1/configs/{config}")).await;
    assert_eq!(
        grant(&f, &f.admin, "project-a", true, true).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        role(&f, f.admin_id, json!("admin"), 1).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &f.app,
            &f.admin,
            "PUT",
            &format!(
                "/api/v1/organizations/{}/config-members/{}",
                f.organization, f.admin_id
            ),
            Some(json!({"role":"admin","expected_revision":2}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        grant(&f, &f.owner, "project-a", true, true).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        role(&f, f.member_id, Value::Null, 1).await.0,
        StatusCode::OK
    );
    hidden(&f, &f.member, &format!("/api/v1/configs/{config}")).await;
    assert_eq!(
        role(&f, f.member_id, json!("member"), 2).await.0,
        StatusCode::OK
    );
    hidden(&f, &f.member, &format!("/api/v1/configs/{config}")).await;
}

#[tokio::test]
async fn operator_selection_is_mandatory_and_sessions_cannot_switch_tenants() {
    let f = fixture().await;
    let config = create(&f, &f.owner, "project-a", "selected").await;
    let path = format!("/api/v1/configs/{config}");
    let (status, body) = request(&f.app, &operator(&f.state, None), "GET", &path, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error":"organization_selection_required"}));
    assert_eq!(
        request(
            &f.app,
            &operator(&f.state, Some(f.organization)),
            "GET",
            &path,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    hidden(&f, &operator(&f.state, Some(OrganizationId::new())), &path).await;
    let mut switched = f.owner.clone();
    switched.insert(
        "x-opensesame-organization",
        f.organization.to_string().parse().unwrap(),
    );
    hidden(&f, &switched, &path).await;
    let mut invalid = operator(&f.state, None);
    invalid.insert(
        "x-opensesame-organization",
        "not-an-organization".parse().unwrap(),
    );
    assert_eq!(
        request(&f.app, &invalid, "GET", &path, None).await.0,
        StatusCode::BAD_REQUEST
    );
}
