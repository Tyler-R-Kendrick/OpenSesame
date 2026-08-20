//! GitHub webhook `X-Hub-Signature-256` verification (HMAC-SHA256).

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Verify GitHub's `sha256=<hex>` signature header against `body` and `secret`.
///
/// Constant-time compare on the MAC bytes. Missing/malformed headers fail closed.
pub fn verify_hub_signature_256(secret: &str, body: &[u8], signature_header: &str) -> bool {
    let Some(hex) = signature_header
        .strip_prefix("sha256=")
        .or_else(|| signature_header.strip_prefix("SHA256="))
    else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    let expected = mac.finalize().into_bytes();
    let Ok(provided) = hex::decode(hex) else {
        return false;
    };
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .iter()
        .zip(provided.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Compute `sha256=<hex>` for tests and fuzz oracles.
pub fn sign_hub_signature_256(secret: &str, body: &[u8]) -> Option<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(body);
    Some(format!(
        "sha256={}",
        hex::encode(mac.finalize().into_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_accepts_and_rejects_tamper() {
        let secret = "whsec_test";
        let body = br#"{"action":"created","installation":{"id":1}}"#;
        let header = sign_hub_signature_256(secret, body).unwrap();
        assert!(verify_hub_signature_256(secret, body, &header));
        let mut bad = body.to_vec();
        bad[0] ^= 0xff;
        assert!(!verify_hub_signature_256(secret, &bad, &header));
        assert!(!verify_hub_signature_256(secret, body, "sha256=00"));
        assert!(!verify_hub_signature_256(secret, body, "not-a-sig"));
    }
}
