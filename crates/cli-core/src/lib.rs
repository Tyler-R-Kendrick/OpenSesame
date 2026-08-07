//! Shared CLI helpers
use opensesame_domain::DomainError;

pub type Result<T> = std::result::Result<T, DomainError>;
