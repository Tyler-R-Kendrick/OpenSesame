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

pub fn validate_verification_uri_complete(complete: &str, issuer_origin: &str) -> Option<String> {
    if complete.starts_with(issuer_origin) {
        Some(complete.to_string())
    } else {
        None
    }
}

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
}
