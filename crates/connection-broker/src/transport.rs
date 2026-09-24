//! Connection transport (ADR 0132, SW-CONNECTOR): how a connection reaches
//! its upstream — server-authenticated TLS, or mTLS with a client identity the
//! Host holds — expressed as *references* the deployment plane resolves.
//!
//! A [`ConnectionTransport`] names things; it never carries them. An identity
//! reference is a short registered name, never a path, a socket, a URL or a
//! PEM block (NO-NEW-CUSTODY-BY-ACCIDENT): a value that looks like a locator
//! is refused at parse, and a reference resolves only through
//! [`ClientIdentityResolver`], which the Host implements over its managed
//! certificates and which must refuse a reference the calling organization
//! does not own. The broker itself never reads a file or a socket.
//!
//! Module map: [`store`] persists the record, [`pool`] scopes the HTTP
//! clients, [`execute`] runs the invoke path in the only permitted order
//! (authorize → egress preflight → resolve identity → open credential →
//! execute), and [`memory`] is the in-memory resolver tests and the gateway's
//! own tests use.

#[path = "transport_broker.rs"]
mod broker;
#[path = "transport_client.rs"]
pub mod client;
#[path = "transport_execute.rs"]
pub mod execute;
#[path = "transport_memory.rs"]
pub mod memory;
#[path = "transport_pool.rs"]
pub mod pool;
#[path = "transport_store.rs"]
pub mod store;

use std::sync::Arc;

use async_trait::async_trait;
use opensesame_domain::transport::{
    operations, CapabilityOutcome, IdentitySourceRef, PeerIdentitySelector, TransportError,
    TransportPolicy, TrustProfileRef,
};
use opensesame_transport_security::{ServerNamePolicy, TlsIdentity, TrustBundle};
use serde::{Deserialize, Serialize};

/// The purpose every connector identity resolution carries.
pub const PURPOSE_CONNECTOR_INVOKE: &str = operations::CONNECTOR_INVOKE;

/// Largest serialized transport record accepted from storage or a caller.
pub const MAX_TRANSPORT_JSON_BYTES: usize = 4 * 1024;

/// Longest reference name; the domain regex says the same, this is the
/// explicit custody fence.
pub const MAX_REF_BYTES: usize = 64;

/// The one reason a browser execution target is refused: the reason string
/// the PWA gate keys on (AT-BROWSER-KEY).
pub const BROWSER_VAULT_KEY_INJECTION: &str = "browser_vault_key_injection";

/// Where a connection's requests are executed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorExecutionTarget {
    /// The static Pages app: no vault-held TLS identity can ever be attached.
    Browser,
    /// The Host (gateway) process.
    Host,
    PersonalDaemon,
    WorkloadWorker,
}

/// What the server must *be*. Exact match; no wildcard, no IP, no CN.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerNameSelector {
    Dns(String),
    SpiffeId(String),
}

impl ServerNameSelector {
    /// # Errors
    ///
    /// `MalformedConfiguration` for a name that is not a valid DNS reference
    /// identity or SPIFFE ID.
    pub fn validate(&self) -> Result<(), TransportError> {
        match self {
            Self::Dns(name) => PeerIdentitySelector::DnsName(name.clone()).validate(),
            Self::SpiffeId(id) => PeerIdentitySelector::SpiffeId(id.clone()).validate(),
        }
    }

    #[must_use]
    pub fn policy(&self) -> ServerNamePolicy {
        match self {
            Self::Dns(name) => ServerNamePolicy::Dns(name.clone()),
            Self::SpiffeId(id) => ServerNamePolicy::SpiffeId(id.clone()),
        }
    }

