//! Validation for new EST enrollment credentials, before sealing/storage.
use axum::{http::StatusCode, response::Response};
use serde::Deserialize;

/// The operator's EST configuration document. Unknown fields are refused.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EstConfigBody {
    /// Bootstrap passphrase (sealed at rest under `est_passphrase`).
    pub passphrase: Option<String>,
    /// Operator-uploaded bootstrap CA chain (PEM) whose client certificates
    /// may enroll. The EST listener's `client_trust` should name the same
    /// chain: chain validation happens at the handshake, and the enrollment
    /// layer pins which trust profile counts.
    pub bootstrap_chain_pem: Option<String>,
    /// When true a client certificate is mandatory. Omission preserves the
    /// existing requirement and defaults to required for new configurations.
    #[serde(default)]
    pub require_bootstrap: Option<bool>,
}

impl EstConfigBody {
    pub(super) fn validate(&self) -> Result<(), Response> {
        if self
            .passphrase
            .as_ref()
            .is_some_and(|value| value.len() < super::MIN_PASSPHRASE_BYTES)
        {
            return Err(super::refuse(
                StatusCode::BAD_REQUEST,
                "weak_enrollment_passphrase",
                "Enrollment passphrases require at least 16 bytes; use a generated random value",
            ));
        }
        Ok(())
    }
}
