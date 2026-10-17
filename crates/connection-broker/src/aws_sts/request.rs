//! The `AssumeRole` parameters one mint sends, derived and checked here.
//!
//! - `DurationSeconds` defaults to 900 (STS's minimum), may be asked for up to
//!   the binding's cap, and the cap itself never exceeds 3600. A request above
//!   the cap is refused, not clamped: a caller that asked for an hour must not
//!   silently get fifteen minutes.
//! - `RoleSessionName` is derived from the mint's grant id, so `CloudTrail`'s
//!   session name and the Host's receipt name the same mint.
//! - `SourceIdentity` is the calling principal, encoded into STS's charset
//!   without losing which principal it was.
//! - `Policy` and `ExternalId` come from the binding, never from the caller.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use url::form_urlencoded;
use zeroize::Zeroizing;

/// STS's floor, and the default when a caller asks for nothing.
pub const MIN_DURATION_SECONDS: u32 = 900;
/// The Host's ceiling for any binding's cap, whatever the role allows.
pub const MAX_DURATION_SECONDS: u32 = 3600;
/// `RoleSessionName` and `SourceIdentity` are at most 64 characters.
const MAX_NAME: usize = 64;
const SESSION_PREFIX: &str = "opensesame-";
const VERSION: &str = "2011-06-15";

/// Whether `value` is in STS's name charset (`[\w+=,.@-]`), 2..=64 long.
#[must_use]
pub fn valid_sts_name(value: &str) -> bool {
    (2..=MAX_NAME).contains(&value.len()) && value.bytes().all(sts_name_byte)
}

fn sts_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'=' | b',' | b'.' | b'@' | b'-')
}

/// The duration to ask for: `requested` or the default, refused outside
/// `MIN_DURATION_SECONDS..=cap`.
///
/// # Errors
///
/// A fixed sentence naming the bound that was crossed.
pub fn duration_for(requested: Option<u32>, cap: u32) -> Result<u32, &'static str> {
    let cap = cap.min(MAX_DURATION_SECONDS);
    let duration = requested.unwrap_or(MIN_DURATION_SECONDS);
    if duration < MIN_DURATION_SECONDS {
        return Err("duration_seconds is below STS's minimum of 900");
    }
    if duration > cap {
        return Err("duration_seconds exceeds the binding's cap");
    }
    Ok(duration)
}

/// `RoleSessionName` for the mint `grant_id`.
///
/// # Errors
///
/// When the grant id would leave STS's charset or length.
pub fn session_name(grant_id: &str) -> Result<String, &'static str> {
    let name = format!("{SESSION_PREFIX}{grant_id}");
    if valid_sts_name(&name) {
        Ok(name)
    } else {
        Err("the mint's grant id is not a valid STS session name")
    }
}

/// `SourceIdentity` for the calling principal.
///
/// A principal already in STS's charset is used as it is. Otherwise every
/// byte outside it — `=` included, so the encoding cannot collide — becomes
/// `=XX`; a result past 64 characters keeps its first 40 and appends `.` and
/// 23 hex characters of its SHA-256, which still names one principal.
#[must_use]
pub fn source_identity(principal: &str) -> String {
    let mut encoded = String::with_capacity(principal.len());
    for byte in principal.bytes() {
        if sts_name_byte(byte) && byte != b'=' {
            encoded.push(char::from(byte));
        } else {
            encoded.push('=');
            encoded.push_str(&hex::encode_upper([byte]));
        }
    }
    if encoded.len() < 2 {
        encoded.push_str("==");
    }
    if encoded.len() <= MAX_NAME {
        return encoded;
    }
    let digest = hex::encode(Sha256::digest(encoded.as_bytes()));
    format!("{}.{}", &encoded[..40], &digest[..23])
}

/// One `AssumeRole` call, ready to encode.
pub struct AssumeRoleRequest {
    pub role_arn: String,
    pub role_session_name: String,
    pub duration_seconds: u32,
    pub policy: Option<String>,
    pub source_identity: String,
    pub external_id: Option<SecretString>,
}

impl fmt::Debug for AssumeRoleRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AssumeRoleRequest")
            .field("role_arn", &self.role_arn)
            .field("role_session_name", &self.role_session_name)
            .field("duration_seconds", &self.duration_seconds)
            .field("policy", &self.policy.is_some())
            .field("source_identity", &self.source_identity)
            .field(
                "external_id",
                &self.external_id.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl AssumeRoleRequest {
    /// The form body, `application/x-www-form-urlencoded`. Held zeroized: it
    /// carries the `ExternalId`.
    #[must_use]
    pub fn form_body(&self) -> Zeroizing<String> {
        let mut form = form_urlencoded::Serializer::new(String::new());
        form.append_pair("Action", "AssumeRole")
            .append_pair("Version", VERSION)
            .append_pair("RoleArn", &self.role_arn)
            .append_pair("RoleSessionName", &self.role_session_name)
            .append_pair("DurationSeconds", &self.duration_seconds.to_string())
            .append_pair("SourceIdentity", &self.source_identity);
        if let Some(policy) = &self.policy {
            form.append_pair("Policy", policy);
        }
        if let Some(external_id) = &self.external_id {
            form.append_pair("ExternalId", external_id.expose_secret());
        }
        Zeroizing::new(form.finish())
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
