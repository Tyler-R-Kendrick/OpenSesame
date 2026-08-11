use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProofError {
    #[error("missing DPoP proof")]
    MissingProof,
    #[error("invalid DPoP proof: {0}")]
    InvalidProof(String),
    #[error("DPoP replay detected for jti {0}")]
    Replay(String),
    #[error("DPoP key thumbprint mismatch")]
    KeyThumbprintMismatch,
    #[error("DPoP access token hash mismatch")]
    AccessTokenHashMismatch,
    #[error("DPoP confirmation thumbprint mismatch")]
    ConfirmationThumbprintMismatch,
    #[error("unsupported DPoP algorithm: {0}")]
    UnsupportedAlgorithm(String),
    #[error("DPoP proof key is too weak: {0}")]
    WeakProofKey(String),
    #[error("token presentation downgrade rejected")]
    TokenPresentationDowngrade,
    #[error("unauthorized proof request: {0}")]
    UnauthorizedProofRequest(String),
    #[error("signing oracle mismatch: {0}")]
    SigningOracleMismatch(String),
    #[error("domain error: {0}")]
    Domain(#[from] opensesame_domain::DomainError),
}
