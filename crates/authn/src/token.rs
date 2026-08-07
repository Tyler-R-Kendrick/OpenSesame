use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TokenValidationError {
    #[error("unconfigured issuer")]
    UnconfiguredIssuer,
    #[error("audience mismatch")]
    AudienceMismatch,
    #[error("resource mismatch")]
    ResourceMismatch,
    #[error("algorithm not allowed")]
    AlgorithmNotAllowed,
    #[error("token expired")]
    Expired,
    #[error("issuer mix-up")]
    IssuerMixUp,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidatedAccessToken {
    pub issuer: String,
    pub subject: String,
    pub audience: Vec<String>,
    pub client_id: Option<String>,
    pub expires_at_unix: i64,
    pub assurance: Option<String>,
    pub auth_time: Option<i64>,
}

pub fn validate_audience(
    token_aud: &[String],
    required_resource: &str,
) -> Result<(), TokenValidationError> {
    if token_aud.iter().any(|a| a == required_resource) {
        Ok(())
    } else {
        Err(TokenValidationError::AudienceMismatch)
    }
}

/// Reject provider/MCP tokens presented as vault authorization (no passthrough).
pub fn reject_foreign_resource_token(
    token_aud: &[String],
    this_resource: &str,
) -> Result<(), TokenValidationError> {
    validate_audience(token_aud, this_resource).map_err(|_| TokenValidationError::ResourceMismatch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_audience() {
        assert!(reject_foreign_resource_token(
            &["https://api.github.com".into()],
            "https://opensesame.example"
        )
        .is_err());
    }
}
