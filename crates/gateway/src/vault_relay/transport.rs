//! Relay profile transport (ADR 0181, ADR 0132).
//!
//! Default is plain TCP for browser slot-key admission. `mtls_required` is a
//! separate profile: the listener demands a client certificate and snapshot
//! routes admit through the relay-installed [`ServiceBindingSet`] only — not
//! the full Host `TransportRuntime` or SQLite.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use opensesame_domain::transport::{
    ServiceBindingSet, TransportError, TransportPolicy, TrustProfileRef,
};
use opensesame_transport_security::env::{
    self as tls_env, Lookup, NativeIdentitySpec, NativeTrustSpec,
};
use opensesame_transport_security::{
    GenerationCandidate, SecureListener, ServerProfile, TransportGenerations, TrustBundle,
};

use super::install_relay_bindings;

/// `OPENSESAME_RELAY_TRANSPORT`.
pub const TRANSPORT_VAR: &str = "OPENSESAME_RELAY_TRANSPORT";
/// Deployment prefix for the relay listener's own TLS material.
pub const RELAY_TLS_PREFIX: &str = "OPENSESAME_RELAY_TLS";
/// Default trust profile name for relay client CAs.
pub const DEFAULT_TRUST_PROFILE: &str = "client_ca";
/// `OPENSESAME_RELAY_TLS_CLIENT_TRUST_PROFILE`.
pub const TRUST_PROFILE_VAR: &str = "OPENSESAME_RELAY_TLS_CLIENT_TRUST_PROFILE";
/// Listener id stamped into relay mTLS provenance.
pub const RELAY_LISTENER: &str = "relay-tls";
/// Largest bindings document the relay will read for mTLS.
pub const MAX_BINDINGS_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayTransport {
    Plain,
    MtlsRequired,
}

impl RelayTransport {
    /// Read [`TRANSPORT_VAR`]; absent means plain HTTP.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for any other word.
    pub fn parse(lookup: &Lookup<'_>) -> Result<Self, TransportError> {
        match lookup(TRANSPORT_VAR).as_deref().map(str::trim) {
            None | Some("" | "plain") => Ok(Self::Plain),
            Some("mtls_required") => Ok(Self::MtlsRequired),
            Some(other) => Err(TransportError::malformed(format!(
                "{TRANSPORT_VAR}: {other:?} is not plain|mtls_required"
            ))),
        }
    }
}

/// Everything the `mtls_required` relay profile needs.
pub struct SecureProfile {
    pub listen: SocketAddr,
    pub generations: Arc<TransportGenerations>,
    pub trust_profile: TrustProfileRef,
    pub bindings: Arc<ServiceBindingSet>,
}

fn bindings_path(lookup: &Lookup<'_>) -> Result<PathBuf, TransportError> {
    lookup("OPENSESAME_SERVICE_BINDINGS_FILE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            TransportError::malformed(
                "OPENSESAME_SERVICE_BINDINGS_FILE is required for relay mtls_required",
            )
        })
}

fn read_bindings_file(path: &std::path::Path) -> Result<ServiceBindingSet, TransportError> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| TransportError::malformed(format!("relay bindings file: {e}")))?;
    if metadata.len() > MAX_BINDINGS_BYTES {
        return Err(TransportError::malformed(format!(
            "relay bindings file exceeds {MAX_BINDINGS_BYTES} bytes"
        )));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| TransportError::malformed(format!("relay bindings file: {e}")))?;
    install_relay_bindings(Some(&text)).map_err(|err| TransportError::malformed(err))
}

/// Load the secure relay profile.
///
/// # Errors
///
/// Missing identity, trust, bindings, or malformed listen address.
pub fn load_secure(listen: &str, lookup: &Lookup<'_>) -> Result<SecureProfile, TransportError> {
    let listen: SocketAddr = listen
        .parse()
        .map_err(|e| TransportError::malformed(format!("relay listen address: {e}")))?;
    let identity = match tls_env::load_identity_from(RELAY_TLS_PREFIX, lookup)?
        .ok_or(TransportError::IdentityMissing)?
    {
        NativeIdentitySpec::PemFiles { cert, key } => {
            Arc::new(tls_env::read_pem_identity(&cert, &key)?)
        }
        NativeIdentitySpec::ManagedCertificate { .. } | NativeIdentitySpec::Spiffe { .. } => {
            return Err(TransportError::SourceUnsupported);
        }
    };
    let trust_profile = TrustProfileRef::new(
        lookup(TRUST_PROFILE_VAR)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_TRUST_PROFILE.to_owned()),
    )?;
    let client_trust = match tls_env::load_trust_from(RELAY_TLS_PREFIX, lookup)?
        .ok_or(TransportError::TrustUnknown)?
    {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(&path)
                .map_err(|e| TransportError::malformed(format!("relay client trust: {e}")))?;
            TrustBundle::from_pem(trust_profile.clone(), kind, &pem)?
        }
        NativeTrustSpec::SpiffeTrustDomain { .. } => return Err(TransportError::SourceUnsupported),
    };
    let bindings = Arc::new(read_bindings_file(&bindings_path(lookup)?)?);
    let mut candidate = GenerationCandidate {
        identity: Some(identity),
        identity_required: true,
        ..GenerationCandidate::default()
    };
    candidate
        .peer_trust
        .insert(trust_profile.clone(), client_trust);
    let generation = candidate.into_generation(1, chrono::Utc::now())?;
    Ok(SecureProfile {
        listen,
        generations: TransportGenerations::new(generation),
        trust_profile,
        bindings,
    })
}

/// Bind the secure relay listener.
///
/// # Errors
///
/// The listener's own error.
pub async fn bind_secure(profile: &SecureProfile) -> Result<SecureListener, TransportError> {
    let trust_profile = profile.trust_profile.clone();
    SecureListener::bind(
        profile.listen,
        Arc::clone(&profile.generations),
        move |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(TransportError::IdentityMissing)?;
            let mut server =
                ServerProfile::new(TransportPolicy::MtlsRequired, identity, RELAY_LISTENER);
            server.client_trust = Some(generation.trust(&trust_profile)?.clone());
            Ok(server)
        },
    )
    .await
}
