//! Service-caller admission: verified transport evidence → one explicit
//! service binding → one exact operation.
//!
//! Authentication is not authorization. A certificate that chains to the
//! configured client CA gets a [`ServiceCaller`] only when the administrator
//! bound that exact peer identity, under that trust profile, for that
//! purpose, and allowed that operation string. Nothing in this module
//! produces a [`crate::middleware::auth::Caller`]: an authenticated bridge or
//! worker peer is a *service principal*, never an operator, and the operator
//! routes keep resolving callers the way they always did.
//!
//! Order of checks mirrors SW-CONTRACT's documented semantics, because the
//! deny code is part of the contract: listener policy → peer evidence →
//! revoked leaf (the lifecycle's durable denylist) → usable window and
//! generation freshness (inside `ServiceCaller::admit`) → binding
//! resolution → operation allowlist.

use axum::http::Extensions;
use axum::response::Response;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, ServiceCaller, TransportError, VerifiedPeer,
};
use opensesame_ingress_evidence::OriginatingPeerExtension;
use opensesame_transport_security::guard::deny_response;
use opensesame_transport_security::{ListenerProvenance, PeerExtension};

use crate::app_state::AppState;

use super::status::record_observation;

/// Admit a service-only caller.
///
/// # Errors
///
/// A `403` whose body and `x-opensesame-transport-error` header carry the
/// stable [`TransportError::code`]: `listener_policy_mismatch` on a plain
/// listener, then whatever admission or the binding set refused.
#[allow(clippy::result_large_err)]
pub fn require_service_caller(
    st: &AppState,
    extensions: &Extensions,
    purpose: BindingPurpose,
    operation: &str,
) -> Result<ServiceCaller, Response> {
    admit(
        st,
        extensions,
        purpose,
        operation,
        &BindingScope::Deployment,
    )
}

/// Admit a service caller acting for a tenant.
///
/// No Host route delegates through transport evidence yet — SW-CONNECTOR's
/// `connector.invoke` is the first that will — so outside tests this is not
/// called. It lives here, tested, so the cross-tenant refusal is written
/// once rather than reinvented at the first call site. The binding must be scoped to
/// `organization_id`: a certificate bound in one organization never carries
/// authority in another, whatever an accompanying session says
/// (credential substitution, AT-AUTHORITY-CROSSTENANT).
///
/// # Errors
///
/// As [`require_service_caller`].
#[allow(clippy::result_large_err)]
#[cfg_attr(not(test), allow(dead_code))]
pub fn require_delegated_caller(
    st: &AppState,
    extensions: &Extensions,
    purpose: BindingPurpose,
    operation: &str,
    organization_id: &opensesame_domain::OrganizationId,
) -> Result<ServiceCaller, Response> {
    admit(
        st,
        extensions,
        purpose,
        operation,
        &BindingScope::Organization {
            organization_id: organization_id.to_string(),
        },
    )
}

#[allow(clippy::result_large_err)]
fn admit(
    st: &AppState,
    extensions: &Extensions,
    purpose: BindingPurpose,
    operation: &str,
    scope: &BindingScope,
) -> Result<ServiceCaller, Response> {
    let Some(runtime) = st.transport.as_ref() else {
        return Err(deny_response(&TransportError::ListenerPolicyMismatch));
    };
    let peer = peer_evidence(extensions)?;
    // The durable revoked-leaf denylist (restored at boot, refreshed from
    // the store) holds for every binding — including one created after the
    // revocation, which carries no `denied_thumbprints` of its own.
    let revoked = std::iter::once(&peer)
        .chain(peer.ingress())
        .any(|evidence| {
            st.transport_lifecycle
                .is_denied(evidence.leaf_thumbprint_sha256())
        });
    if revoked {
        return Err(deny(&TransportError::EvidenceRevoked));
    }
    let current = runtime.generations.current().number;
    let bindings = runtime.binding_set();
    let caller = ServiceCaller::admit(
        peer,
        scope,
        &bindings,
        purpose,
        current,
        current,
        chrono::Utc::now(),
    )
    .map_err(|error| deny(&error))?;
    caller
        .require_operation(operation)
        .map_err(|error| deny(&error))?;
    record_observation(&runtime.status, &runtime.listener_id, &caller.peer);
    Ok(caller)
}

/// The evidence admission binds. Behind a trusted ingress the *forwarded*
/// evidence is handed to `admit`, which unwraps its ingress as the bound
/// peer and keeps the client as `originating`; everywhere else the direct
/// TLS peer is bound.
#[allow(clippy::result_large_err)]
fn peer_evidence(extensions: &Extensions) -> Result<VerifiedPeer, Response> {
    let provenance = extensions.get::<ListenerProvenance>();
    let authenticated = provenance.is_some_and(|p| p.policy().authenticates_client());
    if !authenticated {
        // A plain listener never carries a certificate, so a purpose that is
        // configured `mtls_required` cannot be served from it — and there is
        // no weaker credential to fall back to.
        return Err(deny_response(&TransportError::ListenerPolicyMismatch));
    }
    if let Some(OriginatingPeerExtension(originating)) =
        extensions.get::<OriginatingPeerExtension>()
    {
        return Ok((**originating).clone());
    }
    let Some(PeerExtension(peer)) = extensions.get::<PeerExtension>() else {
        return Err(deny_response(&TransportError::ForwardedEvidenceUnverified));
    };
    Ok((**peer).clone())
}

fn deny(error: &TransportError) -> Response {
    tracing::warn!(code = error.code(), "service admission denied");
    deny_response(error)
}

/// Whether a purpose is configured to arrive over authenticated TLS only.
/// Routes that keep a legacy shared-secret profile ask this before choosing
/// which door is open; a configured `mtls_required` purpose has exactly one.
#[must_use]
pub fn requires_mtls(st: &AppState, purpose: BindingPurpose) -> bool {
    st.transport
        .as_ref()
        .is_some_and(|runtime| runtime.config.requires_mtls(purpose))
}
