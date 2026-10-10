//! Service-caller admission for relay `mtls_required` (ADR 0132).
//!
//! Uses only the relay-installed binding set in [`RelayState`], not the Host
//! transport runtime or database.

use axum::http::Extensions;
use axum::response::Response;
use opensesame_domain::transport::{BindingPurpose, BindingScope, ServiceCaller, TransportError};
use opensesame_transport_security::guard::deny_response;
use opensesame_transport_security::PeerExtension;

use super::RelayState;

/// Admit a native peer for one vault-relay operation.
///
/// # Errors
///
/// A `403` with `x-opensesame-transport-error` when the listener policy or
/// binding set refuses the peer.
#[allow(clippy::result_large_err)]
pub fn require_vault_relay_caller(
    state: &RelayState,
    extensions: &Extensions,
    operation: &str,
) -> Result<ServiceCaller, Response> {
    let Some(profile) = state.mtls.as_ref() else {
        return Err(deny_response(&TransportError::ListenerPolicyMismatch));
    };
    let Some(PeerExtension(peer)) = extensions.get::<PeerExtension>() else {
        return Err(deny_response(&TransportError::ListenerPolicyMismatch));
    };
    let current = profile.generations.current().number;
    let caller = ServiceCaller::admit(
        (**peer).clone(),
        &BindingScope::Deployment,
        &state.bindings,
        BindingPurpose::VaultRelay,
        current,
        current,
        chrono::Utc::now(),
    )
    .map_err(|error| deny_response(&error))?;
    caller
        .require_operation(operation)
        .map_err(|error| deny_response(&error))?;
    Ok(caller)
}
