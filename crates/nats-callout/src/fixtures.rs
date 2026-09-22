//! Disposable protocol fixtures for tests: freshly generated nkeys and a
//! signed `authorization_request` built the way nats-server builds one.
//! Nothing here is ever a real deployment's material; every key is made at
//! call time and dropped with the test.

use crate::jwt::{encode, jti_for, REQUEST_AUDIENCE};
use crate::model::{
    AuthorizationRequestClaims, ClientInfo, ConnectOpts, RequestNats, ServerId, CLAIMS_VERSION,
    REQUEST_TYPE,
};

/// One server, one callout account, one user: the three parties of a callout.
pub struct Parties {
    pub server: nkeys::KeyPair,
    pub account: nkeys::KeyPair,
    pub user: nkeys::KeyPair,
}

impl Parties {
    /// Fresh keys.
    ///
    /// # Panics
    ///
    /// Never for freshly generated keys; the `expect` documents the contract.
    #[must_use]
    pub fn generate() -> Self {
        Self {
            server: nkeys::KeyPair::new_server(),
            account: nkeys::KeyPair::new_account(),
            user: nkeys::KeyPair::new_user(),
        }
    }

    /// Claims for a request from `server` to `account` about `user`, issued
    /// at `now`, carrying `token` as the client's `auth_token`.
    #[must_use]
    pub fn request_claims(&self, now: i64, token: &str) -> AuthorizationRequestClaims {
        AuthorizationRequestClaims {
            jti: String::new(),
            iat: now,
            exp: Some(now + 2),
            nbf: None,
            iss: self.server.public_key(),
            // nats-server puts the configured callout issuer here, not the
            // user key, and addresses every request to the fixed audience.
            sub: self.account.public_key(),
            aud: REQUEST_AUDIENCE.into(),
            nats: RequestNats {
                server_id: ServerId {
                    name: "test-server".into(),
                    host: "127.0.0.1".into(),
                    id: self.server.public_key(),
                    version: "2.11.17".into(),
                    cluster: String::new(),
                    tags: vec![],
                    xkey: None,
                },
                user_nkey: self.user.public_key(),
                client_info: ClientInfo {
                    host: "127.0.0.1".into(),
                    id: 7,
                    name: "test-client".into(),
                    kind: "Client".into(),
                    client_type: "nats".into(),
                    nonce: "nonce-1".into(),
                    ..ClientInfo::default()
                },
                connect_opts: ConnectOpts {
                    auth_token: token.into(),
                    name: "test-client".into(),
                    lang: "rust".into(),
                    version: "0.50.0".into(),
                    protocol: 1,
                    ..ConnectOpts::default()
                },
                client_tls: None,
                request_nonce: "request-nonce-1".into(),
                kind: REQUEST_TYPE.into(),
                version: CLAIMS_VERSION,
            },
        }
    }

    /// Sign `claims` with the server key, filling `jti` the way jwt v2 does.
    ///
    /// # Panics
    ///
    /// When serialization or signing fails, which a generated key never does.
    #[must_use]
    pub fn sign_request(&self, mut claims: AuthorizationRequestClaims) -> String {
        claims.jti = String::new();
        let bytes = serde_json::to_vec(&claims).expect("claims serialize");
        claims.jti = jti_for(&bytes);
        encode(&claims, &self.server).expect("server key signs")
    }

    /// A complete signed request in one call.
    #[must_use]
    pub fn signed_request(&self, now: i64, token: &str) -> String {
        self.sign_request(self.request_claims(now, token))
    }
}
