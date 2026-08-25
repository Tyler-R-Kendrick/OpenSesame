//! keepassxc-protocol wire types, error codes, and nonce arithmetic.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::BridgeError;

/// Version string reported to the extension.
///
/// The extension gates features on the peer's version string, so this has to
/// be a `KeePassXC` version number rather than an `OpenSesame` one. 2.7.0 is the
/// floor at which every action this bridge implements exists.
pub const PROTOCOL_VERSION: &str = "2.7.0";

/// Nonces are 24 bytes — the XSalsa20-Poly1305 nonce width.
pub const NONCE_LEN: usize = 24;

/// Cap on one decrypted inner message. The outer frame is already capped by
/// [`crate::framing::MAX_MESSAGE_BYTES`]; this bounds the JSON we will parse
/// after decryption.
pub const MAX_INNER_BYTES: usize = 512 * 1024;

/// Error codes from the extension's public error table.
///
/// The extension renders its own message per code; the `error` string a
/// server sends is informational. Only the codes this bridge can actually
/// emit are listed — inventing numbers it never uses would be noise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum ErrorCode {
    /// The database is not open — also the documented reply to a successful
    /// `lock-database`.
    DatabaseNotOpened = 1,
    /// No client public key has been exchanged yet.
    ClientPublicKeyNotReceived = 3,
    /// The box did not open, or the envelope was malformed.
    CannotDecryptMessage = 4,
    /// The human refused, or no pairing window was open.
    ActionCancelledOrDenied = 6,
    /// The client is not associated with this store.
    AssociationFailed = 8,
    /// Key exchange failed.
    KeyChangeFailed = 9,
    /// The presented identification key is not one we know.
    EncryptionKeyUnrecognized = 10,
    /// Unknown or unsupported action.
    IncorrectAction = 12,
    /// The decrypted message had no content.
    EmptyMessageReceived = 13,
    /// The request carried no URL.
    NoUrlProvided = 14,
    /// Nothing in the store matched.
    NoLoginsFound = 15,
    /// No groups to report.
    NoGroupsFound = 16,
    /// The referenced entry id is unknown.
    NoValidUuidProvided = 18,
}

impl ErrorCode {
    #[must_use]
    pub fn code(self) -> u16 {
        self as u16
    }

    /// A short, non-secret explanation. Never derived from entry contents.
    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            ErrorCode::DatabaseNotOpened => "Database not opened",
            ErrorCode::ClientPublicKeyNotReceived => "Client public key not received",
            ErrorCode::CannotDecryptMessage => "Cannot decrypt message",
            ErrorCode::ActionCancelledOrDenied => "Action cancelled or denied",
            ErrorCode::AssociationFailed => "KeePassXC association failed, try again",
            ErrorCode::KeyChangeFailed => "Key change was not successful",
            ErrorCode::EncryptionKeyUnrecognized => "Encryption key is not recognized",
            ErrorCode::IncorrectAction => "Incorrect action",
            ErrorCode::EmptyMessageReceived => "Empty message received",
            ErrorCode::NoUrlProvided => "No URL provided",
            ErrorCode::NoLoginsFound => "No logins found",
            ErrorCode::NoGroupsFound => "No groups found",
            ErrorCode::NoValidUuidProvided => "No valid UUID provided",
        }
    }
}

/// The outer envelope, in both directions.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Envelope {
    pub action: String,
    /// Base64 `NaCl` box. Absent on `change-public-keys`, `generate-password`,
    /// and on unencrypted error replies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(rename = "clientID", skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Present only on `change-public-keys`.
    #[serde(rename = "publicKey", skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// Optional correlation id; the extension uses it for `generate-password`.
    #[serde(rename = "requestID", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// The extension asks the peer to prompt for an unlock. This bridge has
    /// no GUI, so it is parsed and ignored.
    #[serde(rename = "triggerUnlock", skip_serializing_if = "Option::is_none")]
    pub trigger_unlock: Option<Value>,
}

/// Parse an envelope, rejecting anything that is not a JSON object.
///
/// # Errors
///
/// Returns an error for oversized, malformed, or non-object JSON input.
pub fn parse_envelope(bytes: &[u8]) -> Result<Envelope, BridgeError> {
    if bytes.len() > MAX_INNER_BYTES {
        return Err(BridgeError::Protocol("envelope too large".into()));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|e| BridgeError::Protocol(format!("malformed envelope: {e}")))?;
    if !value.is_object() {
        return Err(BridgeError::Protocol("envelope is not an object".into()));
    }
    serde_json::from_value(value)
        .map_err(|e| BridgeError::Protocol(format!("malformed envelope: {e}")))
}

/// Build the unencrypted error reply `KeePassXC` sends on a rejected request.
///
/// `errorCode` is a **string** on the wire — that is what the extension
/// parses, and matching it exactly is the difference between a useful error
/// and a hung extension.
#[must_use]
pub fn error_reply(action: &str, code: ErrorCode, nonce: Option<&str>) -> Value {
    let mut value = json!({
        "action": action,
        "errorCode": code.code().to_string(),
        "error": code.message(),
    });
    if let Some(nonce) = nonce {
        value["nonce"] = Value::String(nonce.to_string());
    }
    value
}

