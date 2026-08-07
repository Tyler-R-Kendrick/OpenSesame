use crate::McpError;
use opensesame_domain::ProtectedResource;
use url::Url;

/// Validate token audience matches the protected resource audience.
pub fn validate_audience(token_audience: &str, resource: &ProtectedResource) -> Result<(), McpError> {
    if token_audience != resource.audience {
        return Err(McpError::AudienceMismatch {
            expected: resource.audience.clone(),
            actual: token_audience.to_string(),
        });
    }
    Ok(())
}

/// Validate request URI is same-origin with the resource audience (scheme + host).
pub fn validate_resource_uri(request_uri: &str, resource: &ProtectedResource) -> Result<(), McpError> {
    let request = Url::parse(request_uri).map_err(|_| McpError::ResourceNotAuthorized {
        resource_name: resource.name.clone(),
    })?;
    let audience = Url::parse(&resource.audience).map_err(|_| McpError::ResourceNotAuthorized {
        resource_name: resource.name.clone(),
    })?;

    let same_origin = request.scheme() == audience.scheme()
        && request.host_str() == audience.host_str()
        && request.port_or_known_default() == audience.port_or_known_default();

    if !same_origin {
        return Err(McpError::ResourceNotAuthorized {
            resource_name: resource.name.clone(),
        });
    }
    Ok(())
}
