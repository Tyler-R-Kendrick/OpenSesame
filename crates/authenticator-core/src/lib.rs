//! Shared security boundary for native authenticator providers.
//!
//! Platform adapters own OS registration and biometric prompts. This crate
//! owns request classification, verified-link validation, fresh user
//! verification, and secret-free credential metadata.

#[cfg(feature = "ffi")]
uniffi::setup_scaffolding!();

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

mod request_host;

mod invocation_scheme;

mod otp;
pub use otp::{
    find_otpauth_in_trailer, hotp_code, parse_hotp, parse_otpauth, parse_totp, sync_trailer_otp,
    totp_code, validate_otpauth, OtpAlgorithm, OtpError, OtpKind, OtpUri,
};

const MAX_REQUEST_ID_LEN: usize = 128;
const MAX_USER_CODE_LEN: usize = 64;
const MAX_VERIFICATION_AGE_SECONDS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    SdJwtVc,
    Mdoc,
}

/// Metadata visible to native selection surfaces. Secret material remains in
/// the encrypted vault item addressed by `encrypted_payload_ref`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialMetadata {
    pub id: String,
    pub kind: CredentialKind,
    pub display_name: String,
    pub relying_party: Option<String>,
    pub username: Option<String>,
    pub issuer: Option<String>,
    pub credential_type: Option<String>,
    pub encrypted_payload_ref: String,
    pub device_bound: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
#[serde(rename_all = "snake_case")]
pub enum InvocationKind {
    MfaApproval,
    Oid4vp,
    Oid4vci,
}

/// Stable platform-facing result. Native adapters only translate this record
/// into the operating system's request type; they do not re-parse links.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PlatformInvocation {
    pub kind: InvocationKind,
    pub payload: String,
    /// Standard protocol URI passed to Multipaz after policy validation.
    pub protocol_uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvocationPayload {
    RequestId(String),
    UserCode(String),
    RequestUri(Url),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedInvocation {
    pub kind: InvocationKind,
    pub payload: InvocationPayload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationPolicy {
    /// Exact HTTPS origin associated with the signed native applications.
    pub authenticator_origin: Url,
    /// Development-only escape hatch. Production must leave this false.
    pub allow_private_request_uris: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserVerificationMethod {
    Biometric,
    DeviceCredential,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserVerification {
    pub device_id: String,
    pub verified_at_unix: u64,
    pub method: UserVerificationMethod,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Error))]
pub enum AuthenticatorError {
    #[error("authenticator origin must be an HTTPS origin without credentials, path, query, or fragment")]
    InvalidAuthenticatorOrigin,
    #[error("invocation is not from the configured verified-link origin")]
    UnverifiedInvocationOrigin,
    #[error("unsupported authenticator invocation path")]
    UnsupportedInvocation,
    #[error("invocation contains a forbidden parameter")]
    ForbiddenInvocationParameter,
    #[error("invocation must contain exactly one supported payload")]
    InvalidInvocationPayload,
    #[error("invocation payload is malformed")]
    InvalidInvocationPayloadValue,
    #[error("request URI must use HTTPS")]
    InsecureRequestUri,
    #[error("private or loopback request URI is forbidden")]
    PrivateRequestUri,
    #[error("fresh platform user verification is required")]
    UserVerificationRequired,
    #[error("platform user verification belongs to another device")]
    WrongDevice,
}

/// Validate and classify a native invocation using the shared policy engine.
///
/// # Errors
///
/// Returns a stable policy error for malformed, unassociated, or unsafe links.
#[cfg_attr(feature = "ffi", uniffi::export)]
// The owned `String` parameters are required by the `uniffi::export` above:
// UniFFI's generated bindings pass owned values across the FFI boundary. The
// signature is the same with or without the `ffi` feature, so the allow must
// be unconditional too — gating it on `feature = "ffi"` left the lint firing
// in every default-feature build, which is what `pnpm audit:clippy` runs.
#[allow(clippy::needless_pass_by_value)]
pub fn validate_platform_invocation(
    authenticator_origin: String,
    raw: String,
) -> Result<PlatformInvocation, AuthenticatorError> {
    let invocation = InvocationPolicy::new(&authenticator_origin)?.validate_link(&raw)?;
    let payload = match invocation.payload {
        InvocationPayload::RequestId(value) | InvocationPayload::UserCode(value) => value,
        InvocationPayload::RequestUri(value) => value.to_string(),
    };
    let protocol_uri = match invocation.kind {
        InvocationKind::MfaApproval => raw,
        InvocationKind::Oid4vp => protocol_uri("openid4vp", "request_uri", &payload),
        InvocationKind::Oid4vci => {
            protocol_uri("openid-credential-offer", "credential_offer_uri", &payload)
        }
    };
    Ok(PlatformInvocation {
        kind: invocation.kind,
        payload,
        protocol_uri,
    })
}

/// Validate a custom-scheme credential-offer handoff before wallet provisioning.
///
/// # Errors
///
/// Rejects inline offers, forbidden parameters, and private request URIs.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn validate_credential_offer_scheme_handoff(
    authenticator_origin: String,
    raw: String,
) -> Result<String, AuthenticatorError> {
    let policy = InvocationPolicy::new(&authenticator_origin)?;
    policy.validate_credential_offer_scheme(&raw)
}

/// Validate a custom-scheme OID4VP handoff before presentment.
///
/// # Errors
///
/// Rejects forbidden parameters and private request URIs.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn validate_presentation_scheme_handoff(
    authenticator_origin: String,
    raw: String,
) -> Result<String, AuthenticatorError> {
    let policy = InvocationPolicy::new(&authenticator_origin)?;
    policy.validate_presentation_scheme(&raw)
}

