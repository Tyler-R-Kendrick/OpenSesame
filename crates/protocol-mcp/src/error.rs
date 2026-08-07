use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum McpError {
    #[error("MCP profile requires Bearer presentation, not {0:?}")]
    BearerRequired(String),

    #[error("token passthrough forbidden: inbound bearer must not be forwarded as downstream credential")]
    TokenPassthroughForbidden,

    #[error("audience mismatch: expected {expected}, got {actual}")]
    AudienceMismatch { expected: String, actual: String },

    #[error("resource URI not authorized for protected resource {resource_name}")]
    ResourceNotAuthorized { resource_name: String },

    #[error("domain error: {0}")]
    Domain(#[from] opensesame_domain::DomainError),
}
