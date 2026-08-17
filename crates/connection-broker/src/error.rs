//! Error codes are part of the HTTP contract: `code()` is what callers branch on.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error("provider catalog unavailable: {0}")]
    CatalogUnavailable(#[from] crate::catalog::CatalogError),
    #[error("unknown provider `{0}`")]
    ProviderUnknown(String),
    #[error("provider `{provider}` is not configured on this deployment")]
    ProviderUnconfigured {
        provider: String,
        missing: Vec<String>,
    },
    #[error("connection not found")]
    ConnectionNotFound,
    #[error("integration not found or disabled")]
    IntegrationNotFound,
    #[error("integration_id is required because multiple usable integrations exist")]
    IntegrationRequired,
    #[error("integration key already exists")]
    IntegrationConflict,
    #[error("deployment integrations are read-only")]
    IntegrationReadOnly,
    #[error("integration still has connections")]
    IntegrationInUse,
    #[error("authorization state is not valid")]
    InvalidState,
    #[error("authorization state expired")]
    StateExpired,
    #[error("token exchange failed: {0}")]
    ExchangeFailed(String),
    #[error("connection has no refresh token")]
    NotRefreshable,
    #[error("re-authorization required: {0}")]
    NeedsReauth(String),
    #[error("redirect_uri is not allowlisted")]
    RedirectNotAllowed,
    #[error("binding already exists")]
    BindingExists,
    #[error("binding not found")]
    BindingNotFound,
    #[error("sync target not found")]
    SyncTargetNotFound,
    /// `POST /credential` against an OAuth provider, or `authorize` against an
    /// api_key one.
    #[error("credential kind not supported by provider `{0}`")]
    UnsupportedCredential(String),
    #[error("credential sealing unavailable: {0}")]
    SealUnavailable(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] sqlx::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

impl BrokerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CatalogUnavailable(_) => "catalog_unavailable",
            Self::ProviderUnknown(_) => "provider_unknown",
            Self::ProviderUnconfigured { .. } | Self::SealUnavailable(_) => "provider_unconfigured",
            Self::ConnectionNotFound => "connection_not_found",
            Self::IntegrationNotFound => "integration_not_found",
            Self::IntegrationRequired => "integration_required",
            Self::IntegrationConflict => "integration_conflict",
            Self::IntegrationReadOnly => "integration_read_only",
            Self::IntegrationInUse => "integration_in_use",
            Self::InvalidState => "invalid_state",
            Self::StateExpired => "state_expired",
            Self::ExchangeFailed(_) => "exchange_failed",
            Self::NotRefreshable => "not_refreshable",
            Self::NeedsReauth(_) => "needs_reauth",
            Self::RedirectNotAllowed => "redirect_not_allowed",
            Self::BindingExists => "binding_exists",
            Self::BindingNotFound => "binding_not_found",
            Self::SyncTargetNotFound => "sync_target_not_found",
            Self::UnsupportedCredential(_) => "unsupported_credential",
            Self::Invalid(_) => "invalid_request",
            Self::Storage(_) | Self::Serde(_) => "internal_error",
        }
    }

    /// A sentence for a human. Storage and serde failures are deliberately opaque:
    /// their text is a server internal, not a hint.
    pub fn hint(&self) -> String {
        match self {
            Self::ProviderUnconfigured { missing, .. } => {
                format!("deployment is missing {}", missing.join(", "))
            }
            Self::CatalogUnavailable(_) => "the provider catalog is unavailable".into(),
            Self::Storage(_) | Self::Serde(_) => "the request could not be completed".into(),
            other => other.to_string(),
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::ConnectionNotFound
            | Self::BindingNotFound
            | Self::SyncTargetNotFound
            | Self::IntegrationNotFound => 404,
            Self::ProviderUnconfigured { .. } | Self::SealUnavailable(_) => 503,
            Self::BindingExists | Self::IntegrationConflict | Self::IntegrationInUse => 409,
            Self::IntegrationReadOnly => 403,
            Self::ExchangeFailed(_) | Self::NeedsReauth(_) => 502,
            Self::CatalogUnavailable(_) | Self::Storage(_) | Self::Serde(_) => 500,
            _ => 400,
        }
    }
}

pub type Result<T> = std::result::Result<T, BrokerError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_codes_are_stable() {
        assert_eq!(
            BrokerError::ConnectionNotFound.code(),
            "connection_not_found"
        );
        assert_eq!(BrokerError::InvalidState.code(), "invalid_state");
        assert_eq!(BrokerError::StateExpired.code(), "state_expired");
        assert_eq!(
            BrokerError::IntegrationNotFound.code(),
            "integration_not_found"
        );
        assert_eq!(BrokerError::IntegrationNotFound.http_status(), 404);
        assert_eq!(BrokerError::IntegrationInUse.code(), "integration_in_use");
        assert_eq!(BrokerError::IntegrationInUse.http_status(), 409);
        assert_eq!(
            BrokerError::RedirectNotAllowed.code(),
            "redirect_not_allowed"
        );
    }

    #[test]
    fn storage_failures_do_not_leak_their_text() {
        let e = BrokerError::Storage(sqlx::Error::RowNotFound);
        assert_eq!(e.code(), "internal_error");
        assert_eq!(e.hint(), "the request could not be completed");
    }
}
