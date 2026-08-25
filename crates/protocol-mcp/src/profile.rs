use crate::McpError;
use opensesame_domain::{
    ProtocolProfile, TokenPresentation, PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER,
};

/// MCP Authorization spec date profile (Bearer-only).
///
/// # Errors
///
/// Returns an error if the pinned profile slug is invalid.
pub fn mcp_bearer_profile() -> Result<ProtocolProfile, McpError> {
    Ok(ProtocolProfile::parse_slug(
        PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER,
    )?)
}

/// Assert presentation matches MCP Bearer profile (rejects `DPoP` and stronger bindings).
///
/// # Errors
///
/// Returns an error unless the presentation is a bearer token.
pub fn assert_mcp_bearer_presentation(presentation: TokenPresentation) -> Result<(), McpError> {
    match presentation {
        TokenPresentation::Bearer => Ok(()),
        other => Err(McpError::BearerRequired(format!("{other:?}"))),
    }
}

/// Validate presentation against profile minimum (fail-closed on downgrade confusion).
///
/// # Errors
///
/// Returns an error when the presentation violates either the configured
/// profile or the MCP bearer-only profile.
pub fn validate_presentation_for_profile(
    profile: &ProtocolProfile,
    presentation: TokenPresentation,
) -> Result<(), McpError> {
    profile
        .assert_presentation_allowed(presentation)
        .map_err(McpError::from)?;
    assert_mcp_bearer_presentation(presentation)
}