    #[must_use]
    pub fn value(&self) -> &str {
        match self {
            Self::Dns(v) | Self::SpiffeId(v) => v,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct TransportWire {
    policy: TransportPolicy,
    #[serde(default)]
    identity: Option<IdentitySourceRef>,
    #[serde(default)]
    trust: Option<TrustProfileRef>,
    #[serde(default)]
    server_name: Option<ServerNameSelector>,
    execution_target: ConnectorExecutionTarget,
}

/// A connection's transport requirement. References only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    deny_unknown_fields,
    try_from = "TransportWire"
)]
pub struct ConnectionTransport {
    /// `server_tls` or `mtls_required`; nothing else is a connector policy.
    pub policy: TransportPolicy,
    /// The client identity to present (`mtls_required` only).
    pub identity: Option<IdentitySourceRef>,
    /// The bundle that verifies the upstream. Absent on `server_tls` means
    /// the Web PKI the Host already trusts.
    pub trust: Option<TrustProfileRef>,
    /// Required whenever `trust` is set.
    pub server_name: Option<ServerNameSelector>,
    pub execution_target: ConnectorExecutionTarget,
}

impl TryFrom<TransportWire> for ConnectionTransport {
    type Error = TransportError;

    fn try_from(wire: TransportWire) -> Result<Self, TransportError> {
        let transport = Self {
            policy: wire.policy,
            identity: wire.identity,
            trust: wire.trust,
            server_name: wire.server_name,
            execution_target: wire.execution_target,
        };
        transport.validate()?;
        Ok(transport)
    }
}

/// Refuse anything that could be a locator rather than a registered name:
/// a path, a URL, a socket, a PEM block, or simply too long (AT-CUSTODY-SOURCE).
///
/// # Errors
///
/// `MalformedConfiguration` naming `field`.
pub fn refuse_locator(field: &str, value: &str) -> Result<(), TransportError> {
    const MARKERS: &[&str] = &["/", "\\", "://", "unix:", "-----BEGIN"];
    if value.len() > MAX_REF_BYTES {
        return Err(TransportError::malformed(format!(
            "{field}: reference exceeds {MAX_REF_BYTES} bytes"
        )));
    }
    if let Some(marker) = MARKERS.iter().find(|m| value.contains(**m)) {
        return Err(TransportError::malformed(format!(
            "{field}: a reference names a registered source, never a locator ({marker:?})"
        )));
    }
    Ok(())
}

impl ConnectionTransport {
    /// Parse a serialized record, bounded.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for an oversized, unknown-field, locator-bearing
    /// or incoherent record.
    pub fn parse_json(bytes: &[u8]) -> Result<Self, TransportError> {
        if bytes.len() > MAX_TRANSPORT_JSON_BYTES {
            return Err(TransportError::malformed(format!(
                "connection transport exceeds {MAX_TRANSPORT_JSON_BYTES} bytes"
            )));
        }
        serde_json::from_slice(bytes)
            .map_err(|e| TransportError::malformed(format!("connection transport: {e}")))
    }

    /// The record as JSON.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when serialization fails (cannot happen for a
    /// validated record; kept fallible so nothing unwraps).
    pub fn to_json(&self) -> Result<String, TransportError> {
        serde_json::to_string(self).map_err(|e| TransportError::malformed(e.to_string()))
    }

    /// Re-check a record that may have been built by hand.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a non-connector policy, a locator where a
    /// reference belongs, a `server_tls` record with an identity, or a bundle
    /// without a server name; `IdentityMissing` / `TrustUnknown` for an
    /// `mtls_required` record missing either.
    pub fn validate(&self) -> Result<(), TransportError> {
        if let Some(identity) = &self.identity {
            refuse_locator("identity", &identity.name)?;
            identity.validate()?;
        }
        if let Some(trust) = &self.trust {
            refuse_locator("trust", &trust.name)?;
            trust.validate()?;
        }
        if let Some(name) = &self.server_name {
            refuse_locator("server_name", name.value())?;
            name.validate()?;
        }
        match self.policy {
            TransportPolicy::ServerTls => {
                if self.identity.is_some() {
                    return Err(TransportError::malformed(
                        "server_tls presents no client identity; use mtls_required",
                    ));
                }
                if self.trust.is_some() != self.server_name.is_some() {
                    return Err(TransportError::malformed(
                        "a trust profile and a server name are configured together",
                    ));
                }
                Ok(())
            }
            TransportPolicy::MtlsRequired => {
                if self.identity.is_none() {
                    return Err(TransportError::IdentityMissing);
                }
                if self.trust.is_none() {
                    return Err(TransportError::TrustUnknown);
                }
                if self.server_name.is_none() {
                    return Err(TransportError::malformed(
                        "mtls_required requires a server name",
                    ));
                }
                Ok(())
            }
            TransportPolicy::ExistingLocal | TransportPolicy::TrustedIngress => {
                Err(TransportError::malformed(
                    "connection transport policy must be server_tls or mtls_required",
                ))
            }
        }
    }

