use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AAuthError {
    #[error("scope exceeds capability ceiling")]
    ScopeOutsideCeiling,

    #[error("multiple persons in single-principal mapping")]
    MultiplePersons,

    #[error("domain error: {0}")]
    Domain(#[from] opensesame_domain::DomainError),
}
