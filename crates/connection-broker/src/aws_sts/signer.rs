//! The source credential and the `SigV4` signer over it.
//!
//! Signing is `aws-sigv4`'s, not ours. One thing about it is handled here:
//! the crate traces the canonical request at `trace` level, and the canonical
//! request carries `x-amz-security-token` when the source key is a session
//! credential. So every signature is computed under a subscriber that drops
//! everything ([`tracing::subscriber::NoSubscriber`]) — signing is synchronous,
//! and no filter a deployment sets can bring those lines back.

use std::collections::BTreeMap;
use std::fmt;
use std::time::SystemTime;

use aws_credential_types::Credentials;
use aws_sigv4::http_request::{sign, SignableBody, SignableRequest, SigningSettings};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;
use opensesame_invoke_through::{InvokeError, RequestSigner, SignableParts};
use secrecy::{ExposeSecret, SecretString};

/// STS's signing name.
const SERVICE: &str = "sts";

/// An IAM key pair, optionally a session credential, opened from a sealed
/// connection for one signature and dropped with the signer.
pub struct SourceCredential {
    access_key_id: String,
    secret_access_key: SecretString,
    session_token: Option<SecretString>,
}

impl fmt::Debug for SourceCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SourceCredential")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl SourceCredential {
    #[must_use]
    pub fn new(
        access_key_id: impl Into<String>,
        secret_access_key: SecretString,
        session_token: Option<SecretString>,
    ) -> Self {
        Self {
            access_key_id: access_key_id.into(),
            secret_access_key,
            session_token,
        }
    }

    /// The key pair a sealed aws-family configuration holds, when it holds
    /// one. Values are trimmed; an empty session token is absent.
    #[must_use]
    pub fn from_configuration(configuration: &BTreeMap<String, String>) -> Option<Self> {
        let field = |name: &str| {
            configuration
                .get(name)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
        };
        Some(Self {
            access_key_id: field("access_key_id")?.to_string(),
            secret_access_key: SecretString::from(field("secret_access_key")?.to_string()),
            session_token: field("session_token")
                .map(|token| SecretString::from(token.to_string())),
        })
    }
}

/// Signs one STS request in one region with one source credential.
pub struct SigV4Signer {
    credential: SourceCredential,
    region: String,
    time: SystemTime,
}

impl fmt::Debug for SigV4Signer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SigV4Signer")
            .field("credential", &self.credential)
            .field("region", &self.region)
            .finish_non_exhaustive()
    }
}

impl SigV4Signer {
    #[must_use]
    pub fn new(credential: SourceCredential, region: impl Into<String>) -> Self {
        Self {
            credential,
            region: region.into(),
            time: SystemTime::now(),
        }
    }

    /// Sign as of `time` (tests pin the clock).
    #[must_use]
    pub fn at(mut self, time: SystemTime) -> Self {
        self.time = time;
        self
    }
}

impl RequestSigner for SigV4Signer {
    fn sign(&self, parts: &SignableParts<'_>) -> Result<Vec<(String, String)>, InvokeError> {
        let identity: Identity = Credentials::new(
            self.credential.access_key_id.clone(),
            self.credential
                .secret_access_key
                .expose_secret()
                .to_string(),
            self.credential
                .session_token
                .as_ref()
                .map(|token| token.expose_secret().to_string()),
            None,
            "opensesame",
        )
        .into();
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name(SERVICE)
            .time(self.time)
            .settings(SigningSettings::default())
            .build()
            .map_err(|_| InvokeError::MalformedToken)?
            .into();
        let signable = SignableRequest::new(
            parts.method,
            parts.uri.as_str(),
            parts.headers.iter().copied(),
            SignableBody::Bytes(parts.body),
        )
        .map_err(|_| InvokeError::MalformedToken)?;
        let output =
            tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), || {
                sign(signable, &params)
            })
            .map_err(|_| InvokeError::MalformedToken)?;
        let (instructions, _signature) = output.into_parts();
        Ok(instructions
            .headers()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect())
    }

    fn reflection_secrets(&self) -> Vec<&SecretString> {
        let mut secrets = vec![&self.credential.secret_access_key];
        secrets.extend(self.credential.session_token.as_ref());
        secrets
    }
}

#[cfg(test)]
#[path = "signer_tests.rs"]
mod tests;
