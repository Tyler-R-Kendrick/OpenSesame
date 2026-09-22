//! The worker's transport profile.
//!
//! Two explicit profiles and no bridge between them:
//!
//! - `existing_local` is what the worker always had — a loopback listener and
//!   the shared operator/worker token. It is a supported profile, not a
//!   fallback, and it stays exactly as deliberate as it was.
//! - `mtls_required` is a networked workload identity: a TLS listener that
//!   will not complete a handshake without a client certificate, and an
//!   explicit service binding per admitted peer. In this profile the worker
//!   holds **no** token at all — `OPENSESAME_WORKER_TOKEN` and
//!   `OPENSESAME_OPERATOR_TOKEN` are never read, so there is nothing for a
//!   failed certificate to fall back to.
//!
//! A configured `mtls_required` whose material is missing, unreadable, or
//! malformed exits non-zero. It never serves plaintext and never serves with
//! the token profile.

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

/// `OPENSESAME_WORKER_TRANSPORT`.
pub const TRANSPORT_VAR: &str = "OPENSESAME_WORKER_TRANSPORT";
/// Deployment prefix for the worker listener's own material.
pub const WORKER_TLS_PREFIX: &str = "OPENSESAME_WORKER_TLS";
/// `OPENSESAME_WORKER_BINDINGS_FILE`.
pub const BINDINGS_VAR: &str = "OPENSESAME_WORKER_BINDINGS_FILE";
/// The trust profile the worker's client CA is filed under.
pub const TRUST_PROFILE_VAR: &str = "OPENSESAME_WORKER_TLS_CLIENT_TRUST_PROFILE";
/// Default value of [`TRUST_PROFILE_VAR`].
pub const DEFAULT_TRUST_PROFILE: &str = "client_ca";
/// The listener id stamped into this worker's provenance.
pub const WORKER_LISTENER: &str = "worker-tls";
/// Largest bindings document the worker will read.
pub const MAX_BINDINGS_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerTransport {
    ExistingLocal,
    MtlsRequired,
}

impl WorkerTransport {
    /// Read [`TRANSPORT_VAR`]; absent means the existing local profile.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for any other word — never a silent default.
    pub fn parse(lookup: &Lookup<'_>) -> Result<Self, TransportError> {
        match lookup(TRANSPORT_VAR).as_deref().map(str::trim) {
            None | Some("" | "existing_local") => Ok(Self::ExistingLocal),
            Some("mtls_required") => Ok(Self::MtlsRequired),
            Some(other) => Err(TransportError::malformed(format!(
                "{TRANSPORT_VAR}: {other:?} is not existing_local|mtls_required"
            ))),
        }
    }
}

/// Everything the `mtls_required` profile needs, resolved from the
/// deployment plane and nowhere else.
pub struct SecureProfile {
    pub listen: SocketAddr,
    pub generations: Arc<TransportGenerations>,
    pub trust_profile: TrustProfileRef,
    pub bindings: Arc<ServiceBindingSet>,
}

/// Load the secure profile.
///
/// # Errors
///
/// `IdentityMissing` / `TrustUnknown` when a required source is absent, and
/// `MalformedConfiguration` for an unreadable or oversized file, a bad listen
/// address, or an invalid bindings document.
pub fn load(listen: &str, lookup: &Lookup<'_>) -> Result<SecureProfile, TransportError> {
    let listen: SocketAddr = listen
        .parse()
        .map_err(|e| TransportError::malformed(format!("worker listen address: {e}")))?;
    let identity = match tls_env::load_identity_from(WORKER_TLS_PREFIX, lookup)?
        .ok_or(TransportError::IdentityMissing)?
    {
        NativeIdentitySpec::PemFiles { cert, key } => {
            Arc::new(tls_env::read_pem_identity(&cert, &key)?)
        }
        // The worker has no sealed custody of its own and opens no Workload
        // API socket; its identity is an already-provisioned file pair.
        NativeIdentitySpec::ManagedCertificate { .. } | NativeIdentitySpec::Spiffe { .. } => {
            return Err(TransportError::SourceUnsupported)
        }
    };
    let trust_profile = TrustProfileRef::new(
        lookup(TRUST_PROFILE_VAR)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_TRUST_PROFILE.to_owned()),
    )?;
    let client_trust = match tls_env::load_trust_from(WORKER_TLS_PREFIX, lookup)?
        .ok_or(TransportError::TrustUnknown)?
    {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(&path)
                .map_err(|e| TransportError::malformed(format!("worker client trust: {e}")))?;
            TrustBundle::from_pem(trust_profile.clone(), kind, &pem)?
        }
        NativeTrustSpec::SpiffeTrustDomain { .. } => return Err(TransportError::SourceUnsupported),
    };
    let bindings = Arc::new(read_bindings(
        &lookup(BINDINGS_VAR)
            .map(PathBuf::from)
            .ok_or_else(|| TransportError::malformed(format!("{BINDINGS_VAR} is required")))?,
    )?);
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

/// Read and validate the worker's binding set. An unreadable or malformed
/// file is an error; it never becomes an empty (and therefore permissive-
/// looking) default.
///
/// # Errors
///
/// `MalformedConfiguration`.
pub fn read_bindings(path: &std::path::Path) -> Result<ServiceBindingSet, TransportError> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| TransportError::malformed(format!("worker bindings file: {e}")))?;
    if metadata.len() > MAX_BINDINGS_BYTES {
        return Err(TransportError::malformed(format!(
            "worker bindings file exceeds {MAX_BINDINGS_BYTES} bytes"
        )));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| TransportError::malformed(format!("worker bindings file: {e}")))?;
    ServiceBindingSet::parse_json(&text)
}

/// Bind the secure listener. A profile that cannot produce a valid server
/// configuration fails here, before anything listens.
///
/// # Errors
///
/// The listener's own error.
pub async fn bind(profile: &SecureProfile) -> Result<SecureListener, TransportError> {
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
                ServerProfile::new(TransportPolicy::MtlsRequired, identity, WORKER_LISTENER);
            server.client_trust = Some(generation.trust(&trust_profile)?.clone());
            Ok(server)
        },
    )
    .await
}
