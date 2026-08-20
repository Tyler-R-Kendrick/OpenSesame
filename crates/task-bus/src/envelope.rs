//! Optional xkeys envelopes for sensitive TaskBus `data` fields.
//!
//! Wake messages that carry only outbox ids stay unsealed. Use this when a
//! payload must cross the bus and is not already ciphertext-at-rest.
//!
//! **Never** seal with the Host connection / deployment seal key — that is
//! fake E2EE (ADR 0042). Callers pass recipient X25519 public keys only.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SealedEventData {
    /// Versioned xkeys seal blob (base64).
    pub sealed_b64: String,
}

/// Seal UTF-8 JSON bytes to `recipient_public` (32-byte X25519).
pub fn seal_event_data(
    plaintext: &[u8],
    recipient_public: &[u8; 32],
) -> anyhow::Result<SealedEventData> {
    let pk = x25519_dalek::PublicKey::from(*recipient_public);
    let sealed = opensesame_xkeys::seal(plaintext, &pk).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(SealedEventData {
        sealed_b64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &sealed),
    })
}

/// Open a sealed envelope with the recipient secret key bytes.
pub fn open_event_data(
    sealed: &SealedEventData,
    recipient_secret: &[u8; 32],
) -> anyhow::Result<Vec<u8>> {
    let blob = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &sealed.sealed_b64,
    )
    .map_err(|e| anyhow::anyhow!("sealed_b64: {e}"))?;
    let kp = opensesame_xkeys::XKeyPair::from_secret_bytes(*recipient_secret);
    opensesame_xkeys::open(&blob, &kp).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Convenience: wrap sealed bytes as JSON `{ "sealed_b64": "..." }`.
pub fn sealed_to_json(sealed: &SealedEventData) -> Value {
    json!({ "sealed_b64": sealed.sealed_b64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_json_payload() {
        let fixed = [9u8; 32];
        let kp = opensesame_xkeys::XKeyPair::from_secret_bytes(fixed);
        let plain = br#"{"outbox_id":"o1"}"#;
        let sealed = seal_event_data(plain, &kp.public_bytes()).unwrap();
        assert_eq!(open_event_data(&sealed, &fixed).unwrap(), plain);
        let _ = sealed_to_json(&sealed);
    }

    #[test]
    fn tampered_sealed_blob_fails_open() {
        let fixed = [9u8; 32];
        let kp = opensesame_xkeys::XKeyPair::from_secret_bytes(fixed);
        let plain = br#"{"secret":"value"}"#;
        let mut sealed = seal_event_data(plain, &kp.public_bytes()).unwrap();
        sealed.sealed_b64.push('!');
        assert!(open_event_data(&sealed, &fixed).is_err());
    }

    #[test]
    fn production_envelope_path_uses_xkeys_only() {
        // Production helpers (above this tests module) must seal via xkeys,
        // never Host deployment / connection seal env material.
        let src = include_str!("envelope.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(production.contains("opensesame_xkeys::seal"));
        assert!(production.contains("opensesame_xkeys::open"));
        assert!(!production.contains("std::env::var"));
        assert!(!production.contains("OPENSESAME_CONNECTION_KEY"));
    }
}
