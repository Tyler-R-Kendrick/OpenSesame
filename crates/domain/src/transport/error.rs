//! Stable, non-secret transport error codes.

use serde::{Deserialize, Serialize};

/// Every way transport admission, configuration, or evidence validation can
/// fail. [`TransportError::code`] is the wire/machine contract; the `Display`
/// text may change, the codes may not.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TransportError {
    #[error("no transport identity is configured or loadable")]
    IdentityMissing,
    #[error("certificate and private key do not match")]
    KeyPairMismatch,
    #[error("trust profile is unknown to this service")]
    TrustUnknown,
    #[error("peer is authenticated but not bound to any service principal")]
    PeerNotBound,
    #[error("peer is bound but not allowed this operation, audience, or scope")]
    PeerDisallowed,
    #[error("more than one live binding matches the peer")]
    AmbiguousBinding,
    #[error("peer evidence is outside its usable window")]
    EvidenceExpired,
    #[error("peer evidence names a revoked leaf")]
    EvidenceRevoked,
    #[error("peer evidence was produced under a generation that is no longer current")]
    GenerationStale,
    #[error("identity or trust source is not supported on this platform")]
    SourceUnsupported,
    #[error("forwarded originating-client evidence was not produced by an authenticated ingress")]
    ForwardedEvidenceUnverified,
    #[error("proof-of-possession does not match the presented evidence")]
    ProofMismatch,
    #[error("request arrived on a listener whose policy does not carry this purpose")]
    ListenerPolicyMismatch,
    #[error("matching service binding is disabled, revoked, or outside its window")]
    BindingDisabled,
    #[error("the receiving side cannot enforce the requested policy")]
    EnforcementUnsupported,
    #[error("refusing to downgrade a required transport policy")]
    PolicyDowngradeRefused,
    #[error("malformed transport configuration: {0}")]
    MalformedConfiguration(String),
}

impl TransportError {
    /// Stable machine code: the `snake_case` spelling of the variant.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::IdentityMissing => "identity_missing",
            Self::KeyPairMismatch => "key_pair_mismatch",
            Self::TrustUnknown => "trust_unknown",
            Self::PeerNotBound => "peer_not_bound",
            Self::PeerDisallowed => "peer_disallowed",
            Self::AmbiguousBinding => "ambiguous_binding",
            Self::EvidenceExpired => "evidence_expired",
            Self::EvidenceRevoked => "evidence_revoked",
            Self::GenerationStale => "generation_stale",
            Self::SourceUnsupported => "source_unsupported",
            Self::ForwardedEvidenceUnverified => "forwarded_evidence_unverified",
            Self::ProofMismatch => "proof_mismatch",
            Self::ListenerPolicyMismatch => "listener_policy_mismatch",
            Self::BindingDisabled => "binding_disabled",
            Self::EnforcementUnsupported => "enforcement_unsupported",
            Self::PolicyDowngradeRefused => "policy_downgrade_refused",
            Self::MalformedConfiguration(_) => "malformed_configuration",
        }
    }

    /// Every code, for exhaustiveness checks and the TypeScript mirror.
    pub const ALL_CODES: &'static [&'static str] = &[
        "identity_missing",
        "key_pair_mismatch",
        "trust_unknown",
        "peer_not_bound",
        "peer_disallowed",
        "ambiguous_binding",
        "evidence_expired",
        "evidence_revoked",
        "generation_stale",
        "source_unsupported",
        "forwarded_evidence_unverified",
        "proof_mismatch",
        "listener_policy_mismatch",
        "binding_disabled",
        "enforcement_unsupported",
        "policy_downgrade_refused",
        "malformed_configuration",
    ];

    /// Operator-facing view: the code plus the non-secret detail, if any.
    #[must_use]
    pub fn view(&self) -> TransportErrorView {
        let detail = match self {
            Self::MalformedConfiguration(detail) => Some(detail.clone()),
            _ => None,
        };
        TransportErrorView {
            code: self.code().to_owned(),
            detail,
        }
    }

    /// Convenience for `MalformedConfiguration`.
    #[must_use]
    pub fn malformed(detail: impl Into<String>) -> Self {
        Self::MalformedConfiguration(detail.into())
    }
}

/// Wire form of a [`TransportError`]: `{ "code": "...", "detail": ... }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TransportErrorView {
    pub code: String,
    #[serde(default)]
    pub detail: Option<String>,
}
