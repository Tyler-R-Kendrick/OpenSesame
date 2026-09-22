//! [`ServerProfile`] → `rustls::ServerConfig`, plus the listener limits.
//!
//! `MtlsRequired` and `TrustedIngress` require a client certificate at the
//! handshake (`WebPkiClientVerifier` with the bundle's CRLs, no
//! `allow_unauthenticated`), so no request reaches the router without one.
//! `ServerTls` verifies no client and is never advertised as mTLS. On the
//! two authenticating profiles session resumption, tickets, early data and
//! half-RTT data are all off: a resumed connection would carry an identity
//! verified under an older generation and 0-RTT data is replayable.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use opensesame_domain::transport::{
    validate_id, TlsVersion, TransportError, TransportPolicy, TrustProfileKind,
};
use rustls::server::{NoServerSessionStorage, WebPkiClientVerifier};
use rustls::sign::SingleCertAndKey;
use rustls::ServerConfig;

use crate::bounded::BoundedClientVerifier;
use crate::client::versions;
use crate::error::malformed;
use crate::identity::TlsIdentity;
use crate::provider;
use crate::trust::TrustBundle;

/// Per-listener denylist hook: `true` refuses the leaf thumbprint. Consulted
/// at the handshake and again by [`crate::enforce_current_generation`] on
/// every request, so a revocation reaches connections that are already open.
pub type DenyThumbprint = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Bounds every secure listener enforces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerLimits {
    /// Handshakes in flight at once; accepts wait for a slot.
    pub max_concurrent_handshakes: usize,
    /// A handshake slower than this is dropped.
    pub handshake_timeout: Duration,
    /// A connection with no bytes in either direction for this long is closed.
    pub idle_timeout: Duration,
    /// HTTP/1 read buffer (`max_buf_size`) and HTTP/2 header list bound.
    pub max_header_bytes: usize,
    /// `DefaultBodyLimit` applied to the router, outermost.
    pub max_body_bytes: usize,
    /// `VerifiedPeer::usable_until = authenticated_at + min(usable_for, leaf remaining)`.
    pub usable_for: Duration,
}

impl Default for ListenerLimits {
    fn default() -> Self {
        Self {
            max_concurrent_handshakes: 64,
            handshake_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(60),
            max_header_bytes: 16 * 1024,
            max_body_bytes: 1024 * 1024,
            usable_for: Duration::from_secs(300),
        }
    }
}

impl ListenerLimits {
    fn validate(&self) -> Result<(), TransportError> {
        if self.max_concurrent_handshakes == 0 {
            return Err(malformed("max_concurrent_handshakes must be at least 1"));
        }
        if self.handshake_timeout.is_zero()
            || self.idle_timeout.is_zero()
            || self.usable_for.is_zero()
        {
            return Err(malformed(
                "handshake_timeout, idle_timeout and usable_for must be non-zero",
            ));
        }
        if self.max_header_bytes < 8192 {
            return Err(malformed("max_header_bytes must be at least 8192"));
        }
        if self.max_body_bytes == 0 {
            return Err(malformed("max_body_bytes must be non-zero"));
        }
        Ok(())
    }
}

/// One listener's TLS policy for one generation.
#[derive(Clone)]
pub struct ServerProfile {
    /// `ServerTls`, `MtlsRequired` or `TrustedIngress`.
    pub policy: TransportPolicy,
    pub identity: Arc<TlsIdentity>,
    /// Required for `MtlsRequired`/`TrustedIngress`; must be absent for `ServerTls`.
    pub client_trust: Option<TrustBundle>,
    pub min_version: TlsVersion,
    pub limits: ListenerLimits,
    pub listener_id: String,
    /// Extra per-listener leaf denylist (see [`DenyThumbprint`]).
    pub deny_thumbprint: DenyThumbprint,
}

impl ServerProfile {
    /// A profile with default limits, TLS 1.3, no client trust and an empty
    /// denylist. Set `client_trust` for the authenticating policies.
    #[must_use]
    pub fn new(policy: TransportPolicy, identity: Arc<TlsIdentity>, listener_id: &str) -> Self {
        Self {
            policy,
            identity,
            client_trust: None,
            min_version: TlsVersion::Tls13,
            limits: ListenerLimits::default(),
            listener_id: listener_id.to_owned(),
            deny_thumbprint: Arc::new(|_| false),
        }
    }

    /// Check the profile is coherent before a config is built from it.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for an `ExistingLocal` policy, a leaf that
    /// cannot authenticate a server, a missing or wrong-kind client bundle
    /// on an authenticating policy, a client bundle on `ServerTls`, a bad
    /// listener id or bad limits; `EvidenceExpired` for an expired identity.
    pub fn validate(&self) -> Result<(), TransportError> {
        validate_id("listener_id", &self.listener_id)?;
        self.limits.validate()?;
        if self.policy == TransportPolicy::ExistingLocal {
            return Err(malformed("existing_local is not a TLS listener policy"));
        }
        if !self.identity.usage().permits_server_auth() {
            return Err(malformed(
                "listener identity leaf does not permit serverAuth",
            ));
        }
        if !self.identity.is_valid_at(chrono::Utc::now()) {
            return Err(TransportError::EvidenceExpired);
        }
        match (self.policy.authenticates_client(), &self.client_trust) {
            (true, None) => Err(malformed(format!(
                "{:?} requires a client trust bundle",
                self.policy
            ))),
            (true, Some(trust)) if trust.kind() == TrustProfileKind::WebPkiDns => Err(malformed(
                "the public web PKI cannot authenticate clients; use private_root or spiffe_trust_domain",
            )),
            (false, Some(_)) => Err(malformed(
                "server_tls verifies no client certificate; remove client_trust or choose mtls_required",
            )),
            _ => Ok(()),
        }
    }
}

impl fmt::Debug for ServerProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerProfile")
            .field("policy", &self.policy)
            .field("identity", &self.identity)
            .field("client_trust", &self.client_trust)
            .field("min_version", &self.min_version)
            .field("limits", &self.limits)
            .field("listener_id", &self.listener_id)
            .finish_non_exhaustive()
    }
}

/// Build the rustls server configuration for a profile.
///
/// # Errors
///
/// As [`ServerProfile::validate`], plus `MalformedConfiguration` when the
/// client verifier cannot be built from the bundle.
pub fn server_config(profile: &ServerProfile) -> Result<Arc<ServerConfig>, TransportError> {
    profile.validate()?;
    let provider = provider();
    let builder = ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(versions(profile.min_version))
        .map_err(|e| malformed(format!("protocol versions: {e}")))?;
    let verifier = match &profile.client_trust {
        Some(trust) => BoundedClientVerifier::new(
            WebPkiClientVerifier::builder_with_provider(trust.roots(), Arc::clone(&provider))
                .with_crls(trust.crls_owned())
                .build()
                .map_err(|e| malformed(format!("client verifier: {e}")))?,
        ),
        None => WebPkiClientVerifier::no_client_auth(),
    };
    let mut config = builder
        .with_client_cert_verifier(verifier)
        .with_cert_resolver(Arc::new(SingleCertAndKey::from(
            profile.identity.certified_key(),
        )));
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config.max_early_data_size = 0;
    if profile.policy.authenticates_client() {
        config.session_storage = Arc::new(NoServerSessionStorage {});
        config.send_tls13_tickets = 0;
        config.send_half_rtt_data = false;
    }
    Ok(Arc::new(config))
}
