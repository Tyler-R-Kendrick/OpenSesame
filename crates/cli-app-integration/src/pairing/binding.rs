//! Paired-page binding lookups and `WebAuthn` credential state for pairings.

use super::{
    is_device_public_key_shaped, is_secret_shaped, is_vault_session_root_digest_shaped,
    CliAppIntegrationPairings, PairedBinding, PairingError, WebAuthnCredential,
    WebAuthnRegistration, MAX_PIN_PROOF_FAILURES, PAIRING_CHALLENGE_LEN,
};
use crate::device_crypto::webauthn_register_challenge_digest;
use crate::pairing_code::{digest_hex, same};
use crate::webauthn_assertion::verify_passkey_assertion;

impl CliAppIntegrationPairings {
    #[must_use]
    pub fn binding_for(&self, token: &str, origin: &str) -> Option<PairedBinding> {
        if !is_secret_shaped(token) {
            return None;
        }
        let digest = digest_hex(token);
        self.paired
            .iter()
            .find(|page| page.origin == origin && same(page.token_sha256.as_str(), digest.as_str()))
            .map(|page| PairedBinding {
                device_public_key_spki_b64: page.device_public_key_spki_b64.clone(),
                webauthn: page.webauthn.clone(),
                pin_proof_failures: page.pin_proof_failures,
            })
    }

    /// Attach a vault-bound `WebAuthn` credential to an existing bearer pairing.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::RootKeyNotEnrolled`] before the root trust key is enrolled,
    /// and [`PairingError::Unknown`] when the bearer or public key is invalid.
    pub fn register_webauthn(
        &mut self,
        token: &str,
        origin: &str,
        registration: &WebAuthnRegistration,
    ) -> Result<(), PairingError> {
        self.require_root_key_enrolled()?;
        let vault_session_root_digest = registration.vault_session_root_digest.as_str();
        let human_proof_passkey = registration.human_proof_passkey.as_str();
        let credential_id_b64 = registration.credential_id_b64.as_str();
        let public_key_spki_b64 = registration.public_key_spki_b64.as_str();
        if !is_secret_shaped(token)
            || !is_device_public_key_shaped(public_key_spki_b64)
            || !is_vault_session_root_digest_shaped(vault_session_root_digest)
        {
            return Err(PairingError::Unknown);
        }
        let digest = digest_hex(token);
        let Some(page) = self.paired.iter().find(|page| {
            page.origin == origin && same(page.token_sha256.as_str(), digest.as_str())
        }) else {
            return Err(PairingError::Unknown);
        };
        if page.vault_session_root_digest.as_deref() != Some(vault_session_root_digest) {
            return Err(PairingError::InvalidProof);
        }
        if same(
            page.device_public_key_spki_b64.as_str(),
            public_key_spki_b64,
        ) {
            return Err(PairingError::InvalidProof);
        }
        let challenge =
            webauthn_register_challenge_digest(token, origin, vault_session_root_digest);
        let stored = WebAuthnCredential {
            credential_id_b64: credential_id_b64.to_string(),
            public_key_spki_b64: public_key_spki_b64.to_string(),
            sign_count: 0,
        };
        let proof_tail = human_proof_passkey
            .trim()
            .strip_prefix("oschip2:passkey:")
            .ok_or(PairingError::InvalidProof)?;
        let verified_sign_count = verify_passkey_assertion(proof_tail, &challenge, &stored)
            .ok_or(PairingError::InvalidProof)?;
        // `registration.sign_count` is the client body and is deliberately not
        // stored: keeping it would let a caller reset the counter after a
        // higher assertion count was verified.
        let Some(page) = self.paired.iter_mut().find(|page| {
            page.origin == origin && same(page.token_sha256.as_str(), digest.as_str())
        }) else {
            return Err(PairingError::Unknown);
        };
        page.webauthn = Some(WebAuthnCredential {
            credential_id_b64: credential_id_b64.to_string(),
            public_key_spki_b64: public_key_spki_b64.to_string(),
            sign_count: verified_sign_count,
        });
        Ok(())
    }

