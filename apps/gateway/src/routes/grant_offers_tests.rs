//! HTTP oracles for grant-offer activate/revoke.

use crate::app_state::{test_demo_state, test_session_headers};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use opensesame_storage::authority::{AuthorityIssue, NewGrantOffer, PermissionEntry};
use serde_json::{json, Value};
use tower::ServiceExt;

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
async fn grant_offer_activate_and_revoke() {
    let state = test_demo_state().await;
    let organization = OrganizationId::new();
    state
        .db
        .create_organization(&organization, "realm-offers")
        .await
        .unwrap();
    let owner_id = PrincipalId::new();
    let owner = test_session_headers(
        &state,
        &owner_id.to_string(),
        organization,
        OrganizationRole::Owner,
    );
    let app = crate::routes::router(state.clone());
    let org = organization.to_string();

    let (status, _) = request(
        &app,
        &owner,
        "POST",
        &format!("/api/v1/organizations/{organization}/access-domains"),
        Some(json!({"id": "adom:offer-home"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    seed_grant(&state.db, &org, "grant:envelope").await;
    seed_grant(&state.db, &org, "grant:person").await;
    let entry = || PermissionEntry {
        resource_selector: "resource:A".into(),
        provider_operation_id: "connection.invoke:connection:alpha".into(),
        action_set_json: "[\"read\"]".into(),
        parameter_constraints_json: "{}".into(),
        audience_set_json: "[]".into(),
        manifest_digest: "digest:manifest".into(),
    };
    let envelope_issue = AuthorityIssue {
        grant_id: "grant:envelope",
        organization_id: &org,
        domain_id: "adom:offer-home",
        parent_grant_id: None,
        issuance_basis: "root",
        lineage_digest: "digest:lineage",
        policy_digest: "digest:policy",
        role_revision: None,
        offer_id: None,
        delegation_depth_remaining: 1,
        not_before: Utc::now() - Duration::minutes(1),
        expires_at: Utc::now() + Duration::hours(1),
        evidence_id: None,
    };
    assert!(state
        .db
        .issue_authority(&envelope_issue, &[entry()])
        .await
        .unwrap());
    let person_issue = AuthorityIssue {
        grant_id: "grant:person",
        organization_id: &org,
        domain_id: "adom:offer-home",
        parent_grant_id: Some("grant:envelope"),
        issuance_basis: "delegation",
        lineage_digest: "digest:lineage",
        policy_digest: "digest:policy",
        role_revision: None,
        offer_id: None,
        delegation_depth_remaining: 0,
        not_before: envelope_issue.not_before + Duration::seconds(1),
        expires_at: envelope_issue.expires_at - Duration::seconds(1),
        evidence_id: None,
    };
    assert!(state
        .db
        .issue_authority(&person_issue, &[entry()])
        .await
        .unwrap());
    assert!(state
        .db
        .create_grant_offer(&NewGrantOffer {
            id: "offer:one",
            organization_id: &org,
            domain_id: "adom:offer-home",
            cohort_id: "cohort:raid",
            cohort_revision: 3,
            membership_binding: "snapshot",
            roster_digest: Some("sha256:reviewed-roster"),
            trusted_writer: None,
            permitted_principal_class: None,
            envelope_grant_id: "grant:envelope",
            max_activations: 2,
        })
        .await
        .unwrap());

    let activate = format!("/api/v1/organizations/{organization}/grant-offers/offer:one/activate");
    let (status, body) = request(
        &app,
        &owner,
        "POST",
        &activate,
        Some(json!({
            "beneficiary_principal_id": "principal:alice",
            "grant_id": "grant:person",
            "cohort_revision": 3,
            "membership_source": "directory",
            "membership_issuer": "identity",
            "idempotency_key": "claim:1"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "bound");

    let (status, _) = request(
        &app,
        &owner,
        "POST",
        &format!("/api/v1/organizations/{organization}/grant-offers/offer:one/revoke"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = request(
        &app,
        &owner,
        "POST",
        &activate,
        Some(json!({
            "beneficiary_principal_id": "principal:bob",
            "grant_id": "grant:person",
            "cohort_revision": 3,
            "membership_source": "directory",
            "membership_issuer": "identity",
            "idempotency_key": "claim:2"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}
