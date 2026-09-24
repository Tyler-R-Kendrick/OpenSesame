//! Structural + ECDSA P-256 SHA-256 envelope checks matching Pages
//! `peer/envelope.ts` signing input and `WebCrypto` verify semantics.

use std::collections::HashMap;

use base64::Engine;
use ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;

#[derive(Debug, Clone)]
pub struct PeerEnvelopeView {
    pub schema_version: u32,
    pub alg: String,
    pub issuer: String,
    pub audience: String,
    pub principal_ref: String,
    pub vault_ref: String,
    pub device_binding_ref: String,
    pub operation: String,
    pub incident_id: String,
    pub policy_revision: i64,
    pub key_epoch: i64,
    pub nonce: String,
    pub issued_at: String,
    pub expires_at: String,
    pub ciphertext_b64: String,
    pub signature_b64: String,
}

#[derive(Debug, Clone)]
pub struct EnvelopeVerifyExpect {
    pub audience: String,
    pub permitted_operations: Vec<String>,
    pub vault_ref: Option<String>,
    pub now_ms: Option<i64>,
}

/// Future-dated `issuedAt` tolerance — Pages `PEER_BOUNDS.clockSkewMs`.
pub const CLOCK_SKEW_MS: i64 = 5 * 60_000;
/// Longest envelope lifetime accepted — Pages `PEER_BOUNDS.maxTtlMs`.
pub const MAX_TTL_MS: i64 = 24 * 60 * 60_000;

/// Nonces seen, each kept until its envelope expires. An expired envelope is
/// refused on its timestamps before the cache is consulted, so forgetting its
/// nonce reopens nothing — and the cache no longer refuses every envelope once
/// `max` distinct nonces have ever been seen.
pub struct ReplayCache {
    max: usize,
    seen: HashMap<String, i64>,
}

impl ReplayCache {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            seen: HashMap::new(),
        }
    }

    pub fn remember(
        &mut self,
        nonce: &str,
        expires_ms: i64,
        now_ms: i64,
    ) -> Result<(), &'static str> {
        self.seen.retain(|_, expiry| *expiry >= now_ms);
        if self.seen.contains_key(nonce) {
            return Err("ambiguous_trigger");
        }
        if self.seen.len() >= self.max {
            return Err("unsupported_factor");
        }
        self.seen.insert(nonce.to_string(), expires_ms);
        Ok(())
    }
}

/// Timestamps must parse, run forwards, stay within the lifetime bound, not be
/// issued in the future beyond skew, and not have expired.
fn check_window(env: &PeerEnvelopeView, now: i64) -> Result<i64, &'static str> {
    let parse = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|t| t.timestamp_millis())
            .map_err(|_| "unsupported_factor")
    };
    let issued = parse(&env.issued_at)?;
    let expires = parse(&env.expires_at)?;
    if expires <= issued || expires - issued > MAX_TTL_MS {
        return Err("unsupported_factor");
    }
    if expires.saturating_sub(now) > MAX_TTL_MS + CLOCK_SKEW_MS {
        return Err("unsupported_factor");
    }
    if issued > now.saturating_add(CLOCK_SKEW_MS) || expires < now {
        return Err("stale_session");
    }
    Ok(expires)
}

/// Parse an enrolled peer verifying key from SPKI DER (base64) or SEC1 bytes.
pub fn parse_verifying_key_b64(spki_or_sec1_b64: &str) -> Result<VerifyingKey, &'static str> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(spki_or_sec1_b64.trim())
        .map_err(|_| "unavailable_authority")?;
    VerifyingKey::from_public_key_der(&raw)
        .or_else(|_| VerifyingKey::from_sec1_bytes(&raw))
        .map_err(|_| "unavailable_authority")
}

