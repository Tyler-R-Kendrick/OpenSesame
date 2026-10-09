use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use opensesame_claims::hash_secret;
use opensesame_storage::{
    browser_pairing::NewBrowserPairing, host_authorizations::HostAuthorization,
};
use rand::RngCore;

const ORIGIN: &str = "https://control-tests.example";

pub(in crate::routes::agent_runs) struct Browser {
    pub(in crate::routes::agent_runs) client_id: String,
    token: String,
    jwk: opensesame_proof::DpopPublicJwk,
    key: opensesame_proof::ProofSigningKey,
    resource: String,
}

fn secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

impl Browser {
    pub(in crate::routes::agent_runs) async fn paired(state: &AppState, principal: &str) -> Self {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let public = key.public_key_raw();
        let jwk = serde_json::from_value(json!({"kty":"EC","crv":"P-256",
            "x":URL_SAFE_NO_PAD.encode(&public[1..33]),"y":URL_SAFE_NO_PAD.encode(&public[33..65])})).unwrap();
        let jkt = opensesame_proof::jwk_thumbprint(&jwk).unwrap();
        let client_id = uuid::Uuid::new_v4().to_string();
        let device = secret();
        let code = secret();
        let raw = secret();
        let now = Utc::now().timestamp();
        opensesame_connection_broker::config_access::provision_native_role(
            state.db.pool(),
            &state.connection_organization,
            &crate::session_claims::parse_principal(principal).unwrap(),
            OrganizationRole::Owner,
        )
        .await
        .unwrap();
        state
            .db
            .create_browser_pairing(&NewBrowserPairing {
                id: &client_id,
                device_digest: &hash_secret(&device),
                user_code_digest: &hash_secret(&code),
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
            .decide_browser_pairing(
                &hash_secret(&code),
                principal,
                &state.connection_organization.to_string(),
                true,
                now,
            )
            .await
            .unwrap();
        state
            .db
            .consume_browser_pairing(&hash_secret(&device), ORIGIN, &jkt, &hash_secret(&raw), now)
            .await
            .unwrap()
            .unwrap();
        Self {
            client_id,
            token: format!("opaque-session:{raw}"),
            jwk,
            key: opensesame_proof::ProofSigningKey::from_ec_der(&key.serialize_der()),
            resource: state.resource.clone(),
        }
    }

    /// Explicit trusted-verifier handoff fixture, not a native session upgrade.
    /// Signature verification is independently exercised by `host_authorization_tests`.
    pub(in crate::routes::agent_runs) async fn verified_webauthn_at(
        &self,
        state: &AppState,
        auth_time: i64,
    ) {
        let now = Utc::now().timestamp();
        let authorization = HostAuthorization {
            id: secret(),
            client_id: self.client_id.clone(),
            digest: secret(),
            operation: "browser.authenticate".into(),
            target_id: self.client_id.clone(),
            transition: None,
            run_version: None,
            expires_at: now + 240,
        };
        assert!(state
            .db
            .create_host_authorization(&authorization, now)
            .await
            .unwrap());
        assert!(state
            .db
            .authorize_host_challenge(
                &authorization,
                &secret(),
                Some(&json!({"role":"owner","auth_time":auth_time}).to_string()),
                None,
                now
            )
            .await
            .unwrap());
    }

    pub(in crate::routes::agent_runs) fn headers(&self, method: &str, uri: &str) -> HeaderMap {
        let proof = opensesame_proof::DpopClaims {
            jti: secret(),
            htm: method.into(),
            htu: format!("{}{}", self.resource, uri),
            iat: Utc::now().timestamp(),
            ath: Some(opensesame_proof::access_token_hash(&self.token)),
        };
        let signed = opensesame_proof::sign_dpop_proof(&self.jwk, &self.key, &proof).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("origin", ORIGIN.parse().unwrap());
        headers.insert(
            "authorization",
            format!("DPoP {}", self.token).parse().unwrap(),
        );
        headers.insert("dpop", signed.parse().unwrap());
        headers
    }

    pub(in crate::routes::agent_runs) async fn send(
        &self,
        app: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        send_json(app, &self.headers(method, uri), method, uri, body).await
    }

    pub(in crate::routes::agent_runs) async fn elevation(
        &self,
        state: &AppState,
        run_id: &str,
        transition: &str,
    ) -> String {
        let now = Utc::now().timestamp();
        let run = state
            .db
            .get_observation_run(&state.connection_organization.to_string(), run_id)
            .await
            .unwrap()
            .unwrap();
        let authorization = HostAuthorization {
            id: secret(),
            client_id: self.client_id.clone(),
            digest: secret(),
            operation: "agent.browser.control".into(),
            target_id: run_id.into(),
            transition: Some(transition.into()),
            run_version: Some(run.version),
            expires_at: now + 240,
        };
        let raw = secret();
        assert!(state
            .db
            .create_host_authorization(&authorization, now)
            .await
            .unwrap());
        assert!(state
            .db
            .authorize_host_challenge(
                &authorization,
                &secret(),
                None,
                Some(&hash_secret(&raw)),
                now
            )
            .await
            .unwrap());
        raw
    }

    pub(in crate::routes::agent_runs) async fn control(
        &self,
        f: &Fixture,
        run_id: &str,
        transition: &str,
    ) -> (StatusCode, Value) {
        let elevation = self.elevation(&f.state, run_id, transition).await;
        let route = if transition == "take" {
            "control"
        } else {
            transition
        };
        self.send(
            &f.app,
            "POST",
            &format!("/api/v1/agent/runs/{run_id}/{route}"),
            Some(json!({"elevation":elevation})),
        )
        .await
    }
}

pub(in crate::routes::agent_runs) struct Fixture {
    pub(in crate::routes::agent_runs) app: Router,
    pub(in crate::routes::agent_runs) state: AppState,
    pub(in crate::routes::agent_runs) org: String,
    pub(in crate::routes::agent_runs) alice: HeaderMap,
    pub(in crate::routes::agent_runs) bob: HeaderMap,
    pub(in crate::routes::agent_runs) browser: Browser,
    pub(in crate::routes::agent_runs) other_browser: Browser,
    old_origin: Option<String>,
    _env: std::sync::MutexGuard<'static, ()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(value) = &self.old_origin {
            std::env::set_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS", value);
        } else {
            std::env::remove_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS");
        }
    }
}

pub(in crate::routes::agent_runs) async fn fixture() -> Fixture {
    let state = test_demo_state().await;
    let guard = crate::app_state::test_env::lock();
    let old_origin = std::env::var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS").ok();
    std::env::set_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS", ORIGIN);
    let org = state.connection_organization;
    let alice = test_session_headers(&state, ALICE, org, OrganizationRole::Owner);
    let bob = test_session_headers(&state, BOB, org, OrganizationRole::Owner);
    let browser = Browser::paired(&state, ALICE).await;
    let other_browser = Browser::paired(&state, BOB).await;
    browser
        .verified_webauthn_at(&state, Utc::now().timestamp())
        .await;
    other_browser
        .verified_webauthn_at(&state, Utc::now().timestamp())
        .await;
    Fixture {
        app: crate::routes::router(state.clone()),
        state,
        org: org.to_string(),
        alice,
        bob,
        browser,
        other_browser,
        old_origin,
        _env: guard,
    }
}
