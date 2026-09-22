//! The `authorization_request` claims nats-server signs (jwt v2,
//! `AuthorizationRequestClaims`). Every field defaults so a newer server
//! adding one does not break decoding; nothing here is trusted until
//! [`crate::jwt::decode_request`] has verified the signature.
//!
//! `ConnectOpts` carries the connecting client's credentials (password,
//! token, JWT). Its `Debug` prints only which fields are present.

use serde::{Deserialize, Serialize};

/// `nats.server_id` — the server that received the CONNECT.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerId {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub cluster: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// The server's public curve key when callouts are sealed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xkey: Option<String>,
}

/// `nats.client_info` — what the server knows about the connecting client.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientInfo {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub id: u64,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub name_tag: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default, rename = "type")]
    pub client_type: String,
    #[serde(default)]
    pub mqtt_id: String,
    #[serde(default)]
    pub nonce: String,
}

/// `nats.connect_opts` — the CONNECT body. Secret-bearing.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectOpts {
    #[serde(default)]
    pub jwt: String,
    #[serde(default)]
    pub nkey: String,
    #[serde(default)]
    pub sig: String,
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub pass: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub protocol: u32,
}

impl std::fmt::Debug for ConnectOpts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectOpts")
            .field("jwt", &present(&self.jwt))
            .field("nkey", &present(&self.nkey))
            .field("sig", &present(&self.sig))
            .field("auth_token", &present(&self.auth_token))
            .field("user", &present(&self.user))
            .field("pass", &present(&self.pass))
            .field("name", &self.name)
            .field("lang", &self.lang)
            .field("version", &self.version)
            .field("protocol", &self.protocol)
            .finish()
    }
}

fn present(value: &str) -> &'static str {
    if value.is_empty() {
        "<absent>"
    } else {
        "<present>"
    }
}

/// `nats.client_tls` — TLS facts the server reports about the client.
///
/// `certs` is whatever the client *presented*; `verified_chains` is what the
/// server *verified* against its own trust. Only the latter is evidence, and
/// only in a deployment that has opted in (see `crate::evidence`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientTls {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub cipher: String,
    #[serde(default)]
    pub certs: Vec<String>,
    #[serde(default)]
    pub verified_chains: Vec<Vec<String>>,
}

/// The `nats` object of an `authorization_request`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestNats {
    #[serde(default)]
    pub server_id: ServerId,
    #[serde(default)]
    pub user_nkey: String,
    #[serde(default)]
    pub client_info: ClientInfo,
    #[serde(default)]
    pub connect_opts: ConnectOpts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_tls: Option<ClientTls>,
    #[serde(default)]
    pub request_nonce: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub version: u32,
}

/// The whole claim set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationRequestClaims {
    #[serde(default)]
    pub jti: String,
    #[serde(default)]
    pub iat: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nbf: Option<i64>,
    #[serde(default)]
    pub iss: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub aud: String,
    #[serde(default)]
    pub nats: RequestNats,
}

/// `type` value of a request.
pub const REQUEST_TYPE: &str = "authorization_request";
/// `type` value of a response.
pub const RESPONSE_TYPE: &str = "authorization_response";
/// `type` value of the user JWT inside an allow.
pub const USER_TYPE: &str = "user";
/// jwt v2 claim version.
pub const CLAIMS_VERSION: u32 = 2;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_opts_debug_never_prints_material() {
        let opts = ConnectOpts {
            auth_token: "eyJ.secret.sig".into(),
            pass: "hunter2".into(),
            name: "cli".into(),
            ..ConnectOpts::default()
        };
        let text = format!("{opts:?}");
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("secret"));
        assert!(text.contains("auth_token: \"<present>\""));
        assert!(text.contains("nkey: \"<absent>\""));
    }

    #[test]
    fn unknown_fields_are_tolerated_and_type_is_renamed() {
        let json = r#"{"iss":"N","nats":{"type":"authorization_request","version":2,"future_field":1,
            "client_info":{"type":"nats","kind":"Client"}}}"#;
        let claims: AuthorizationRequestClaims = serde_json::from_str(json).unwrap();
        assert_eq!(claims.nats.kind, REQUEST_TYPE);
        assert_eq!(claims.nats.client_info.client_type, "nats");
        assert!(claims.nats.client_tls.is_none());
    }
}
