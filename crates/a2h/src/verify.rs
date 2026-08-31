//! Verifying the reply an A2H gateway posts back.
//!
//! The gateway is a third party in the path between a run and the person who
//! owns it, so nothing it sends is taken on trust. Four checks, in order, and
//! each one closes a distinct way a forged reply could cancel somebody's
//! rotation:
//!
//! 1. the callback HMAC, in constant time;
//! 2. the timestamp, inside a tolerance, so a captured signature does not stay
//!    valid;
//! 3. `responds_to`, against the message we actually sent;
//! 4. the delivery id, for idempotency, because the transport is at-least-once
//!    by design.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq as _;

use crate::envelope::A2hResponse;

type HmacSha256 = Hmac<Sha256>;

/// Signing secret prefix, shared with the outbound Standard Webhooks path so
/// one secret convention covers both directions.
pub const SECRET_PREFIX: &str = "whsec_";

/// Signature scheme version in the `X-A2H-Signature` header.
pub const SIGNATURE_VERSION: &str = "v1";

/// How far a callback's timestamp may be from ours.
///
/// Five minutes, matching the Standard Webhooks tolerance this repo already
/// uses. Beyond it a captured request is refused, so a signature that leaked
/// from a proxy log stops being a working cancel button.
pub const TIMESTAMP_TOLERANCE_SECONDS: i64 = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    #[error("signature header is malformed")]
    MalformedHeader,
    #[error("signing secret is unusable")]
    UnusableSecret,
    #[error("signature does not match")]
    BadSignature,
    #[error("timestamp is outside the accepted tolerance")]
    StaleTimestamp,
    #[error("reply does not answer a message we sent")]
    UnknownIntent,
    #[error("this delivery was already applied")]
    Duplicate,
}

/// The parsed `X-A2H-Signature: t=<unix>,v1=<base64>` header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureHeader {
    pub timestamp: i64,
    pub value: String,
}

/// Parse the header without deciding anything about it.
///
/// # Errors
///
/// [`VerifyError::MalformedHeader`] when either part is missing or unparseable.
pub fn parse_signature(header: &str) -> Result<SignatureHeader, VerifyError> {
    let mut timestamp = None;
    let mut value = None;
    for part in header.split(',') {
        let (key, raw) = part
            .trim()
            .split_once('=')
            .ok_or(VerifyError::MalformedHeader)?;
        match key {
            "t" => timestamp = raw.parse::<i64>().ok(),
            SIGNATURE_VERSION => value = Some(raw.to_string()),
            _ => {}
        }
    }
    match (timestamp, value) {
        (Some(timestamp), Some(value)) => Ok(SignatureHeader { timestamp, value }),
        _ => Err(VerifyError::MalformedHeader),
    }
}

/// Compute the expected signature over `{timestamp}.{body}`.
///
/// # Errors
///
/// [`VerifyError::UnusableSecret`] when the secret lacks the `whsec_` prefix or
/// its body is not base64.
pub fn sign(secret: &str, timestamp: i64, body: &str) -> Result<String, VerifyError> {
    let encoded = secret
        .strip_prefix(SECRET_PREFIX)
        .ok_or(VerifyError::UnusableSecret)?;
    let key = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| VerifyError::UnusableSecret)?;
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(&key).map_err(|_| VerifyError::UnusableSecret)?;
    mac.update(format!("{timestamp}.{body}").as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

/// What the caller knows about the interaction being answered.
#[derive(Clone, Copy, Debug)]
pub struct ExpectedReply<'a> {
    /// The `message_id` we sent.
    pub message_id: &'a str,
    /// Whether this delivery id has already been applied.
    pub already_applied: bool,
    /// Our clock, as a unix timestamp.
    pub now_unix: i64,
}

/// Verify one callback end to end.
///
/// # Errors
///
/// A [`VerifyError`] naming which check failed. The checks run signature-first
/// on purpose: an unsigned request must not be able to learn, from the shape of
/// the refusal, whether a given `message_id` exists.
pub fn verify_callback(
    secret: &str,
    signature_header: &str,
    body: &str,
    response: &A2hResponse,
    expected: &ExpectedReply<'_>,
) -> Result<(), VerifyError> {
    let parsed = parse_signature(signature_header)?;
    let expected_signature = sign(secret, parsed.timestamp, body)?;
    if expected_signature
        .as_bytes()
        .ct_eq(parsed.value.as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err(VerifyError::BadSignature);
    }
    if (expected.now_unix - parsed.timestamp).abs() > TIMESTAMP_TOLERANCE_SECONDS {
        return Err(VerifyError::StaleTimestamp);
    }
    if response.responds_to != expected.message_id {
        return Err(VerifyError::UnknownIntent);
    }
    if expected.already_applied {
        return Err(VerifyError::Duplicate);
    }
    Ok(())
}