/// Signing input identical to Pages `signingInput` (camelCase JSON, no spaces).
pub fn signing_input_bytes(env: &PeerEnvelopeView) -> Vec<u8> {
    // serde_json::Map preserves insertion order — must match envelope.ts.
    let body = serde_json::json!({
        "schemaVersion": env.schema_version,
        "alg": env.alg,
        "issuer": env.issuer,
        "audience": env.audience,
        "principalRef": env.principal_ref,
        "vaultRef": env.vault_ref,
        "deviceBindingRef": env.device_binding_ref,
        "operation": env.operation,
        "incidentId": env.incident_id,
        "policyRevision": env.policy_revision,
        "keyEpoch": env.key_epoch,
        "nonce": env.nonce,
        "issuedAt": env.issued_at,
        "expiresAt": env.expires_at,
        "ciphertextB64": env.ciphertext_b64,
    });
    serde_json::to_vec(&body).expect("signing input json")
}

fn verify_ecdsa_p256_sha256(
    env: &PeerEnvelopeView,
    verifying_key: &VerifyingKey,
) -> Result<(), &'static str> {
    let sig_raw = base64::engine::general_purpose::STANDARD
        .decode(env.signature_b64.trim())
        .map_err(|_| "unavailable_authority")?;
    // WebCrypto ECDSA P-256 signatures are IEEE P1363 (r||s, 64 bytes).
    let signature = Signature::from_slice(&sig_raw).map_err(|_| "unavailable_authority")?;
    let msg = signing_input_bytes(env);
    verifying_key
        .verify(&msg, &signature)
        .map_err(|_| "unavailable_authority")
}

pub fn verify_envelope_view(
    env: &PeerEnvelopeView,
    expect: &EnvelopeVerifyExpect,
    replay: &mut ReplayCache,
    verifying_key: Option<&VerifyingKey>,
) -> Result<(), &'static str> {
    if env.schema_version != 1 {
        return Err("unsupported_profile_version");
    }
    if env.alg == "none" || env.alg != "ECDSA-P256-SHA256" {
        return Err("unsupported_factor");
    }
    if env.audience != expect.audience {
        return Err("scope_mismatch");
    }
    if let Some(v) = &expect.vault_ref {
        if &env.vault_ref != v {
            return Err("scope_mismatch");
        }
    }
    if !expect
        .permitted_operations
        .iter()
        .any(|o| o == &env.operation)
    {
        return Err("unavailable_authority");
    }
    if env.nonce.len() < 8 || env.nonce.len() > 64 {
        return Err("unsupported_factor");
    }
    if env.ciphertext_b64.len() > 12_000 {
        return Err("unsupported_factor");
    }
    if env.signature_b64.is_empty() {
        return Err("unavailable_authority");
    }
    let now = expect
        .now_ms
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let expires = check_window(env, now)?;

    let Some(vk) = verifying_key else {
        // Fail closed: receiver must not accept unsigned/unkeyed envelopes.
        return Err("unavailable_authority");
    };
    verify_ecdsa_p256_sha256(env, vk)?;

    // Replay only after cryptographic acceptance so forgeries cannot fill the cache.
    replay.remember(&env.nonce, expires, now)?;

    let _ = (
        &env.issuer,
        &env.principal_ref,
        &env.device_binding_ref,
        &env.incident_id,
        env.policy_revision,
        env.key_epoch,
    );
    Ok(())
}

#[cfg(test)]
mod crypto_tests {
    use super::*;
    use ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;

