//! The two resolver seams over [`crate::managed_certs_tls`] (LIFE-CUSTODY).
//!
//! - [`resolve_managed_identity`] backs `crate::transport::ManagedIdentityResolver`
//!   for the Host's own listener and clients: a deployment-plane certificate
//!   id in, a [`TlsIdentity`] out, under the configured organization.
//! - [`resolve_client_identity`] backs the connection broker's
//!   `ClientIdentityResolver`: a tenant, a connection, and an identity
//!   reference in, a client-auth identity out — or `PeerDisallowed` when
//!   the identity is not that tenant's, with no unseal having happened.
//!
//! Both go through one cache on [`LifecycleState`], keyed by tenant,
//! certificate and purpose, invalidated on renewal and revocation, and never
//! serving an identity that has expired or whose leaf is denied.

use std::sync::Arc;

use opensesame_domain::transport::{CapabilityOutcome, TransportError};
use opensesame_domain::OrganizationId;
use opensesame_transport_security::TlsIdentity;

use crate::app_state::AppState;
use crate::managed_certs::CustodyError;
use crate::managed_certs_tls::{tls_identity_for, TransportPurpose};

/// What a connector-side resolve is scoped to. Mirrors the broker's
/// `IdentityScope`; every field is a public reference, never a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityScope {
    pub organization_id: OrganizationId,
    pub connection_id: String,
    /// The managed certificate id the connection was bound to.
    pub identity: String,
    pub purpose: TransportPurpose,
}

/// Map a custody refusal onto the transport error a runtime consumer reads.
///
/// `scoped` distinguishes a tenant asking for a certificate (where "not
/// yours" is `PeerDisallowed`) from the deployment naming its own listener
/// identity (where "no such certificate" is `IdentityMissing`).
#[must_use]
pub fn transport_error(error: &CustodyError, scoped: bool) -> TransportError {
    match error {
        CustodyError::NotFound if scoped => TransportError::PeerDisallowed,
        CustodyError::NotFound | CustodyError::NotInCustody | CustodyError::LeafNotRetained => {
            TransportError::IdentityMissing
        }
        CustodyError::NotActive => TransportError::EvidenceRevoked,
        CustodyError::PurposeMismatch => TransportError::PeerDisallowed,
        CustodyError::Mint(code) => match code.as_str() {
            "key_pair_mismatch" => TransportError::KeyPairMismatch,
            "evidence_expired" => TransportError::EvidenceExpired,
            other => TransportError::malformed(format!("managed identity: {other}")),
        },
        CustodyError::SealingUnavailable => TransportError::SourceUnsupported,
        CustodyError::NoAuthority
        | CustodyError::Superseded
        | CustodyError::LifetimeTooShort
        | CustodyError::Storage(_) => {
            TransportError::malformed(format!("managed identity: {}", error.code()))
        }
    }
}

async fn resolve(
    state: &AppState,
    organization: Option<&OrganizationId>,
    certificate_id: &str,
    purpose: TransportPurpose,
) -> Result<Arc<TlsIdentity>, CustodyError> {
    let lifecycle = &state.transport_lifecycle;
    let tenant = organization
        .copied()
        .unwrap_or(state.connection_organization)
        .to_string();
    if let Some(cached) = lifecycle.cached_identity(&tenant, certificate_id, purpose) {
        return Ok(cached);
    }
    let identity = tls_identity_for(state, certificate_id, purpose, organization).await?;
    if lifecycle.is_denied(&identity.leaf_thumbprint_sha256()) {
        return Err(CustodyError::NotActive);
    }
    lifecycle.cache_identity(&tenant, certificate_id, purpose, Arc::clone(&identity));
    Ok(identity)
}

/// The deployment's own managed identity (listener or Host client).
///
/// # Errors
///
/// `IdentityMissing` when the id names nothing the host holds,
/// `KeyPairMismatch` / `EvidenceExpired` when the sealed material is
/// unusable, `PeerDisallowed` when the row was issued for another purpose,
/// `EvidenceRevoked` when it is no longer active.
pub async fn resolve_managed_identity(
    state: &AppState,
    certificate_id: &str,
    purpose: TransportPurpose,
) -> Result<Arc<TlsIdentity>, TransportError> {
    resolve(state, None, certificate_id, purpose)
        .await
        .map_err(|error| transport_error(&error, false))
}

/// A tenant's client identity for a `ConnectionRef`-bound upstream.
///
/// The organization in the scope is the only tenant the row is looked up
/// under: a tenant-B scope naming a tenant-A certificate is `PeerDisallowed`
/// and the sealed key is never touched (AT-CUSTODY-SOURCE). The purpose is
/// checked against what the certificate was issued for, and the leaf must
/// permit `clientAuth`.
///
/// # Errors
///
/// As [`resolve_managed_identity`], with `PeerDisallowed` for a foreign
/// certificate.
pub async fn resolve_client_identity(
    state: &AppState,
    scope: &IdentityScope,
) -> Result<Arc<TlsIdentity>, TransportError> {
    if scope.purpose.is_listener() {
        return Err(TransportError::PeerDisallowed);
    }
    resolve(
        state,
        Some(&scope.organization_id),
        &scope.identity,
        scope.purpose,
    )
    .await
    .map_err(|error| transport_error(&error, true))
}

/// What the status view advertises for `managed_certificate`.
#[must_use]
pub fn capability(state: &AppState) -> CapabilityOutcome {
    if state.connection_broker.config().key().is_some() {
        CapabilityOutcome::Supported
    } else {
        CapabilityOutcome::unsupported(
            "managed certificate custody needs OPENSESAME_CONNECTION_KEY on this host",
        )
    }
}