    /// Test seam: attach a passkey without the vault-bound registration proof.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::Unknown`] when the token is not secret-shaped or no
    /// paired page matches the origin and token digest.
    #[cfg(any(test, feature = "test-seams"))]
    pub fn register_webauthn_for_tests(
        &mut self,
        token: &str,
        origin: &str,
        credential_id_b64: &str,
        public_key_spki_b64: &str,
        sign_count: u32,
    ) -> Result<(), PairingError> {
        if !is_secret_shaped(token) {
            return Err(PairingError::Unknown);
        }
        let digest = digest_hex(token);
        let Some(page) = self.paired.iter_mut().find(|page| {
            page.origin == origin && same(page.token_sha256.as_str(), digest.as_str())
        }) else {
            return Err(PairingError::Unknown);
        };
        page.webauthn = Some(WebAuthnCredential {
            credential_id_b64: credential_id_b64.to_string(),
            public_key_spki_b64: public_key_spki_b64.to_string(),
            sign_count,
        });
        Ok(())
    }

    pub fn record_pin_proof_failure(&mut self, token: &str, origin: &str) -> bool {
        if !is_secret_shaped(token) {
            return false;
        }
        let digest = digest_hex(token);
        let Some(page) = self.paired.iter_mut().find(|page| {
            page.origin == origin && same(page.token_sha256.as_str(), digest.as_str())
        }) else {
            return false;
        };
        page.pin_proof_failures += 1;
        page.pin_proof_failures >= MAX_PIN_PROOF_FAILURES
    }

    pub fn advance_webauthn_sign_count(
        &mut self,
        token: &str,
        origin: &str,
        sign_count: u32,
    ) -> bool {
        if !is_secret_shaped(token) {
            return false;
        }
        let digest = digest_hex(token);
        let Some(page) = self.paired.iter_mut().find(|page| {
            page.origin == origin && same(page.token_sha256.as_str(), digest.as_str())
        }) else {
            return false;
        };
        let Some(webauthn) = page.webauthn.as_mut() else {
            return false;
        };
        if sign_count == 0 && webauthn.sign_count == 0 {
            return true;
        }
        if sign_count <= webauthn.sign_count {
            return false;
        }
        webauthn.sign_count = sign_count;
        true
    }

    #[must_use]
    pub fn authorizes(&self, token: &str, origin: &str) -> bool {
        self.binding_for(token, origin).is_some()
    }

    #[must_use]
    pub fn admits_origin(&self, origin: &str, now: u64) -> bool {
        self.pending
            .iter()
            .any(|p| p.origin == origin && p.expires_at > now)
            || self.paired.iter().any(|p| p.origin == origin)
    }

    #[must_use]
    pub fn paired_len(&self) -> usize {
        self.paired.len()
    }

    pub fn revoke_token(&mut self, origin: &str, token_digest_hex: &str) {
        self.paired.retain(|page| {
            !(page.origin == origin && same(page.token_sha256.as_str(), token_digest_hex))
        });
    }

    /// Challenge for the unlocked PWA to sign during pairing confirm (origin must match).
    #[must_use]
    pub fn pairing_challenge_for_confirm(
        &self,
        code: &str,
        origin: &str,
        now: u64,
    ) -> Option<[u8; PAIRING_CHALLENGE_LEN]> {
        if !is_secret_shaped(code) {
            return None;
        }
        let digest = digest_hex(code);
        self.pending
            .iter()
            .find(|p| {
                same(p.code_sha256.as_str(), digest.as_str())
                    && p.expires_at > now
                    && p.origin == origin
            })
            .map(|p| p.pairing_challenge)
    }

    #[cfg(any(test, feature = "test-seams"))]
    #[must_use]
    pub fn pairing_challenge_for_code(
        &self,
        code: &str,
        now: u64,
    ) -> Option<[u8; PAIRING_CHALLENGE_LEN]> {
        if !is_secret_shaped(code) {
            return None;
        }
        let digest = digest_hex(code);
        self.pending
            .iter()
            .find(|p| same(p.code_sha256.as_str(), digest.as_str()) && p.expires_at > now)
            .map(|p| p.pairing_challenge)
    }
}
