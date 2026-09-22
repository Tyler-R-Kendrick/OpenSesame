//! Atomic runtime activation with facts either way (LIFE-ACTIVATION).
//!
//! A candidate is built whole — the managed identity out of custody, or a
//! PEM pair handed in by a file reload, or a SPIFFE snapshot's identity —
//! and offered to [`TransportGenerations::activate`], which validates it
//! completely before swapping. Failure is a recorded `reload_failed` fact
//! with the transport code; the previous generation keeps serving and its
//! `not_after` is exactly what it was. Success records `loaded` and
//! `active` for the new generation and `superseded` for the one it
//! replaced. Renewal success is never inferred to mean any of this: the
//! renewal path calls [`activate_managed`] and reports its outcome
//! separately.

use std::sync::Arc;

use chrono::Utc;
use opensesame_domain::transport::{CredentialStatus, Custody, IdentitySourceKind, TransportError};
use opensesame_domain::OrganizationId;
use opensesame_transport_security::{
    GenerationCandidate, SecretBytes, TlsIdentity, TransportGenerations,
};

use crate::app_state::AppState;
use crate::managed_certs_tls::TransportPurpose;
use crate::transport_lifecycle::custody;
use crate::transport_lifecycle::facts::{self, Fact};

/// Offer `candidate` to `generations` for `target`, recording the facts.
///
/// # Errors
///
/// The validation failure, after a `reload_failed` fact was recorded. The
/// current generation is untouched.
pub async fn activate_candidate(
    state: &AppState,
    target: &str,
    generations: &TransportGenerations,
    candidate: GenerationCandidate,
) -> Result<u64, TransportError> {
    let previous = generations.current().number;
    match generations.activate(candidate) {
        Ok(number) => {
            let now = Utc::now();
            facts::note(
                state,
                target,
                Fact::Loaded {
                    generation: number,
                    at: now,
                },
            )
            .await;
            facts::note(
                state,
                target,
                Fact::Active {
                    generation: number,
                    at: now,
                },
            )
            .await;
            facts::note(
                state,
                target,
                Fact::Superseded {
                    by: number,
                    at: now,
                },
            )
            .await;
            Ok(number)
        }
        Err(error) => {
            facts::note(
                state,
                target,
                Fact::ReloadFailed {
                    code: error.code().to_owned(),
                    at: Utc::now(),
                },
            )
            .await;
            debug_assert_eq!(generations.current().number, previous);
            Err(error)
        }
    }
}

/// A candidate carrying `identity` and the current peer trust, requiring an
/// identity (a secure listener never runs without one).
#[must_use]
pub fn candidate_with_identity(
    generations: &TransportGenerations,
    identity: Arc<TlsIdentity>,
) -> GenerationCandidate {
    GenerationCandidate {
        identity: Some(identity),
        peer_trust: generations.current().peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    }
}

/// Activate the managed certificate `certificate_id` on `target`.
///
/// Resolves the identity out of custody (cache bypassed, so a freshly
/// renewed row is what gets loaded), then activates. A resolve failure is
/// recorded as `reload_failed` too: from the listener's point of view the
/// candidate never loaded.
///
/// # Errors
///
/// The custody or activation failure.
pub async fn activate_managed(
    state: &AppState,
    target: &str,
    certificate_id: &str,
    purpose: TransportPurpose,
    organization: Option<&OrganizationId>,
) -> Result<u64, TransportError> {
    let Some(generations) = state.transport_lifecycle.generations() else {
        // No runtime to activate on: the facts still say what happened.
        facts::note(
            state,
            target,
            Fact::ReloadFailed {
                code: TransportError::SourceUnsupported.code().to_owned(),
                at: Utc::now(),
            },
        )
        .await;
        return Err(TransportError::SourceUnsupported);
    };
    state.transport_lifecycle.invalidate(certificate_id);
    let identity = match organization {
        Some(org) => {
            let scope = custody::IdentityScope {
                organization_id: *org,
                connection_id: String::new(),
                identity: certificate_id.to_owned(),
                purpose,
            };
            custody::resolve_client_identity(state, &scope).await
        }
        None => custody::resolve_managed_identity(state, certificate_id, purpose).await,
    };
    let identity = match identity {
        Ok(identity) => identity,
        Err(error) => {
            facts::note(
                state,
                target,
                Fact::ReloadFailed {
                    code: error.code().to_owned(),
                    at: Utc::now(),
                },
            )
            .await;
            return Err(error);
        }
    };
    let candidate = candidate_with_identity(&generations, identity);
    let number = activate_candidate(state, target, &generations, candidate).await?;
    state
        .transport_lifecycle
        .bind_target(target, certificate_id);
    Ok(number)
}

// Awaiting its production call site: the file-reload path in
// `transport::boot` (integration-requests/SW-LIFECYCLE.md §6). Exercised by
// `activation_tests`.
#[allow(dead_code)]
/// Activate a PEM pair handed in by a file reload. The key bytes are wrapped
/// before parsing and never retained; a pair that does not match is a
/// recorded `reload_failed` with `key_pair_mismatch`.
///
/// # Errors
///
/// As [`activate_candidate`], plus the identity's own refusal.
pub async fn activate_pem(
    state: &AppState,
    target: &str,
    generations: &TransportGenerations,
    cert_chain_pem: &[u8],
    key_pem: SecretBytes,
) -> Result<u64, TransportError> {
    let identity = match TlsIdentity::from_pem(cert_chain_pem, &key_pem) {
        Ok(identity) => Arc::new(identity),
        Err(error) => {
            facts::note(
                state,
                target,
                Fact::ReloadFailed {
                    code: error.code().to_owned(),
                    at: Utc::now(),
                },
            )
            .await;
            return Err(error);
        }
    };
    let candidate = candidate_with_identity(generations, identity);
    activate_candidate(state, target, generations, candidate).await
}

// Awaiting its production call site: `transport::status` currently builds its
// own credential view, which has no revoked arm (integration-requests/
// SW-LIFECYCLE.md §6). Exercised by `activation_tests` and `boundary_tests`.
#[allow(dead_code)]
/// The credential dimension of a status view for the generation serving
/// now: custody is truthfully `HostSealedExportableToHost` for a managed
/// identity (the operator can still reveal it through the human-only route)
/// and the source is what the runtime was configured with.
#[must_use]
pub fn credential_status(
    generations: &TransportGenerations,
    kind: IdentitySourceKind,
    lifecycle: &crate::transport_lifecycle::LifecycleState,
) -> CredentialStatus {
    let current = generations.current();
    let Some(identity) = &current.identity else {
        return CredentialStatus::Unconfigured;
    };
    if lifecycle.is_denied(&identity.leaf_thumbprint_sha256()) {
        return CredentialStatus::Revoked {
            generation: current.number,
        };
    }
    if !identity.is_valid_at(Utc::now()) {
        return CredentialStatus::Expired {
            generation: current.number,
        };
    }
    let custody = match kind {
        IdentitySourceKind::ManagedCertificate => Custody::HostSealedExportableToHost,
        IdentitySourceKind::PemFiles => Custody::NativeFileExportable,
        IdentitySourceKind::SpiffeWorkloadApi => Custody::WorkloadApiDelivered,
        IdentitySourceKind::BrowserManaged => Custody::BrowserExternal,
    };
    CredentialStatus::Configured {
        custody,
        generation: current.number,
        not_after: identity.not_after(),
        kind,
    }
}