/// Decode base64 with a length expectation.
///
/// # Errors
///
/// Returns an error for invalid base64 or an unexpected decoded length.
pub fn decode_b64(value: &str, expected_len: Option<usize>) -> Result<Vec<u8>, BridgeError> {
    let bytes = B64
        .decode(value.trim())
        .map_err(|_| BridgeError::Protocol("invalid base64".into()))?;
    if let Some(len) = expected_len {
        if bytes.len() != len {
            return Err(BridgeError::Protocol(format!(
                "expected {len} bytes, got {}",
                bytes.len()
            )));
        }
    }
    Ok(bytes)
}

#[must_use]
pub fn encode_b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

/// Increment a 24-byte nonce as a little-endian integer, with carry.
///
/// This is libsodium's `sodium_increment`, which is what both `KeePassXC` and
/// the extension use to derive a reply nonce. Wrapping past all-ones is
/// mathematically correct and, at 2^192 messages, unreachable.
#[must_use]
pub fn increment_nonce(nonce: &[u8]) -> Vec<u8> {
    let mut out = nonce.to_vec();
    let mut carry: u16 = 1;
    for byte in &mut out {
        carry += u16::from(*byte);
        *byte = (carry & 0xff) as u8;
        carry >>= 8;
    }
    out
}

/// Increment a base64 nonce, validating its width.
///
/// # Errors
///
/// Returns an error when the nonce is invalid base64 or is not 24 bytes.
pub fn increment_nonce_b64(nonce_b64: &str) -> Result<String, BridgeError> {
    let bytes = decode_b64(nonce_b64, Some(NONCE_LEN))?;
    Ok(encode_b64(&increment_nonce(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn increments_a_nonce_little_endian() {
        assert_eq!(increment_nonce(&[0u8; 4]), vec![1, 0, 0, 0]);
        assert_eq!(increment_nonce(&[0xff, 0, 0, 0]), vec![0, 1, 0, 0]);
        assert_eq!(increment_nonce(&[0xff, 0xff, 0, 0]), vec![0, 0, 1, 0]);
        // Full wrap stays in range rather than panicking.
        assert_eq!(increment_nonce(&[0xff; 3]), vec![0, 0, 0]);
        assert_eq!(increment_nonce(&[]), Vec::<u8>::new());
    }

    #[test]
    fn increments_a_base64_nonce_and_checks_width() {
        let nonce = encode_b64(&[0u8; NONCE_LEN]);
        let next = increment_nonce_b64(&nonce).unwrap();
        assert_eq!(decode_b64(&next, Some(NONCE_LEN)).unwrap()[0], 1);
        assert!(increment_nonce_b64(&encode_b64(&[0u8; 8])).is_err());
        assert!(increment_nonce_b64("!!!not base64").is_err());
    }

    #[test]
    fn error_reply_matches_the_documented_shape() {
        let value = error_reply("associate", ErrorCode::ActionCancelledOrDenied, Some("N"));
        assert_eq!(value["action"], "associate");
        assert_eq!(value["errorCode"], "6");
        assert_eq!(value["error"], "Action cancelled or denied");
        assert_eq!(value["nonce"], "N");
        assert!(error_reply("x", ErrorCode::IncorrectAction, None)
            .get("nonce")
            .is_none());
    }

    #[test]
    fn every_error_code_has_a_message() {
        for code in [
            ErrorCode::DatabaseNotOpened,
            ErrorCode::ClientPublicKeyNotReceived,
            ErrorCode::CannotDecryptMessage,
            ErrorCode::ActionCancelledOrDenied,
            ErrorCode::AssociationFailed,
            ErrorCode::KeyChangeFailed,
            ErrorCode::EncryptionKeyUnrecognized,
            ErrorCode::IncorrectAction,
            ErrorCode::EmptyMessageReceived,
            ErrorCode::NoUrlProvided,
            ErrorCode::NoLoginsFound,
            ErrorCode::NoGroupsFound,
            ErrorCode::NoValidUuidProvided,
        ] {
            assert!(!code.message().is_empty());
            assert!(code.code() > 0);
        }
    }

    #[test]
    fn parses_an_envelope_and_rejects_junk() {
        let env =
            parse_envelope(br#"{"action":"associate","message":"m","nonce":"n","clientID":"c"}"#)
                .unwrap();
        assert_eq!(env.action, "associate");
        assert_eq!(env.message.as_deref(), Some("m"));
        assert_eq!(env.client_id.as_deref(), Some("c"));

        assert!(parse_envelope(b"[]").is_err());
        assert!(parse_envelope(b"not json").is_err());
        assert!(parse_envelope(b"3").is_err());
        assert!(parse_envelope(&vec![b'x'; MAX_INNER_BYTES + 1]).is_err());
    }

    #[test]
    fn envelope_omits_absent_fields_when_serialized() {
        let env = Envelope {
            action: "hash".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&env).unwrap();
        assert_eq!(json, r#"{"action":"hash"}"#);
    }

    #[test]
    fn base64_helpers_validate_length() {
        assert!(decode_b64(&encode_b64(&[1, 2, 3]), Some(3)).is_ok());
        assert!(decode_b64(&encode_b64(&[1, 2, 3]), Some(4)).is_err());
        assert!(decode_b64("****", None).is_err());
    }
}
