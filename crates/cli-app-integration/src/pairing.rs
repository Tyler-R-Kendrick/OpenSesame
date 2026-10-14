//! Browser pairing for CLI app-integration routes (ADR 0186 round 4, D6 redesign).
//!
//! A page trades a one-time code from the terminal for a bearer that may call
//! `pending` and `respond` only when its `Origin` matches the bound origin.
//! Pairing binds a device signing key (public half on the daemon only); vault
//! key material never crosses the wire.

use rand_core::{OsRng, RngCore as _};

use crate::device_crypto::{
    is_registration_code_shaped, pairing_confirm_message, parse_verifying_key_spki_b64,
    verify_p256_sha256,
};
use crate::pairing_code::{digest_hex, find_digest, pairing_id, registration_code, same, secret};

pub use crate::pairing_code::{
    format_pairing_code, is_device_public_key_shaped, is_pairable_origin, is_secret_shaped,
};

pub const PAIRING_CODE_PREFIX: &str = "opensesame-cli-app:v1:";
pub const CODE_TTL_SECS: u64 = 300;
pub const MAX_PENDING: usize = 8;
pub const MAX_PAIRED: usize = 16;
pub const MAX_LABEL_CHARS: usize = 80;
pub const PAIRING_CHALLENGE_LEN: usize = 32;
pub const MAX_PIN_PROOF_FAILURES: u32 = 8;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum PairingError {
    #[error(
        "an origin is https://host[:port] or http://localhost:port, exactly as a browser sends it"
    )]
    InvalidOrigin,
    #[error("too many CLI app-integration pairings; unpair one first")]
    Full,
    #[error("no such pairing code")]
    Unknown,
    #[error("the pairing code expired")]
    Expired,
    #[error("the pairing code was issued for another origin, and is now spent")]
    WrongOrigin,
    #[error("confirm the pairing code in OpenSesame before exchanging")]
    NotConfirmed,
    #[error("type the registration code from OpenSesame into this terminal first")]
    RegistrationRequired,
    #[error("the registration code did not match")]
    RegistrationMismatch,
    #[error("device pairing proof was invalid")]
    InvalidProof,
}

#[derive(Clone, Debug)]
struct Pending {
    code_sha256: String,
    origin: String,
    expires_at: u64,
    pairing_challenge: [u8; PAIRING_CHALLENGE_LEN],
    /// Set after the unlocked PWA confirms with a device signature.
    device_public_key_spki_b64: Option<String>,
    registration_code_sha256: Option<String>,
    registration_armed: bool,
}

#[derive(Clone, Debug)]
pub struct WebAuthnCredential {
    pub credential_id_b64: String,
    pub public_key_spki_b64: String,
    pub sign_count: u32,
}

#[derive(Clone, Debug)]
struct PairedPage {
    #[allow(dead_code)]
    id: String,
    token_sha256: String,
    origin: String,
    #[allow(dead_code)]
    paired_at: u64,
    device_public_key_spki_b64: String,
    webauthn: Option<WebAuthnCredential>,
    pin_proof_failures: u32,
}

/// Binding looked up for human-proof verification.
#[derive(Clone, Debug)]
pub struct PairedBinding {
    pub device_public_key_spki_b64: String,
    pub webauthn: Option<WebAuthnCredential>,
    pub pin_proof_failures: u32,
}

/// A bearer handed back once by [`CliAppIntegrationPairings::exchange`].
pub struct Issued {
    pub id: String,
    pub origin: String,
    pub token: String,
}

/// Outcome of a successful pairing confirm (registration code shown once in the PWA).
pub struct ConfirmOutcome {
    pub registration_code: String,
}

/// In-memory pairings held by the daemon (restarts clear them; re-pair in Pages).
#[derive(Clone, Debug, Default)]
pub struct CliAppIntegrationPairings {
    pending: Vec<Pending>,
    paired: Vec<PairedPage>,
}

impl CliAppIntegrationPairings {
    /// Record a one-time code for `origin`; the code is returned once.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError`] when the origin is invalid or the pending queue is full.
    pub fn issue(&mut self, origin: &str, now: u64) -> Result<(String, u64), PairingError> {
        if !is_pairable_origin(origin) {
            return Err(PairingError::InvalidOrigin);
        }
        self.pending.retain(|p| p.expires_at > now);
        if self.pending.len() >= MAX_PENDING {
            return Err(PairingError::Full);
        }
        let code = secret();
        let expires_at = now + CODE_TTL_SECS;
        let mut pairing_challenge = [0u8; PAIRING_CHALLENGE_LEN];
        OsRng.fill_bytes(&mut pairing_challenge);
        self.pending.push(Pending {
            code_sha256: digest_hex(&code),
            origin: origin.to_string(),
            expires_at,
            pairing_challenge,
            device_public_key_spki_b64: None,
            registration_code_sha256: None,
            registration_armed: false,
        });
        Ok((code, expires_at))
    }

