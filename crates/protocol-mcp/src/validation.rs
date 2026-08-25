use crate::McpError;
use opensesame_domain::ProtectedResource;
use url::Url;

/// Validate token audience matches the protected resource audience.
///
/// # Errors
///
/// Returns an error when the token audience differs from the resource audience.
pub fn validate_audience(
    token_audience: &str,
    resource: &ProtectedResource,
) -> Result<(), McpError> {
    if token_audience != resource.audience {
        return Err(McpError::AudienceMismatch {
            expected: resource.audience.clone(),
            actual: token_audience.to_string(),
        });
    }
    Ok(())
}

/// Validate a request URI against the resource audience.
///
/// Origin alone is not the resource. An audience is a resource indicator
/// (RFC 8707) and may be path-scoped — MCP servers are routinely mounted per
/// tenant on one host, as `https://mcp.example/tenant-a`. Comparing only
/// scheme/host/port would let a token minted for one tenant's resource pass the
/// resource check for its neighbour, so a path-scoped audience confines the
/// request to that path, at segment boundaries.
///
/// # Errors
///
/// Returns an error for malformed URLs, ambiguous user information, origin
/// mismatch, or a request outside the audience path.
pub fn validate_resource_uri(
    request_uri: &str,
    resource: &ProtectedResource,
) -> Result<(), McpError> {
    let denied = || McpError::ResourceNotAuthorized {
        resource_name: resource.name.clone(),
    };
    let request = Url::parse(request_uri).map_err(|_| denied())?;
    let audience = Url::parse(&resource.audience).map_err(|_| denied())?;

    // Userinfo makes the authority ambiguous to readers and to some clients:
    // `https://mcp.example@evil.test/` is a request to evil.test.
    if !request.username().is_empty() || request.password().is_some() {
        return Err(denied());
    }

    let same_origin = request.scheme() == audience.scheme()
        && request.host_str() == audience.host_str()
        && request.port_or_known_default() == audience.port_or_known_default();
    if !same_origin {
        return Err(denied());
    }

    let audience_path = audience.path().trim_end_matches('/');
    if !audience_path.is_empty() {
        let path = request.path();
        if path != audience_path && !path.starts_with(&format!("{audience_path}/")) {
            return Err(denied());
        }
    }
    Ok(())
}
