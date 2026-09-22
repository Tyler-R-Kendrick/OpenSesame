//! The seam between the Host's transport runtime and managed-certificate
//! custody (ADR 0075): `OPENSESAME_TLS_IDENTITY_SOURCE=managed` names a
//! `certificate_id` whose key the Host holds sealed, and the lifecycle owner
//! turns that reference into a [`TlsIdentity`].
//!
//! The trait path other modules name is
//! `crate::transport::ManagedIdentityResolver`. `AppState` implements it by
//! delegating to [`resolve_managed_identity`]; the lifecycle owner replaces
//! that function's body with the custody bridge. Until then the source is
//! reported `source_unsupported` — a configured `managed` identity that
//! cannot be resolved fails startup (EXPLICIT-ENFORCEMENT), it never reads
//! as "no TLS configured".

use std::sync::Arc;

use opensesame_domain::transport::{CapabilityOutcome, TransportError};
use opensesame_transport_security::TlsIdentity;

use crate::app_state::AppState;

/// Resolves an operator-registered managed certificate into a usable TLS
/// identity. A reference in, material out — never a path or a socket.
#[async_trait::async_trait]
pub trait ManagedIdentityResolver: Send + Sync {
    /// # Errors
    ///
    /// `SourceUnsupported` when no custody bridge is wired,
    /// `IdentityMissing` when the id names nothing, `KeyPairMismatch` /
    /// `EvidenceExpired` when the sealed material is unusable.
    async fn resolve(&self, certificate_id: &str) -> Result<Arc<TlsIdentity>, TransportError>;

    /// What the status view advertises for `managed_certificate`.
    fn capability(&self) -> CapabilityOutcome;
}

/// Reason reported while the custody bridge is absent.
pub const UNWIRED_REASON: &str =
    "managed certificate custody is not bridged to the transport runtime on this host";

/// The custody bridge. Lifecycle owner: replace the body; keep the signature.
///
/// # Errors
///
/// `SourceUnsupported` until the bridge exists.
pub async fn resolve_managed_identity(
    _state: &AppState,
    _certificate_id: &str,
) -> Result<Arc<TlsIdentity>, TransportError> {
    Err(TransportError::SourceUnsupported)
}

#[async_trait::async_trait]
impl ManagedIdentityResolver for AppState {
    async fn resolve(&self, certificate_id: &str) -> Result<Arc<TlsIdentity>, TransportError> {
        resolve_managed_identity(self, certificate_id).await
    }

    fn capability(&self) -> CapabilityOutcome {
        CapabilityOutcome::unsupported(UNWIRED_REASON)
    }
}

/// A resolver with no managed custody at all (tests, the worker).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoManagedIdentity;

#[async_trait::async_trait]
impl ManagedIdentityResolver for NoManagedIdentity {
    async fn resolve(&self, _certificate_id: &str) -> Result<Arc<TlsIdentity>, TransportError> {
        Err(TransportError::SourceUnsupported)
    }

    fn capability(&self) -> CapabilityOutcome {
        CapabilityOutcome::unsupported(UNWIRED_REASON)
    }
}
