use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use opensesame_domain::{digest_json, DomainError, InvocationReceipt};
use rand::rngs::OsRng;
use serde_json::Value;
use std::collections::BTreeMap;

/// Decode a base64 (standard or URL-safe, padded or not) 32-byte value.
fn decode_key_bytes(encoded: &str, what: &str) -> Result<[u8; 32], DomainError> {
    let trimmed = encoded.trim();
    let bytes = STANDARD
        .decode(trimmed)
        .or_else(|_| URL_SAFE_NO_PAD.decode(trimmed.trim_end_matches('=')))
        .map_err(|_| DomainError::Canonicalization(format!("{what} is not valid base64")))?;
    bytes
        .try_into()
        .map_err(|_| DomainError::Canonicalization(format!("{what} must be 32 bytes")))
}

/// `receipt-key:<hex public key>` — the id is derived from the key, so it cannot
/// name a key other than the one that will check the signature.
#[must_use]
pub fn receipt_key_id(key: &VerifyingKey) -> String {
    format!("receipt-key:{}", hex::encode(key.as_bytes()))
}

/// Signature check shared by the signer and the verifier registry.
fn verify_with(key: &VerifyingKey, receipt: &InvocationReceipt) -> Result<(), DomainError> {
    receipt.assert_schema_invariants()?;
    let mut clone = receipt.clone();
    let sig_b64 = clone.signature.clone();
    clone.signature = String::new();
    let digest = digest_json(
        &serde_json::to_value(&clone).map_err(|e| DomainError::Canonicalization(e.to_string()))?,
    )?;
    let bytes = STANDARD
        .decode(sig_b64)
        .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
    let sig =
        Signature::from_slice(&bytes).map_err(|e| DomainError::Canonicalization(e.to_string()))?;
    key.verify(digest.as_bytes(), &sig)
        .map_err(|e| DomainError::Canonicalization(e.to_string()))
}

/// Public keys trusted to have signed receipts, keyed by `authority_key_id`.
///
/// Verification needs no secret, so a retired signing key is retired by keeping
/// only its public half here: rotation stops stranding the receipts it signed.
#[derive(Clone, Default)]
pub struct ReceiptVerifier {
    keys: BTreeMap<String, VerifyingKey>,
}

impl ReceiptVerifier {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn trust(&mut self, key: VerifyingKey) -> String {
        let id = receipt_key_id(&key);
        self.keys.insert(id.clone(), key);
        id
    }

    /// Trust a public key given as base64 32 bytes.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn trust_b64(&mut self, encoded: &str) -> Result<String, DomainError> {
        let bytes = decode_key_bytes(encoded, "receipt verification key")?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
        Ok(self.trust(key))
    }

    /// Key ids this verifier will accept, for publication.
    #[must_use]
    pub fn key_ids(&self) -> Vec<String> {
        self.keys.keys().cloned().collect()
    }

    /// Public keys as base64, paired with their ids, for publication.
    #[must_use]
    pub fn published_keys(&self) -> Vec<(String, String)> {
        self.keys
            .iter()
            .map(|(id, key)| (id.clone(), STANDARD.encode(key.as_bytes())))
            .collect()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Verify against the key the receipt names. An unknown key is reported as
    /// unknown rather than as a bad signature: a rotated or ephemeral key is a
    /// key-management fact, not tamper evidence.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn verify(&self, receipt: &InvocationReceipt) -> Result<(), DomainError> {
        let Some(key) = self.keys.get(&receipt.authority_key_id) else {
            return Err(DomainError::Canonicalization(format!(
                "no trusted receipt key matches {}",
                receipt.authority_key_id
            )));
        };
        verify_with(key, receipt)
    }
}

pub struct ReceiptSigner {
    pub key_id: String,
    signing_key: SigningKey,
}

impl ReceiptSigner {
    /// Ephemeral key. Receipts signed with it can only be verified by this
    /// process: use it for tests and dev, never against a persistent receipt store.
    pub fn generate() -> Self {
        Self::from_signing_key(SigningKey::generate(&mut OsRng))
    }

    /// Load a stable signing key so receipts stay verifiable across restarts.
    #[must_use]
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self::from_signing_key(SigningKey::from_bytes(seed))
    }

    /// `from_seed` over a base64 (standard or URL-safe, padded or not) 32-byte seed.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn from_seed_b64(encoded: &str) -> Result<Self, DomainError> {
        let seed = decode_key_bytes(encoded, "receipt signing key")?;
        Ok(Self::from_seed(&seed))
    }

    fn from_signing_key(signing_key: SigningKey) -> Self {
        Self {
            key_id: receipt_key_id(&signing_key.verifying_key()),
            signing_key,
        }
    }

    #[must_use]
    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn sign_receipt(
        &self,
        mut receipt: InvocationReceipt,
    ) -> Result<InvocationReceipt, DomainError> {
        receipt.assert_schema_invariants()?;
        if !receipt.assert_no_secret_leak() {
            return Err(DomainError::Canonicalization(
                "receipt summary contains secret material".into(),
            ));
        }
        // Key names are refused above; a secret riding in a *value* (an upstream
        // error, a URL, a bearer in a message) is scrubbed here, before the
        // digest is taken, so the signature covers exactly what is stored
        // (ADR 0157). Every receipt is signed through this one method.
        receipt.safe_result_summary = receipt
            .safe_result_summary
            .as_ref()
            .map(opensesame_redaction::redact_json);
        receipt.authority_key_id.clone_from(&self.key_id);
        receipt.signature = String::new();
        let digest = digest_json(
            &serde_json::to_value(&receipt)
                .map_err(|e| DomainError::Canonicalization(e.to_string()))?,
        )?;
        let sig = self.signing_key.sign(digest.as_bytes());
        receipt.signature = STANDARD.encode(sig.to_bytes());
        Ok(receipt)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn verify_receipt(&self, receipt: &InvocationReceipt) -> Result<(), DomainError> {
        // A receipt signed by a key this signer does not hold is unverifiable, not
        // forged. Saying "invalid signature" for it reads as tamper evidence and
        // hides the real cause (an ephemeral or rotated signing key).
        if receipt.authority_key_id != self.key_id {
            return Err(DomainError::Canonicalization(format!(
                "receipt was signed by another authority key ({})",
                receipt.authority_key_id
            )));
        }
        verify_with(&self.verifying_key(), receipt)
    }
}

mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::new();
        for b in data.as_ref() {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0xf) as usize] as char);
        }
        s
    }
}

#[must_use]
pub fn redact_event(data: &Value) -> Value {
    opensesame_redaction::redact_json(data)
}

#[cfg(test)]
mod tests;
