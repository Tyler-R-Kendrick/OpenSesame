//! Outbound TLS: [`ClientProfile`] → `rustls::ClientConfig` /
//! `reqwest::ClientBuilder`.
//!
//! Server verification is one of two explicit profiles and nothing else:
//! `Dns` runs rustls's `WebPkiServerVerifier` (chain, time, CRLs, RFC 9525
//! reference identity) against the bundle; `SpiffeId` runs
//! [`SpiffeServerVerifier`]. A bundle of the wrong kind for the policy is a
//! configuration error, never a fallback.

use std::sync::Arc;

use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TransportError, TrustProfileKind,
};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::ServerName;
use rustls::sign::SingleCertAndKey;
use rustls::ClientConfig;

use crate::bounded::BoundedServerVerifier;
use crate::error::malformed;
use crate::identity::TlsIdentity;
use crate::provider;
use crate::trust::TrustBundle;
use crate::verify_spiffe::SpiffeServerVerifier;

/// What the client expects the server to *be*.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerNamePolicy {
    /// RFC 9525 DNS reference identity against a `WebPkiDns` or
    /// `PrivateRoot` bundle.
    Dns(String),
    /// Exact SPIFFE ID against a `SpiffeTrustDomain` bundle.
    SpiffeId(String),
}

/// Everything an outbound TLS connection needs.
#[derive(Clone, Debug)]
pub struct ClientProfile {
    pub server_trust: TrustBundle,
    pub server_name: ServerNamePolicy,
    pub identity: Option<Arc<TlsIdentity>>,
    pub min_version: TlsVersion,
}

/// Protocol versions for a minimum: TLS 1.3 only by default, TLS 1.2 only
/// when explicitly configured (rustls's safe TLS 1.2 defaults).
#[must_use]
pub(crate) fn versions(min: TlsVersion) -> &'static [&'static rustls::SupportedProtocolVersion] {
    static TLS13_ONLY: &[&rustls::SupportedProtocolVersion] = &[&rustls::version::TLS13];
    static TLS12_AND_UP: &[&rustls::SupportedProtocolVersion] =
        &[&rustls::version::TLS13, &rustls::version::TLS12];
    match min {
        TlsVersion::Tls13 => TLS13_ONLY,
        TlsVersion::Tls12 => TLS12_AND_UP,
    }
}

fn check_policy(profile: &ClientProfile) -> Result<(), TransportError> {
    let kind = profile.server_trust.kind();
    match &profile.server_name {
        ServerNamePolicy::Dns(name) => {
            PeerIdentitySelector::DnsName(name.clone()).validate()?;
            if kind == TrustProfileKind::SpiffeTrustDomain {
                return Err(malformed(
                    "server_name dns requires a web_pki_dns or private_root trust profile",
                ));
            }
        }
        ServerNamePolicy::SpiffeId(id) => {
            PeerIdentitySelector::SpiffeId(id.clone()).validate()?;
            if kind != TrustProfileKind::SpiffeTrustDomain {
                return Err(malformed(
                    "server_spiffe_id requires a spiffe_trust_domain trust profile",
                ));
            }
        }
    }
    if let Some(identity) = &profile.identity {
        if !identity.usage().permits_client_auth() {
            return Err(malformed("client identity leaf does not permit clientAuth"));
        }
        if !identity.is_valid_at(chrono::Utc::now()) {
            return Err(TransportError::EvidenceExpired);
        }
    }
    Ok(())
}

/// Build the rustls client configuration for a profile.
///
/// # Errors
///
/// `MalformedConfiguration` for a policy/bundle mismatch, an identity that
/// cannot authenticate a client, or a verifier that cannot be built;
/// `EvidenceExpired` for an expired client identity.
pub fn client_config(profile: &ClientProfile) -> Result<ClientConfig, TransportError> {
    check_policy(profile)?;
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(versions(profile.min_version))
        .map_err(|e| malformed(format!("protocol versions: {e}")))?;
    let builder = match &profile.server_name {
        ServerNamePolicy::Dns(_) => {
            let verifier = WebPkiServerVerifier::builder_with_provider(
                profile.server_trust.roots(),
                Arc::clone(&provider),
            )
            .with_crls(profile.server_trust.crls_owned())
            .build()
            .map_err(|e| malformed(format!("server verifier: {e}")))?;
            builder
                .dangerous()
                .with_custom_certificate_verifier(BoundedServerVerifier::new(verifier))
        }
        ServerNamePolicy::SpiffeId(id) => {
            let verifier = SpiffeServerVerifier::new(profile.server_trust.clone(), id, &provider)?;
            // `dangerous()` is rustls's name for "custom verifier"; the
            // verifier installed here performs full chain, time, revocation
            // and handshake-signature verification (see `verify_spiffe`).
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
        }
    };
    let config = match &profile.identity {
        Some(identity) => builder
            .with_client_cert_resolver(Arc::new(SingleCertAndKey::from(identity.certified_key()))),
        None => builder.with_no_client_auth(),
    };
    Ok(config)
}

/// Layer the profile onto a caller's `reqwest::ClientBuilder`.
///
/// The caller's redirect policy, proxy settings, timeouts and limits are
/// left exactly as given; only the TLS configuration and `tls_info(true)`
/// are set, so `Response::extensions().get::<reqwest::tls::TlsInfo>()`
/// exposes the verified peer certificate for status and token binding.
///
/// # Errors
///
/// As [`client_config`].
pub fn reqwest_builder(
    profile: &ClientProfile,
    base: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, TransportError> {
    let config = client_config(profile)?;
    Ok(base.use_preconfigured_tls(config).tls_info(true))
}

/// The `ServerName` to hand rustls when dialing.
///
/// For `Dns`, it is the configured reference identity (what the verifier
/// checks), whatever address was dialed. For `SpiffeId`, the verifier
/// ignores it, so it is the dialed host — a DNS name or an IP literal —
/// which lets the server pick a certificate by SNI without pretending the
/// SPIFFE ID is a hostname.
///
/// # Errors
///
/// `MalformedConfiguration` when the name is not a valid DNS name or IP.
pub fn dial_name(
    policy: &ServerNamePolicy,
    dialed_host: &str,
) -> Result<ServerName<'static>, TransportError> {
    let raw = match policy {
        ServerNamePolicy::Dns(name) => name.as_str(),
        ServerNamePolicy::SpiffeId(_) => dialed_host,
    };
    ServerName::try_from(raw.to_owned()).map_err(|_| {
        malformed(format!(
            "server name {raw:?} is not a DNS name or IP address"
        ))
    })
}
