//! Human proof tokens minted in Pages after PIN or passkey unlock (`oschip2:` + signature).

use crate::device_crypto::approval_challenge_digest;
use crate::pairing::PairedBinding;
use crate::webauthn_assertion::verify_passkey_assertion;

const PROOF_PREFIX: &str = "oschip2:";

pub(crate) fn human_proof_verify(
    proof: &str,
    binding: &PairedBinding,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> Option<u32> {
    if binding.pin_proof_failures >= crate::pairing::MAX_PIN_PROOF_FAILURES {
        return None;
    }
    let t = proof.trim();
    let rest = t.strip_prefix(PROOF_PREFIX)?;
    let challenge = approval_challenge_digest(request_id, terminal_session_id, respond_nonce, verb);
    if let Some((kind, tail)) = rest.split_once(':') {
        if kind == "pin" {
            // Pairing device keys are client-chosen; PIN proofs must not verify against them.
            return None;
        }
        if kind == "passkey" {
            let webauthn = binding.webauthn.as_ref()?;
            return verify_passkey_assertion(tail, &challenge, webauthn);
        }
    }
    None
}

/// Mint a PIN proof for integration tests (device signing key required).
#[cfg(any(test, feature = "test-seams"))]
#[must_use]
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
#[must_use]
pub fn mint_test_signing_key() -> p256::ecdsa::SigningKey {
    use rand_core::OsRng;
    p256::ecdsa::SigningKey::random(&mut OsRng)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::SigningKey;
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
    fn pin_proof_does_not_verify_against_pairing_device_key() {
        let signing_key = SigningKey::random(&mut OsRng);
        let spki = crate::device_crypto::verifying_key_spki_b64(signing_key.verifying_key());
        let proof = mint_pin_human_proof(&signing_key, "clr_1", "term-a", "nonce", "read");
        let binding = PairedBinding {
            device_public_key_spki_b64: spki,
            webauthn: None,
            pin_proof_failures: 0,
        };
        assert!(human_proof_verify(&proof, &binding, "clr_1", "term-a", "nonce", "read").is_none());
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
            human_proof_verify(&attack, &binding, "clr_1", "term-a", "nonce", "read").is_none()
        );
    }
}
