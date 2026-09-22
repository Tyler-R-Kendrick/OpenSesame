//! The *public* half of the NATS client transport policy: what an operator
//! may store, read back and see in a status view.
//!
//! Nothing here can express a path, a seed, a token or a key. The private
//! locators the deployment plane supplies live beside these types in
//! [`crate::nats_transport`] and are never serialized.

use opensesame_domain::transport::{IdentitySourceKind, TlsVersion, TrustProfileKind};
use serde::{Deserialize, Serialize};

/// Public reference to the bundle that verifies the *server*.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TrustRef {
    pub name: String,
    pub kind: TrustProfileKind,
}

/// Public reference to the identity the client *presents*.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct IdentityRef {
    pub name: String,
    pub kind: IdentitySourceKind,
}

/// What the client expects the broker to be.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum NatsServerName {
    Dns(String),
    SpiffeId(String),
}

/// Public transport policy (storable; no material).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct NatsTransport {
    #[serde(default)]
    pub require_tls: bool,
    #[serde(default)]
    pub tls_first: bool,
    #[serde(default)]
    pub server_trust: Option<TrustRef>,
    #[serde(default)]
    pub server_name: Option<NatsServerName>,
    #[serde(default)]
    pub client_identity: Option<IdentityRef>,
    #[serde(default = "default_min_version")]
    pub min_version: TlsVersion,
}

fn default_min_version() -> TlsVersion {
    TlsVersion::Tls13
}

impl Default for NatsTransport {
    fn default() -> Self {
        Self {
            require_tls: false,
            tls_first: false,
            server_trust: None,
            server_name: None,
            client_identity: None,
            min_version: TlsVersion::Tls13,
        }
    }
}

/// Public credential policy. `seed_ref` / `path_ref` name the deployment
/// variable that locates the file, never the file or its contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields, tag = "kind")]
pub enum NatsAuth {
    None,
    Nkey { seed_ref: String },
    Creds { path_ref: String },
}

impl NatsAuth {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Nkey { .. } => "nkey",
            Self::Creds { .. } => "creds",
        }
    }
}

/// Public policy + auth: the unit persisted in `host_kv` (`taskbus.transport`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct NatsTransportPublic {
    #[serde(default)]
    pub transport: NatsTransport,
    #[serde(default = "default_auth")]
    pub auth: NatsAuth,
}

fn default_auth() -> NatsAuth {
    NatsAuth::None
}

/// Where the effective transport policy came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatsTransportSource {
    Env,
    Stored,
    Default,
}

/// Derived policy word for status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatsTransportPolicy {
    /// The legacy loopback profile: no TLS, no credentials.
    Plaintext,
    ServerTls,
    MtlsRequired,
}

/// Status view: public policy plus derived facts. Never a path or a secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct NatsTransportView {
    pub policy: NatsTransportPolicy,
    pub source: NatsTransportSource,
    pub require_tls: bool,
    pub tls_first: bool,
    pub server_trust: Option<TrustRef>,
    pub server_name: Option<NatsServerName>,
    pub client_identity: Option<IdentityRef>,
    pub min_version: TlsVersion,
    pub auth: String,
    /// Whether discovered (`INFO.connect_urls`) servers are ignored — always
    /// true on a TLS profile: discovery must not widen egress.
    pub discovery_ignored: bool,
}
