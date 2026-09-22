//! Who counts as an authorized ingress.
//!
//! A certificate under the right private root is not an ingress; an
//! explicitly bound one is. The gateway's service-admission code implements
//! [`IngressAdmission`] over its live binding set; [`BindingSetAdmission`] is
//! the reference implementation over a [`ServiceBindingSet`] and what the
//! tests use.

use std::sync::{Arc, RwLock};

use chrono::Utc;
use opensesame_domain::transport::{BindingPurpose, BindingScope, ServiceBindingSet, VerifiedPeer};

/// Decides whether a directly verified peer on the trusted-ingress listener
/// is one of the ingresses allowed to forward originating-client evidence.
pub trait IngressAdmission: Send + Sync {
    /// True only for an explicitly bound ingress. Default is deny.
    fn is_authorized_ingress(&self, peer: &VerifiedPeer) -> bool;
}

/// Admission over a shared [`ServiceBindingSet`]: the peer must resolve to
/// exactly one live, deployment-scoped binding whose purpose is
/// [`BindingPurpose::TrustedIngress`] under the peer's own trust profile, and
/// that binding must allow the `ingress.forward` operation.
pub struct BindingSetAdmission {
    bindings: Arc<RwLock<ServiceBindingSet>>,
}

impl BindingSetAdmission {
    #[must_use]
    pub fn new(bindings: Arc<RwLock<ServiceBindingSet>>) -> Self {
        Self { bindings }
    }
}

impl IngressAdmission for BindingSetAdmission {
    fn is_authorized_ingress(&self, peer: &VerifiedPeer) -> bool {
        let Ok(bindings) = self.bindings.read() else {
            return false;
        };
        bindings
            .resolve_scoped(
                &BindingScope::Deployment,
                peer.trust_profile(),
                peer.identities(),
                BindingPurpose::TrustedIngress,
                Utc::now(),
            )
            .is_ok_and(|binding| {
                binding.allows_operation(opensesame_domain::transport::operations::INGRESS_FORWARD)
            })
    }
}

/// Admits nothing. The safe default for any listener that has not been
/// given a binding set.
#[derive(Debug, Default, Clone, Copy)]
pub struct DenyAllIngress;

impl IngressAdmission for DenyAllIngress {
    fn is_authorized_ingress(&self, _peer: &VerifiedPeer) -> bool {
        false
    }
}
