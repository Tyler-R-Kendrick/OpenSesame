//! Full-router tests: real `DPoP` proof, durable browser grant and metadata policy.
use super::*;
use opensesame_connection_broker::{
    config_access, BrokerConfig, ConnectionBroker, CreateSecretConfig,
};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use opensesame_storage::host_authorizations::HostAuthorization;
use serde_json::{json, Value};
use std::sync::Arc;

const ORIGIN: &str = "https://paired.example";

struct OriginEnvironment(Option<String>);
impl Drop for OriginEnvironment {
    fn drop(&mut self) {
        if let Some(previous) = &self.0 {
            std::env::set_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS", previous);
        } else {
            std::env::remove_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS");
        }
    }
}

struct Client {
    jwk: opensesame_proof::DpopPublicJwk,
    key: opensesame_proof::ProofSigningKey,
    token: String,
    resource: String,
}

impl Client {
    async fn get(&self, app: &Router, path: &str) -> (StatusCode, Value) {
        self.request(app, "GET", path, Value::Null).await
    }

    async fn request(
        &self,
        app: &Router,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let proof = opensesame_proof::sign_dpop_proof(
            &self.jwk,
            &self.key,
            &opensesame_proof::DpopClaims {
                jti: uuid::Uuid::new_v4().to_string(),
                htm: method.into(),
                htu: format!("{}{path}", self.resource),
                iat: chrono::Utc::now().timestamp(),
                ath: Some(opensesame_proof::access_token_hash(&self.token)),
            },
        )
        .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::AUTHORIZATION, format!("DPoP {}", self.token))
                    .header("dpop", proof)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(if body.is_null() {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
}

#[path = "browser_pam_tests.rs"]
mod pam;

#[tokio::test]
async fn paired_metadata_requires_verified_identity_and_current_project_permissions() {
    let mut state = crate::app_state::test_demo_state().await;
    state.connection_broker = Arc::new(
        ConnectionBroker::new(
            state.db.pool().clone(),
            BrokerConfig::in_memory(Some([42; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    let _lock = crate::app_state::test_env::lock();
    let _restore = OriginEnvironment(std::env::var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS").ok());
    std::env::set_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS", ORIGIN);
    let PairedFixture {
        client,
        principal,
        org,
        client_id,
        now,
    } = paired_fixture(&state).await;
    config_access::provision_native_role(
        state.db.pool(),
        &org,
        &principal,
        OrganizationRole::Member,
    )
    .await
    .unwrap();
    set_access(&state, &org, &principal, true, false).await;
    let config = state
        .connection_broker
        .create_secret_config(
            &org.to_string(),
            CreateSecretConfig {
                project_id: "project-a".into(),
                slug: "development".into(),
                display_name: None,
                environment: "development".into(),
                parent_config_id: None,
            },
            None,
        )
        .await
        .unwrap();
    let app = crate::routes::router(state.clone());
    let metadata = format!("/api/v1/configs/{}", config.id);
    assert_eq!(
        client.get(&app, &metadata).await.0,
        StatusCode::UNAUTHORIZED
    );

    // Explicit fixture of the cryptographically verified Identity handoff;
    // the native/local grant above remains unverified until this transaction.
    authenticate_fixture(&state, &client_id, now).await;
    assert_eq!(client.get(&app, &metadata).await.0, StatusCode::OK);
    let (status, policy) = client
        .get(&app, "/api/v1/projects/project-a/config-access")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(policy["capabilities"], json!(["config.metadata.read"]));
    assert_eq!(
        client.get(&app, &format!("{metadata}/secrets")).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(&app, "/api/v1/projects/project-a/changelog")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(&app, "/api/v1/projects/project-b/configs")
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    set_access(&state, &org, &principal, true, true).await;
    assert_eq!(
        client.get(&app, &format!("{metadata}/secrets")).await.0,
        StatusCode::OK
    );
    set_access(&state, &org, &principal, false, false).await;
    assert_eq!(client.get(&app, &metadata).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        client.get(&app, &format!("{metadata}/secrets")).await.0,
        StatusCode::NOT_FOUND
    );
    assert!(state
        .db
        .revoke_browser_client(&client_id, &principal.to_string(), &org.to_string(), now)
        .await
        .unwrap());
    assert_eq!(
        client.get(&app, &metadata).await.0,
        StatusCode::UNAUTHORIZED
    );
}

struct PairedFixture {
    client: Client,
    principal: PrincipalId,
    org: OrganizationId,
    client_id: String,
    now: i64,
}

async fn paired_fixture(state: &crate::app_state::AppState) -> PairedFixture {
    let (jwk, key) = proof_key();
    let jkt = opensesame_proof::jwk_thumbprint(&jwk).unwrap();
    let now = chrono::Utc::now().timestamp();
    let raw = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let principal = PrincipalId::new();
    let org = OrganizationId::new();
    let client_id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .create_browser_pairing(&NewBrowserPairing {
            id: &client_id,
            device_digest: "device",
            user_code_digest: "code",
            origin: ORIGIN,
            dpop_jkt: &jkt,
            audience: &state.resource,
            capabilities_json: "[\"host.sync.read\"]",
            now,
        })
        .await
        .unwrap();
    state
        .db
        .decide_browser_pairing("code", &principal.to_string(), &org.to_string(), true, now)
        .await
        .unwrap();
    state
        .db
        .consume_browser_pairing("device", ORIGIN, &jkt, &hash_secret(&raw), now)
        .await
        .unwrap()
        .unwrap();
    let client = Client {
        jwk,
        key,
        token: format!("opaque-session:{raw}"),
        resource: state.resource.clone(),
    };
    PairedFixture {
        client,
        principal,
        org,
        client_id,
        now,
    }
}

async fn authenticate_fixture(state: &crate::app_state::AppState, client_id: &str, now: i64) {
    let pending = HostAuthorization {
        id: uuid::Uuid::new_v4().to_string(),
        client_id: client_id.to_owned(),
        digest: "authenticated-browser-metadata".into(),
        operation: "browser.authenticate".into(),
        target_id: client_id.to_owned(),
        transition: None,
        run_version: None,
        expires_at: now + 240,
    };
    assert!(state
        .db
        .create_host_authorization(&pending, now)
        .await
        .unwrap());
    assert!(state
        .db
        .authorize_host_challenge(
            &pending,
            "metadata-evidence-jti",
            Some(&json!({"role":"member","auth_time":now}).to_string()),
            None,
            now
        )
        .await
        .unwrap());
}

async fn set_access(
    state: &crate::app_state::AppState,
    org: &OrganizationId,
    principal: &PrincipalId,
    metadata_read: bool,
    keys_read: bool,
) {
    config_access::set_project_access(
        state.db.pool(),
        org,
        &config_access::PolicyActor::Operator,
        "project-a",
        principal,
        config_access::ProjectAccess {
            metadata_read,
            keys_read,
        },
    )
    .await
    .unwrap();
}
