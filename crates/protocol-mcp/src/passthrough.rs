use crate::McpError;

/// Explicit rejection when callers attempt to reuse an inbound MCP bearer token
/// as a downstream credential. `OpenSesame` mints task-scoped credentials instead.
///
/// # Errors
///
/// Always returns `TokenPassthroughForbidden`.
pub fn reject_inbound_token_as_downstream_credential() -> Result<(), McpError> {
    Err(McpError::TokenPassthroughForbidden)
}
