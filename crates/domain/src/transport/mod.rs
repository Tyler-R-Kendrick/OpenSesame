//! Transport policy, workload identity, and service-binding contracts
//! (ADR 0130).
//!
//! Pure, serde-only. Everything here is either an operator/config DTO that
//! must reject unknown fields and coerce nothing, or an internal verified
//! evidence type that can never be deserialized. The privileged constructor
//! for the latter is [`attest::AttestedPeer::into_verified`], whose callers
//! are the rustls verifier in `crates/transport-security`, the Identity
//! plane's transport receiver, and the UDS peer-credential adapter — nothing
//! that reads a header, a body, or a plugin manifest.

pub mod attest;
mod binding;
mod capability;
mod error;
mod evidence;
mod policy;
mod selector;
mod status;
pub mod timestamp;

#[cfg(test)]
mod binding_tests;
#[cfg(test)]
mod binding_validate_tests;
#[cfg(test)]
mod capability_tests;
#[cfg(test)]
mod corpus_tests;
#[cfg(test)]
mod evidence_tests;
#[cfg(test)]
mod policy_tests;
#[cfg(test)]
mod selector_tests;
#[cfg(test)]
mod source_contract_tests;
#[cfg(test)]
mod status_tests;

pub use binding::{
    BindingPurpose, BindingScope, ServiceBinding, ServiceBindingSet, MAX_BINDINGS, MAX_LIST_ENTRIES,
};
pub use capability::{
    browser_vault_key_injection, CapabilityOutcome, TransportCapabilities, MAX_REASON_BYTES,
};
pub use error::{TransportError, TransportErrorView};
pub use evidence::{PeerEvidenceView, ServiceCaller, VerifiedPeer};
pub use policy::{
    Custody, EvidenceSource, IdentitySourceKind, IdentitySourceRef, TlsVersion, TransportPolicy,
    TrustProfileKind, TrustProfileRef, MAX_REF_NAME_BYTES,
};
pub use selector::{PeerIdentitySelector, MAX_SELECTOR_BYTES};
pub use status::{
    CredentialStatus, EnforcementStatus, ObservedAuthentication, RuntimeStatus, TransportStatusView,
};

/// Operation strings a service binding may allow (exact spellings).
pub mod operations {
    pub const NATS_CALLOUT_DECIDE: &str = "nats.callout.decide";
    pub const WORKER_PROVIDERS_LIST: &str = "worker.providers.list";
    pub const WORKER_HEALTH_READY: &str = "worker.health.ready";
    pub const PRINCIPALS_MAPPING_RESOLVE: &str = "principals.mapping.resolve";
    pub const INGRESS_FORWARD: &str = "ingress.forward";
    pub const TRANSPORT_PROBE: &str = "transport.probe";
    pub const CONNECTOR_INVOKE: &str = "connector.invoke";

    /// Every operation string the platform ships. A binding may name one of
    /// these or a well-formed operator-defined string; the list exists so
    /// callers can spell an operation once.
    pub const KNOWN: &[&str] = &[
        NATS_CALLOUT_DECIDE,
        WORKER_PROVIDERS_LIST,
        WORKER_HEALTH_READY,
        PRINCIPALS_MAPPING_RESOLVE,
        INGRESS_FORWARD,
        TRANSPORT_PROBE,
        CONNECTOR_INVOKE,
    ];
}

/// Maximum byte length of an id (binding id, service principal, listener,
/// operation, audience, organization id).
pub const MAX_ID_BYTES: usize = 128;

/// Validate an id: non-empty printable ASCII (no whitespace), ≤ 128 bytes.
///
/// # Errors
///
/// `MalformedConfiguration` naming `field` when the id is empty, too long,
/// or contains a byte outside `0x21..=0x7E`.
pub fn validate_id(field: &str, value: &str) -> Result<(), TransportError> {
    if value.is_empty() {
        return Err(TransportError::MalformedConfiguration(format!(
            "{field}: empty id"
        )));
    }
    if value.len() > MAX_ID_BYTES {
        return Err(TransportError::MalformedConfiguration(format!(
            "{field}: id exceeds {MAX_ID_BYTES} bytes"
        )));
    }
    if !value.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return Err(TransportError::MalformedConfiguration(format!(
            "{field}: id must be printable ASCII without whitespace"
        )));
    }
    Ok(())
}

/// Validate a SHA-256 thumbprint: exactly 64 lowercase hex characters.
///
/// # Errors
///
/// `MalformedConfiguration` naming `field` otherwise.
pub fn validate_thumbprint(field: &str, value: &str) -> Result<(), TransportError> {
    let ok = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(())
    } else {
        Err(TransportError::MalformedConfiguration(format!(
            "{field}: thumbprint must be 64 lowercase hex characters"
        )))
    }
}
