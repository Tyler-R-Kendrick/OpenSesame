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
}
