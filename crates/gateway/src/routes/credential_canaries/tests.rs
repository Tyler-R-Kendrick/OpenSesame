use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use crate::test_principals::P26;
use axum::{
    body::Body,
    http::{header, Request},
};
use chrono::Utc;
use opensesame_domain::OrganizationRole;
use opensesame_human_vault::credential_canaries::{ArtifactKind, Registry};
use tower::ServiceExt;
fn operator(st: &AppState) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer operator:{}", st.operator_token)
            .parse()
            .unwrap(),
    );
    headers
}
async fn send(
    app: &Router,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
    )
}
fn artifact() -> Artifact {
    let mut registry = Registry::new("personal", "operator-bound-vault");
    registry
        .create(
            ArtifactKind::ConnectionRef,
            &Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
        .unwrap();
    registry.artifacts.remove(0)
}
#[tokio::test]
async fn credential_canaries_routes_require_real_human_step_up_and_role() {
    let st = test_demo_state().await;
    let org = st.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let app = routes().with_state(st.clone());
    let payload =
        json!({"tomb":"personal","vaultIdentity":"operator-bound-vault","artifact":artifact()});
    assert_eq!(
        send(
            &app,
            &HeaderMap::new(),
            "POST",
            "/api/v1/credential-canaries/register",
            payload.clone()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let owner = test_session_headers(&st, P26, org, OrganizationRole::Owner);
    assert_eq!(
        send(
            &app,
            &owner,
            "POST",
            "/api/v1/credential-canaries/register",
            payload.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let member = test_session_headers(&st, P26, org, OrganizationRole::Member);
    assert_eq!(
        send(
            &app,
            &member,
            "POST",
            "/api/v1/credential-canaries/register",
            payload.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let op = operator(&st);
    assert_eq!(
        send(
            &app,
            &op,
            "POST",
            "/api/v1/credential-canaries/register",
            payload
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (status, body) = send(
        &app,
        &op,
        "GET",
        "/api/v1/credential-canaries/personal",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["vaultIdentity"], "operator-bound-vault");
    assert_eq!(
        send(
            &app,
            &op,
            "POST",
            "/api/v1/credential-canaries/issued/forged-ref/retire",
            json!({})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn credential_canaries_fresh_human_can_enroll_but_agent_or_browser_cannot() {
    let st = test_demo_state().await;
    let org = st.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let app = routes().with_state(st.clone());
    for kind in [
        CredentialKind::AgentCapability,
        CredentialKind::BrowserGrant,
        CredentialKind::NativeSession,
    ] {
        let token = uuid::Uuid::new_v4().to_string();
        let mut claims = crate::session_claims::fixture(
            crate::session_claims::parse_principal(P26).unwrap(),
            org,
            OrganizationRole::Owner,
            &st.resource,
        );
        claims.credential_kind = kind;
        if kind == CredentialKind::BrowserGrant {
            claims.dpop_jkt = Some("A".repeat(43));
            claims.origin = Some("https://owner.invalid".into());
        }
        claims.assurance = crate::session_claims::Assurance::PhishingResistant;
        claims.amr = vec!["webauthn".into()];
        claims.last_step_up_at = Some(Utc::now());
        st.sessions
            .lock()
            .unwrap()
            .insert(opensesame_claims::hash_secret(&token), claims);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            match kind {
                CredentialKind::AgentCapability => format!("Bearer agent-capability:{token}"),
                CredentialKind::BrowserGrant => format!("DPoP opaque-session:{token}"),
                CredentialKind::NativeSession => format!("Bearer opaque-session:{token}"),
            }
            .parse()
            .unwrap(),
        );
        if kind == CredentialKind::BrowserGrant {
            headers.insert(header::ORIGIN, "https://owner.invalid".parse().unwrap());
            headers.insert("dpop", "fixture-proof".parse().unwrap());
        }
        let status = send(
            &app,
            &headers,
            "POST",
            "/api/v1/credential-canaries/register",
            json!({"tomb":"personal","vaultIdentity":"operator-bound-vault","artifact":artifact()}),
        )
        .await
        .0;
        assert_eq!(
            status,
            if kind == CredentialKind::NativeSession {
                StatusCode::CREATED
            } else {
                StatusCode::FORBIDDEN
            }
        );
    }
}

async fn actual_connection_with_credential(
    st: &AppState,
) -> (OrganizationId, ConnectionId, String) {
    let org = st.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let id = ConnectionId::new();
    let target = id.to_string();
    let at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query("INSERT INTO connections(id,organization_id,provider_id,logical_name,display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at) VALUES(?,?,? ,?,'revocation-target','active','[]','[]','human','private',1,'{}',?,?)").bind(&target).bind(org.to_string()).bind("test-only").bind(format!("target-{}",id.as_uuid())).bind(&at).bind(&at).execute(st.db.pool()).await.unwrap();
    sqlx::query("INSERT INTO connection_credentials(connection_id,ciphertext,nonce,aad_digest,token_type,refreshable,created_at,updated_at) VALUES(?,X'0102',X'03','test-only','bearer',0,?,?)").bind(&target).bind(&at).bind(&at).execute(st.db.pool()).await.unwrap();
    (org, id, target)
}
async fn assert_actual_withdrawal(st: &AppState, target: &str) {
    let status: String = sqlx::query_scalar("SELECT status FROM connections WHERE id=?")
        .bind(target)
        .fetch_one(st.db.pool())
        .await
        .unwrap();
    assert_eq!(status, "revoked");
    let credentials: i64 =
        sqlx::query_scalar("SELECT count(*) FROM connection_credentials WHERE connection_id=?")
            .bind(target)
            .fetch_one(st.db.pool())
            .await
            .unwrap();
    assert_eq!(credentials, 0);
}
#[tokio::test]
async fn credential_canaries_actual_revocation_survives_corrupt_detection_metadata() {
    let st = test_demo_state().await;
    let (org, id, target) = actual_connection_with_credential(&st).await;
    let binding = HostCanaryBinding {
        organization_id: org,
        tomb: "personal".into(),
        vault_identity: "operator-bound-vault".into(),
    };
    st.db
        .register_controlled_canary(&binding, &artifact())
        .await
        .unwrap();
    let alias = st
        .db
        .issue_controlled_alias(
            &org,
            "personal",
            &id,
            &(Utc::now() + chrono::Duration::minutes(1)).to_rfc3339(),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE host_canary_registries SET registry_json='{}' WHERE organization_id=?")
        .bind(org.to_string())
        .execute(st.db.pool())
        .await
        .unwrap();
    opensesame_connection_broker::store::revoke_local(st.connection_broker.pool(), &target)
        .await
        .unwrap();
    assert_actual_withdrawal(&st, &target).await;
    let retired: Option<String> =
        sqlx::query_scalar("SELECT retired_at FROM host_controlled_aliases WHERE id=?")
            .bind(&alias.issuer_record_ref)
            .fetch_one(st.db.pool())
            .await
            .unwrap();
    assert!(retired.is_some());
    assert!(st
        .db
        .classify_controlled_reference(&org, &alias.reference)
        .await
        .is_err());
}
#[tokio::test]
async fn credential_canaries_legacy_pool_preserves_actual_connection_revocation() {
    let st = test_demo_state().await;
    let (_, _, target) = actual_connection_with_credential(&st).await;
    sqlx::query("DROP TABLE host_controlled_aliases")
        .execute(st.db.pool())
        .await
        .unwrap();
    sqlx::query("DROP TABLE host_canary_registries")
        .execute(st.db.pool())
        .await
        .unwrap();
    opensesame_connection_broker::store::revoke_local(st.connection_broker.pool(), &target)
        .await
        .unwrap();
    assert_actual_withdrawal(&st, &target).await;
}
