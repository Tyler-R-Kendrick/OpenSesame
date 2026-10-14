//! Human proof tokens minted in Pages after PIN or passkey unlock (`oschip2:` + signature).

use crate::device_crypto::{
    approval_challenge_digest, parse_verifying_key_spki_b64, verify_p256_sha256,
};
use crate::pairing::PairedBinding;
use crate::webauthn_assertion::verify_passkey_assertion;

const PROOF_PREFIX: &str = "oschip2:";

/// `None` = refused; `Some(None)` = PIN; `Some(Some(n))` = passkey with new sign count.
pub(crate) fn human_proof_verify(
    proof: &str,
    binding: &PairedBinding,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> Option<Option<u32>> {
    if binding.pin_proof_failures >= crate::pairing::MAX_PIN_PROOF_FAILURES {
        return None;
    }
    let t = proof.trim();
    let Some(rest) = t.strip_prefix(PROOF_PREFIX) else {
        return None;
    };
    let challenge = approval_challenge_digest(request_id, terminal_session_id, respond_nonce, verb);
    if let Some((kind, tail)) = rest.split_once(':') {
        if kind == "pin" {
            let verifying_key = parse_verifying_key_spki_b64(&binding.device_public_key_spki_b64)?;
            if verify_p256_sha256(&verifying_key, &challenge, tail) {
                return Some(None);
            }
            return None;
        }
        if kind == "passkey" {
            let Some(webauthn) = binding.webauthn.as_ref() else {
                return None;
            };
            return verify_passkey_assertion(tail, &challenge, webauthn).map(Some);
        }
    }
    None
}

/// Mint a PIN proof for integration tests (device signing key required).
#[cfg(any(test, feature = "test-seams"))]
pub fn mint_pin_human_proof(
    signing_key: &p256::ecdsa::SigningKey,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> String {
    use base64::Engine as _;
    use ecdsa::signature::Signer;
    let challenge = approval_challenge_digest(request_id, terminal_session_id, respond_nonce, verb);
    let sig: p256::ecdsa::Signature = signing_key.sign(&challenge);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
    format!("{PROOF_PREFIX}pin:{sig_b64}")
}

#[cfg(any(test, feature = "test-seams"))]
pub fn mint_test_signing_key() -> p256::ecdsa::SigningKey {
    use rand_core::OsRng;
    p256::ecdsa::SigningKey::random(&mut OsRng)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::WebAuthnCredential;
    use base64::Engine as _;
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePublicKey;
    use rand_core::OsRng;

    #[test]
    fn rejects_legacy_oschip1_proofs() {
        let binding = PairedBinding {
            device_public_key_spki_b64: String::new(),
            webauthn: None,
            pin_proof_failures: 0,
        };
        assert!(human_proof_verify(
            "oschip1:pin:0000000000000000000000000000000000000000000000000000000000000000",
            &binding,
            "clr_1",
            "term-a",
            "nonce",
            "read",
        )
        .is_none());
    }

    #[test]
    fn pin_proof_round_trip() {
        let signing_key = SigningKey::random(&mut OsRng);
        let spki = crate::device_crypto::verifying_key_spki_b64(signing_key.verifying_key());
        let proof = mint_pin_human_proof(&signing_key, "clr_1", "term-a", "nonce", "read");
        let binding = PairedBinding {
            device_public_key_spki_b64: spki,
            webauthn: None,
            pin_proof_failures: 0,
        };
        assert!(human_proof_verify(&proof, &binding, "clr_1", "term-a", "nonce", "read").is_some());
        assert!(
            human_proof_verify(&proof, &binding, "clr_2", "term-a", "nonce", "read",).is_none()
        );
    }

    #[test]
    fn persona_forged_passkey_bytes_are_rejected_without_webauthn_cred() {
        let signing_key = SigningKey::random(&mut OsRng);
        let spki = crate::device_crypto::verifying_key_spki_b64(signing_key.verifying_key());
        let binding = PairedBinding {
            device_public_key_spki_b64: spki.clone(),
            webauthn: Some(crate::pairing::WebAuthnCredential {
                credential_id_b64: "cred".into(),
                public_key_spki_b64: spki,
                sign_count: 0,
            }),
            pin_proof_failures: 0,
        };
        let attack = format!(
            "{PROOF_PREFIX}passkey:{}",
            serde_json::json!({
                "credentialIdB64": "cred",
                "authenticatorDataB64": "AA",
                "clientDataJsonB64": "AA",
                "signatureB64": "AA",
            })
        );
        assert!(
            human_proof_verify(&attack, &binding, "clr_1", "term-a", "nonce", "read",).is_none()
        );
    }
}