fn protocol_uri(scheme: &str, key: &str, value: &str) -> String {
    let encoded = url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    format!("{scheme}://?{key}={encoded}")
}

impl InvocationPolicy {
    /// Construct a policy for the one production origin associated with the
    /// signed app. Separate managed builds use separate policies.
    ///
    /// # Errors
    ///
    /// Rejects anything other than a bare HTTPS origin.
    pub fn new(authenticator_origin: &str) -> Result<Self, AuthenticatorError> {
        let origin = Url::parse(authenticator_origin)
            .map_err(|_| AuthenticatorError::InvalidAuthenticatorOrigin)?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(AuthenticatorError::InvalidAuthenticatorOrigin);
        }
        Ok(Self {
            authenticator_origin: origin,
            allow_private_request_uris: false,
        })
    }

    /// Validate a vendor HTTPS invocation. Only opaque one-time handles or a
    /// by-reference protocol request are accepted; bearer material and inline
    /// credential offers are deliberately excluded.
    ///
    /// # Errors
    ///
    /// Rejects unassociated origins, unknown paths/parameters, and unsafe
    /// request URIs.
    pub fn validate_link(&self, raw: &str) -> Result<VerifiedInvocation, AuthenticatorError> {
        let url = Url::parse(raw).map_err(|_| AuthenticatorError::UnverifiedInvocationOrigin)?;
        if url.scheme() != "https" || url.origin() != self.authenticator_origin.origin() {
            return Err(AuthenticatorError::UnverifiedInvocationOrigin);
        }
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(AuthenticatorError::ForbiddenInvocationParameter);
        }

        let kind = match url.path() {
            "/invoke/mfa" => InvocationKind::MfaApproval,
            "/invoke/oid4vp" => InvocationKind::Oid4vp,
            "/invoke/oid4vci" => InvocationKind::Oid4vci,
            _ => return Err(AuthenticatorError::UnsupportedInvocation),
        };

        let pairs: Vec<_> = url.query_pairs().collect();
        if pairs.iter().any(|(key, _)| {
            matches!(
                key.as_ref(),
                "token"
                    | "access_token"
                    | "id_token"
                    | "code"
                    | "credential_offer"
                    | "password"
                    | "secret"
            )
        }) {
            return Err(AuthenticatorError::ForbiddenInvocationParameter);
        }

        let request_id = single_value(&pairs, "request_id")?;
        let user_code = single_value(&pairs, "user_code")?;
        let request_uri = single_value(&pairs, "request_uri")?;
        if pairs
            .iter()
            .any(|(key, _)| !matches!(key.as_ref(), "request_id" | "user_code" | "request_uri"))
        {
            return Err(AuthenticatorError::ForbiddenInvocationParameter);
        }

        let payload = match (kind, request_id, user_code, request_uri) {
            (InvocationKind::MfaApproval, Some(id), None, None) => {
                InvocationPayload::RequestId(validate_handle(id, MAX_REQUEST_ID_LEN)?)
            }
            (InvocationKind::MfaApproval, None, Some(code), None) => {
                InvocationPayload::UserCode(validate_handle(code, MAX_USER_CODE_LEN)?)
            }
            (
                InvocationKind::Oid4vp | InvocationKind::Oid4vci,
                None,
                None,
                Some(request_uri_value),
            ) => InvocationPayload::RequestUri(self.validate_request_uri(request_uri_value)?),
            _ => return Err(AuthenticatorError::InvalidInvocationPayload),
        };

        Ok(VerifiedInvocation { kind, payload })
    }
}

/// Enforce a fresh platform prompt for every provider or wallet operation.
///
/// # Errors
///
/// Rejects missing, stale, future-dated, or wrong-device verification.
pub fn require_fresh_user_verification(
    verification: Option<&UserVerification>,
    expected_device_id: &str,
    now_unix: u64,
) -> Result<(), AuthenticatorError> {
    let verification = verification.ok_or(AuthenticatorError::UserVerificationRequired)?;
    if verification.device_id != expected_device_id {
        return Err(AuthenticatorError::WrongDevice);
    }
    let age = now_unix.checked_sub(verification.verified_at_unix);
    if age.is_none_or(|seconds| seconds > MAX_VERIFICATION_AGE_SECONDS) {
        return Err(AuthenticatorError::UserVerificationRequired);
    }
    Ok(())
}

pub(crate) fn single_value<'a>(
    pairs: &'a [(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)],
    key: &str,
) -> Result<Option<&'a str>, AuthenticatorError> {
    let mut values = pairs
        .iter()
        .filter(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.as_ref());
    let first = values.next();
    if values.next().is_some() {
        return Err(AuthenticatorError::InvalidInvocationPayload);
    }
    Ok(first)
}

fn validate_handle(raw: &str, max_len: usize) -> Result<String, AuthenticatorError> {
    if raw.is_empty()
        || raw.len() > max_len
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AuthenticatorError::InvalidInvocationPayloadValue);
    }
    Ok(raw.to_owned())
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
