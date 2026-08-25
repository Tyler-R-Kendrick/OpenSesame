use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeviceFlowError {
    #[error("authorization_pending")]
    AuthorizationPending,
    #[error("slow_down")]
    SlowDown,
    #[error("access_denied")]
    AccessDenied,
    #[error("expired_token")]
    ExpiredToken,
    #[error("cancelled")]
    Cancelled,
    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

#[derive(Clone, Debug)]
pub struct DeviceAuthorization {
    /// Kept in process memory only — never logged or persisted.
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub interval_seconds: u64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DevicePollState {
    pub interval_seconds: u64,
    pub expires_at: DateTime<Utc>,
    pub cancelled: bool,
}

impl DevicePollState {
    #[must_use]
    pub fn new(auth: &DeviceAuthorization) -> Self {
        Self {
            interval_seconds: auth.interval_seconds.max(1),
            expires_at: auth.expires_at,
            cancelled: false,
        }
    }

    pub fn on_slow_down(&mut self) {
        self.interval_seconds = self.interval_seconds.saturating_add(5);
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn next_action(
        &mut self,
        now: DateTime<Utc>,
        server: DeviceServerStatus,
    ) -> Result<DevicePollOutcome, DeviceFlowError> {
        if self.cancelled {
            return Err(DeviceFlowError::Cancelled);
        }
        if now >= self.expires_at {
            return Err(DeviceFlowError::ExpiredToken);
        }
        match server {
            DeviceServerStatus::AuthorizationPending => Err(DeviceFlowError::AuthorizationPending),
            DeviceServerStatus::SlowDown => {
                self.on_slow_down();
                Err(DeviceFlowError::SlowDown)
            }
            DeviceServerStatus::AccessDenied => Err(DeviceFlowError::AccessDenied),
            DeviceServerStatus::Expired => Err(DeviceFlowError::ExpiredToken),
            DeviceServerStatus::Success => Ok(DevicePollOutcome::Complete),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceServerStatus {
    AuthorizationPending,
    SlowDown,
    AccessDenied,
    Expired,
    Success,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DevicePollOutcome {
    Complete,
}

#[must_use]
pub fn hash_device_code_for_tests_only(code: &str) -> String {
    let mut h = Sha256::new();
    h.update(code.as_bytes());
    format!("sha256:{}", hex::encode(h.finalize()))
}

mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::new();
        for b in data.as_ref() {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0xf) as usize] as char);
        }
        s
    }
}

/// Accept `verification_uri_complete` only when it is same-origin with the issuer.
///
/// This URL is opened in the human's browser with the user code in it, so a
/// prefix comparison is not enough: `https://issuer.example.evil.test/device`
/// starts with `https://issuer.example` and would send the approval ceremony to
/// an attacker.
#[must_use]
pub fn validate_verification_uri_complete(complete: &str, issuer_origin: &str) -> Option<String> {
    let candidate = url::Url::parse(complete).ok()?;
    let issuer = url::Url::parse(issuer_origin).ok()?;
    if candidate.scheme() != issuer.scheme() {
        return None;
    }
    if candidate.host() != issuer.host() {
        return None;
    }
    if candidate.port_or_known_default() != issuer.port_or_known_default() {
        return None;
    }
    // Credentials in the URL are never part of a legitimate ceremony link.
    if !candidate.username().is_empty() || candidate.password().is_some() {
        return None;
    }
    // Respect a path-scoped issuer (e.g. `https://idp.example/tenant-a`).
    let issuer_path = issuer.path().trim_end_matches('/');
    if !issuer_path.is_empty() {
        let path = candidate.path();
        if path != issuer_path && !path.starts_with(&format!("{issuer_path}/")) {
            return None;
        }
    }
    Some(complete.to_string())
}

#[must_use]
pub fn demo_device_authorization(issuer_origin: &str) -> DeviceAuthorization {
    DeviceAuthorization {
        device_code: "IN_MEMORY_ONLY_DEVICE_CODE".into(),
        user_code: "WDJB-MJHT".into(),
        verification_uri: format!("{issuer_origin}/device"),
        verification_uri_complete: validate_verification_uri_complete(
            &format!("{issuer_origin}/device?user_code=WDJB-MJHT"),
            issuer_origin,
        ),
        interval_seconds: 5,
        expires_at: Utc::now() + Duration::minutes(15),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_down_increases_interval() {
        let auth = demo_device_authorization("https://issuer.example");
        let mut state = DevicePollState::new(&auth);
        let err = state
            .next_action(Utc::now(), DeviceServerStatus::SlowDown)
            .unwrap_err();
        assert_eq!(err, DeviceFlowError::SlowDown);
        assert_eq!(state.interval_seconds, 10);
    }

    #[test]
    fn rejects_unsafe_verification_uri_complete() {
        assert!(validate_verification_uri_complete(
            "https://evil.example/device?user_code=X",
            "https://issuer.example"
        )
        .is_none());
    }

    #[test]
    fn a_suffixed_host_does_not_pass_as_the_issuer() {
        // The old prefix comparison accepted every one of these.
        for hostile in [
            "https://issuer.example.evil.test/device?user_code=X",
            "https://issuer.example.evil.test:443/device",
            "https://issuer.example@evil.test/device",
            "https://issuer.example:8443/device",
            "http://issuer.example/device",
        ] {
            assert!(
                validate_verification_uri_complete(hostile, "https://issuer.example").is_none(),
                "{hostile} should not pass as the issuer origin"
            );
        }
        assert!(validate_verification_uri_complete(
            "https://issuer.example/device?user_code=X",
            "https://issuer.example"
        )
        .is_some());
    }

    #[test]
    fn a_path_scoped_issuer_confines_the_ceremony_link() {
        let issuer = "https://idp.example/tenant-a";
        assert!(
            validate_verification_uri_complete("https://idp.example/tenant-a/device", issuer)
                .is_some()
        );
        assert!(
            validate_verification_uri_complete("https://idp.example/tenant-b/device", issuer)
                .is_none()
        );
        // No segment boundary crossing either.
        assert!(
            validate_verification_uri_complete("https://idp.example/tenant-attacker", issuer)
                .is_none()
        );
    }
}
