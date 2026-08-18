use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TaskAccessError {
    #[error("domain error: {0}")]
    Domain(#[from] opensesame_domain::DomainError),
    #[error("task run not found: {0}")]
    TaskNotFound(String),
    #[error("transition not found: {0}")]
    TransitionNotFound(String),
    #[error("no pending transition")]
    NoPendingTransition,
    #[error("a transition is already awaiting acknowledgements: {0}")]
    TransitionPending(String),
    #[error("result buffer held pending acknowledgements")]
    ResultBufferHeld,
    #[error("credential renewal exceeds maximum expiry")]
    CredentialRenewalExceeded,
    #[error("ceiling is immutable after task start")]
    CeilingImmutable,
    #[error("storage error: {0}")]
    Storage(String),
    #[error("task store at capacity")]
    Capacity,
}
