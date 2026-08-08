use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("invalid id: {0}")]
    InvalidId(String),
    #[error("grant attenuation violated: {0}")]
    GrantAttenuation(String),
    #[error("delegation depth exceeded")]
    DelegationDepthExceeded,
    #[error("grant expired or not yet valid")]
    GrantTimeWindow,
    #[error("grant revoked")]
    GrantRevoked,
    #[error("canonicalization failed: {0}")]
    Canonicalization(String),
    #[error("availability class denied without authority quorum: {0:?}")]
    AuthorityUnavailable(crate::AvailabilityClass),
    #[error("organization boundary mismatch")]
    OrganizationMismatch,
    #[error("invalid transition {from} -> {to}")]
    InvalidTransition { from: String, to: String },
    #[error("raw credential export denied by policy")]
    ExportDenied,
    #[error("authority context invalid: {0}")]
    AuthorityContextInvalid(String),
    #[error("authority context locked after task activation")]
    AuthorityContextLocked,
    #[error("task ceiling compilation produced empty intersection")]
    TaskCeilingEmpty,
    #[error("task run is not active")]
    TaskNotActive,
    #[error("task authority expired")]
    TaskExpired,
    #[error("capability widen forbidden")]
    CapabilityWidenForbidden,
    #[error("task state version mismatch: expected {expected}, actual {actual}")]
    TaskStateVersionMismatch { expected: u64, actual: u64 },
    #[error("delegation chain cycle detected")]
    DelegationChainCycle,
    #[error("delegation chain invalid: {0}")]
    DelegationChainInvalid(String),
    #[error("proof key revoked")]
    ProofKeyRevoked,
    #[error("proof binding mismatch: {0}")]
    ProofBindingMismatch(String),
    #[error("unknown protocol profile: {0}")]
    UnknownProtocolProfile(String),
    #[error("token presentation downgrade rejected")]
    TokenPresentationDowngrade,
    #[error("authorization denied: {0}")]
    AuthorizationDenied(String),
    #[error("mediation acknowledgement incomplete")]
    MediationAckIncomplete,
    #[error("mediation acknowledgement mismatch: {0}")]
    MediationAckMismatch(String),
    #[error("frozen intent digest untrusted or missing")]
    FrozenIntentDigestUntrusted,
    #[error("frozen intent digest mismatch")]
    FrozenIntentDigestMismatch,
    #[error("frozen intent migration denied: {0}")]
    FrozenIntentMigrationDenied(String),
}