    /// Pages calls this after a person confirms the printed code while the vault is unlocked.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError`] when the code, origin, or pairing signature is invalid.
    pub fn confirm(
        &mut self,
        code: &str,
        origin: &str,
        device_public_key_spki_b64: &str,
        pairing_signature_b64: &str,
        now: u64,
    ) -> Result<ConfirmOutcome, PairingError> {
        if !is_device_public_key_shaped(device_public_key_spki_b64) {
            return Err(PairingError::InvalidProof);
        }
        let verifying_key = parse_verifying_key_spki_b64(device_public_key_spki_b64)
            .ok_or(PairingError::InvalidProof)?;
        self.pending.retain(|p| p.expires_at > now);
        let digest = digest_hex(code);
        let index = find_digest(self.pending.iter().map(|p| p.code_sha256.as_str()), &digest)
            .filter(|_| is_secret_shaped(code))
            .ok_or(PairingError::Unknown)?;
        let pending = &mut self.pending[index];
        if pending.expires_at <= now {
            return Err(PairingError::Expired);
        }
        if pending.origin != origin {
            return Err(PairingError::WrongOrigin);
        }
        let message = pairing_confirm_message(&pending.pairing_challenge, code, origin);
        if !verify_p256_sha256(&verifying_key, &message, pairing_signature_b64) {
            return Err(PairingError::InvalidProof);
        }
        let registration_code = registration_code();
        pending.device_public_key_spki_b64 = Some(device_public_key_spki_b64.to_string());
        pending.registration_code_sha256 = Some(digest_hex(&registration_code));
        pending.registration_armed = self.paired.is_empty();
        Ok(ConfirmOutcome { registration_code })
    }

    /// Operator CLI arms the registration code before the PWA may exchange (first pairing).
    ///
    /// # Errors
    ///
    /// Returns [`PairingError`] when no pending pairing matches or the registration code differs.
    pub fn arm_registration(
        &mut self,
        origin: &str,
        registration_code: &str,
        now: u64,
    ) -> Result<(), PairingError> {
        if !is_registration_code_shaped(registration_code) {
            return Err(PairingError::RegistrationMismatch);
        }
        self.pending.retain(|p| p.expires_at > now);
        let digest = digest_hex(registration_code);
        let Some(index) = self
            .pending
            .iter()
            .position(|p| p.origin == origin && p.device_public_key_spki_b64.is_some())
        else {
            return Err(PairingError::Unknown);
        };
        let pending = &mut self.pending[index];
        if pending.registration_code_sha256.as_deref() != Some(digest.as_str()) {
            return Err(PairingError::RegistrationMismatch);
        }
        pending.registration_armed = true;
        Ok(())
    }

    /// Exchange a confirmed pairing code for a bearer token.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError`] when the code is unknown, expired, or not ready to exchange.
    pub fn exchange(&mut self, code: &str, origin: &str, now: u64) -> Result<Issued, PairingError> {
        let digest = digest_hex(code);
        let found = find_digest(self.pending.iter().map(|p| p.code_sha256.as_str()), &digest);
        let Some(index) = found.filter(|_| is_secret_shaped(code)) else {
            return Err(PairingError::Unknown);
        };
        let pending = &self.pending[index];
        if pending.device_public_key_spki_b64.as_deref().is_none() {
            return Err(PairingError::NotConfirmed);
        }
        if self.paired.is_empty() && !pending.registration_armed {
            return Err(PairingError::RegistrationRequired);
        }
        if pending.expires_at > now && pending.origin == origin && self.paired.len() >= MAX_PAIRED {
            return Err(PairingError::Full);
        }
        let pending = self.pending.remove(index);
        self.pending.retain(|p| p.expires_at > now);
        if pending.expires_at <= now {
            return Err(PairingError::Expired);
        }
        if pending.origin != origin {
            return Err(PairingError::WrongOrigin);
        }
        let device_public_key = pending
            .device_public_key_spki_b64
            .ok_or(PairingError::NotConfirmed)?;
        let issued = Issued {
            id: pairing_id(),
            origin: pending.origin,
            token: secret(),
        };
        self.paired.push(PairedPage {
            id: issued.id.clone(),
            token_sha256: digest_hex(&issued.token),
            origin: issued.origin.clone(),
            paired_at: now,
            device_public_key_spki_b64: device_public_key,
            webauthn: None,
            pin_proof_failures: 0,
        });
        Ok(issued)
    }

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

    /// Attach a `WebAuthn` credential to an existing bearer pairing.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::Unknown`] when the bearer or public key is invalid.
    pub fn register_webauthn(
        &mut self,
        token: &str,
        origin: &str,
        credential_id_b64: &str,
        public_key_spki_b64: &str,
        sign_count: u32,
    ) -> Result<(), PairingError> {
        if !is_secret_shaped(token) || !is_device_public_key_shaped(public_key_spki_b64) {
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

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod tests;