    fn signed_view(sk: &SigningKey) -> PeerEnvelopeView {
        let mut view = PeerEnvelopeView {
            schema_version: 1,
            alg: "ECDSA-P256-SHA256".into(),
            issuer: "peer".into(),
            audience: "recv".into(),
            principal_ref: "p".into(),
            vault_ref: "v".into(),
            device_binding_ref: "d".into(),
            operation: "quarantine_device".into(),
            incident_id: "i".into(),
            policy_revision: 1,
            key_epoch: 1,
            nonce: "nonce-001".into(),
            issued_at: chrono::Utc::now().to_rfc3339(),
            expires_at: (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
            ciphertext_b64: "AAAA".into(),
            signature_b64: String::new(),
        };
        let msg = signing_input_bytes(&view);
        let sig: Signature = sk.sign(&msg);
        view.signature_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        view
    }

    #[test]
    fn ecdsa_accepts_valid_and_rejects_forged() {
        let sk = SigningKey::random(&mut rand_core::OsRng);
        let vk = VerifyingKey::from(&sk);
        let view = signed_view(&sk);
        let expect = EnvelopeVerifyExpect {
            audience: "recv".into(),
            permitted_operations: vec!["quarantine_device".into()],
            vault_ref: None,
            now_ms: None,
        };
        let mut replay = ReplayCache::new(16);
        assert!(verify_envelope_view(&view, &expect, &mut replay, Some(&vk)).is_ok());
        assert_eq!(
            verify_envelope_view(&view, &expect, &mut replay, Some(&vk)).unwrap_err(),
            "ambiguous_trigger"
        );

        let other = SigningKey::random(&mut rand_core::OsRng);
        let mut replay2 = ReplayCache::new(16);
        let mut forged = view.clone();
        forged.nonce = "nonce-002".into();
        let msg = signing_input_bytes(&forged);
        let sig: Signature = other.sign(&msg);
        forged.signature_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        assert_eq!(
            verify_envelope_view(&forged, &expect, &mut replay2, Some(&vk)).unwrap_err(),
            "unavailable_authority"
        );

        let mut replay3 = ReplayCache::new(16);
        assert_eq!(
            verify_envelope_view(&view, &expect, &mut replay3, None).unwrap_err(),
            "unavailable_authority"
        );
    }

    fn resign(sk: &SigningKey, view: &mut PeerEnvelopeView) {
        let sig: Signature = sk.sign(&signing_input_bytes(view));
        view.signature_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    }

    fn expect() -> EnvelopeVerifyExpect {
        EnvelopeVerifyExpect {
            audience: "recv".into(),
            permitted_operations: vec!["quarantine_device".into()],
            vault_ref: None,
            now_ms: None,
        }
    }

    #[test]
    fn future_dated_and_overlong_envelopes_are_refused() {
        let sk = SigningKey::random(&mut rand_core::OsRng);
        let vk = VerifyingKey::from(&sk);
        let now = chrono::Utc::now();
        let mut future = signed_view(&sk);
        future.issued_at = (now + chrono::Duration::hours(1)).to_rfc3339();
        future.expires_at = (now + chrono::Duration::hours(2)).to_rfc3339();
        resign(&sk, &mut future);
        let mut replay = ReplayCache::new(16);
        assert_eq!(
            verify_envelope_view(&future, &expect(), &mut replay, Some(&vk)).unwrap_err(),
            "stale_session"
        );

        let mut forever = signed_view(&sk);
        forever.expires_at = (now + chrono::Duration::days(3650)).to_rfc3339();
        resign(&sk, &mut forever);
        assert_eq!(
            verify_envelope_view(&forever, &expect(), &mut replay, Some(&vk)).unwrap_err(),
            "unsupported_factor"
        );

        let mut backwards = signed_view(&sk);
        backwards.issued_at = (now + chrono::Duration::seconds(90)).to_rfc3339();
        resign(&sk, &mut backwards);
        assert_eq!(
            verify_envelope_view(&backwards, &expect(), &mut replay, Some(&vk)).unwrap_err(),
            "unsupported_factor"
        );
    }

    #[test]
    fn replay_cache_evicts_expired_nonces_instead_of_filling_up() {
        let mut replay = ReplayCache::new(2);
        replay.remember("nonce-aaa", 1_000, 0).unwrap();
        replay.remember("nonce-bbb", 1_000, 0).unwrap();
        assert_eq!(
            replay.remember("nonce-ccc", 5_000, 500).unwrap_err(),
            "unsupported_factor"
        );
        assert_eq!(
            replay.remember("nonce-aaa", 1_000, 500).unwrap_err(),
            "ambiguous_trigger"
        );
        // Once the first two have expired they no longer hold a slot.
        replay.remember("nonce-ccc", 5_000, 1_001).unwrap();
        replay.remember("nonce-ddd", 5_000, 1_001).unwrap();
        assert_eq!(
            replay.remember("nonce-ccc", 5_000, 1_002).unwrap_err(),
            "ambiguous_trigger"
        );
    }
}