    /// Does executing this connection need a Host-held TLS identity?
    #[must_use]
    pub fn requires_vault_identity(&self) -> bool {
        self.identity.is_some()
    }

    /// Whether the configured execution target can run this transport at all
    /// (CONN-CAPABILITY). A browser can never attach a vault-held key to its
    /// TLS handshake, so a browser-targeted `mtls_required` connection is
    /// `Unsupported { reason: "browser_vault_key_injection" }` — the key is
    /// neither exported nor proxied to make it work.
    #[must_use]
    pub fn execution_capability(&self) -> CapabilityOutcome {
        if self.requires_vault_identity()
            && self.execution_target == ConnectorExecutionTarget::Browser
        {
            CapabilityOutcome::unsupported(BROWSER_VAULT_KEY_INJECTION)
        } else {
            CapabilityOutcome::Supported
        }
    }

    /// The typed refusal for an unsupported execution target
    /// (`source_unsupported`), or `Ok` when execution may proceed.
    ///
    /// # Errors
    ///
    /// `SourceUnsupported` when [`Self::execution_capability`] is not
    /// `Supported`.
    pub fn require_executable(&self) -> Result<(), TransportError> {
        if self.execution_capability().is_supported() {
            Ok(())
        } else {
            Err(TransportError::SourceUnsupported)
        }
    }
}

/// What a resolver is asked for: the organization and connection on whose
/// behalf, the reference, and the purpose. A resolver must refuse a
/// reference the organization does not own (AT-TLS-TENANT); the connection id
/// is there for the receipt, never for authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityScope {
    pub organization_id: String,
    pub connection_id: String,
    pub identity: IdentitySourceRef,
    pub purpose: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustScope {
    pub organization_id: String,
    pub connection_id: String,
    pub trust: TrustProfileRef,
    pub purpose: &'static str,
}

/// Resolves an identity reference to a loaded TLS identity. Implemented by the
/// Host over its managed certificates (`crates/gateway`, SW-LIFECYCLE) and by
/// [`crate::transport_memory::MemoryTransportResolver`] for tests. The broker
/// never resolves a reference any other way.
#[async_trait]
pub trait ClientIdentityResolver: Send + Sync {
    /// # Errors
    ///
    /// `IdentityMissing` when the organization has no such identity (which is
    /// also the answer for another organization's identity — no existence
    /// oracle), `EvidenceExpired` / `EvidenceRevoked` for one that may no
    /// longer be presented, `PeerDisallowed` for a purpose the identity is
    /// not registered for.
    async fn resolve(&self, scope: IdentityScope) -> Result<Arc<TlsIdentity>, TransportError>;
}

/// Resolves a trust-profile reference to the bundle that verifies the
/// upstream. Same ownership rule as [`ClientIdentityResolver`].
#[async_trait]
pub trait TrustProfileResolver: Send + Sync {
    /// # Errors
    ///
    /// `TrustUnknown` when the organization has no such profile.
    async fn resolve_trust(&self, scope: TrustScope) -> Result<Arc<TrustBundle>, TransportError>;
}

/// Both resolvers, as the Host installs them.
#[derive(Clone)]
pub struct ConnectorResolvers {
    pub identities: Arc<dyn ClientIdentityResolver>,
    pub trust: Arc<dyn TrustProfileResolver>,
}

impl std::fmt::Debug for ConnectorResolvers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConnectorResolvers")
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
