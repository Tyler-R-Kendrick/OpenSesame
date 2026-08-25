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

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    #[kani::proof]
    fn receipt_key_id_is_a_function_of_the_public_key() {
        let bytes: [u8; 32] = kani::any();
        if let Ok(key) = VerifyingKey::from_bytes(&bytes) {
            let a = receipt_key_id(&key);
            let b = receipt_key_id(&key);
            assert_eq!(a, b);
            assert!(a.starts_with("receipt-key:"));
        }
    }
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
mod tests {
    use super::*;
    use chrono::Utc;
    use opensesame_domain::*;

    #[test]
    fn sign_and_verify() {
        let signer = ReceiptSigner::generate();
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:x".into(),
            principal_id: PrincipalId::new(),
            organization_id: None,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            policy_decision_id: "dec:1".into(),
            policy_version_digest: "sha256:p".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: Some("sha256:c".into()),
            external_request_digest: None,
            external_response_digest: None,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(serde_json::json!({"ok": true})),
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: 1,
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        let signed_receipt = signer.sign_receipt(receipt).unwrap();
        signer.verify_receipt(&signed_receipt).unwrap();
    }

    #[test]
    fn tampered_receipt_fails_verify() {
        let signer = ReceiptSigner::generate();
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:x".into(),
            principal_id: PrincipalId::new(),
            organization_id: None,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            policy_decision_id: "dec:1".into(),
            policy_version_digest: "sha256:p".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(serde_json::json!({"ok": true})),
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: 1,
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        let mut signed_receipt = signer.sign_receipt(receipt).unwrap();
        signed_receipt.operation = "admin.destroy".into();
        assert!(signer.verify_receipt(&signed_receipt).is_err());
    }

    fn sample_receipt() -> InvocationReceipt {
        InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:x".into(),
            principal_id: PrincipalId::new(),
            organization_id: None,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            policy_decision_id: "dec:1".into(),
            policy_version_digest: "sha256:p".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(serde_json::json!({"ok": true})),
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: 1,
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        }
    }

    #[test]
    fn legacy_receipt_without_organization_round_trips_and_verifies() {
        let signer = ReceiptSigner::generate();
        let signed_receipt = signer.sign_receipt(sample_receipt()).unwrap();
        let encoded = serde_json::to_string(&signed_receipt).unwrap();
        assert!(!encoded.contains("organization_id"));

        let decoded: InvocationReceipt = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.organization_id, None);
        signer.verify_receipt(&decoded).unwrap();
    }

    #[test]
    fn organization_claim_is_covered_by_the_receipt_signature() {
        let signer = ReceiptSigner::generate();
        let mut receipt = sample_receipt();
        receipt.organization_id = Some(OrganizationId::new());
        receipt.receipt_schema_version = 3;
        let mut signed_receipt = signer.sign_receipt(receipt).unwrap();
        signer.verify_receipt(&signed_receipt).unwrap();

        signed_receipt.organization_id = Some(OrganizationId::new());
        assert!(signer.verify_receipt(&signed_receipt).is_err());
    }

    #[test]
    fn schema_three_without_an_organization_is_never_signed_or_verified() {
        let signer = ReceiptSigner::generate();
        let mut invalid = sample_receipt();
        invalid.receipt_schema_version = 3;
        let error = signer.sign_receipt(invalid).unwrap_err().to_string();
        assert!(
            error.contains("schema 3 requires organization_id"),
            "{error}"
        );

        let mut signed_legacy = signer.sign_receipt(sample_receipt()).unwrap();
        signed_legacy.receipt_schema_version = 3;
        let error = signer
            .verify_receipt(&signed_legacy)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("schema 3 requires organization_id"),
            "{error}"
        );
    }

    #[test]
    fn a_seeded_signer_verifies_receipts_from_a_previous_process() {
        let seed = [7u8; 32];
        let before_restart = ReceiptSigner::from_seed(&seed);
        let signed = before_restart.sign_receipt(sample_receipt()).unwrap();

        // The store outlives the process: a restart must still verify the receipt.
        let after_restart = ReceiptSigner::from_seed(&seed);
        assert_eq!(after_restart.key_id, before_restart.key_id);
        after_restart.verify_receipt(&signed).unwrap();

        // An ephemeral key cannot, and says so rather than crying tamper.
        let ephemeral = ReceiptSigner::generate();
        let err = ephemeral.verify_receipt(&signed).unwrap_err().to_string();
        assert!(err.contains("another authority key"), "{err}");
    }

    #[test]
    fn a_retired_key_keeps_verifying_the_receipts_it_signed() {
        let retired = ReceiptSigner::from_seed(&[9u8; 32]);
        let old_receipt = retired.sign_receipt(sample_receipt()).unwrap();
        let active = ReceiptSigner::from_seed(&[11u8; 32]);
        let new_receipt = active.sign_receipt(sample_receipt()).unwrap();

        // Rotation keeps only the public half of the old key.
        let mut verifier = ReceiptVerifier::new();
        verifier.trust(active.verifying_key());
        verifier
            .trust_b64(&STANDARD.encode(retired.verifying_key().as_bytes()))
            .unwrap();

        verifier.verify(&old_receipt).unwrap();
        verifier.verify(&new_receipt).unwrap();
        assert_eq!(verifier.key_ids().len(), 2);

        // A key that was never trusted is reported as unknown, not as tampering.
        let stranger = ReceiptSigner::generate();
        let foreign = stranger.sign_receipt(sample_receipt()).unwrap();
        let err = verifier.verify(&foreign).unwrap_err().to_string();
        assert!(err.contains("no trusted receipt key"), "{err}");

        // Tampering under a trusted key still fails the signature check.
        let mut tampered = old_receipt.clone();
        tampered.operation = "admin.destroy".into();
        assert!(verifier.verify(&tampered).is_err());
    }

    #[test]
    fn published_keys_round_trip_into_a_fresh_verifier() {
        let signer = ReceiptSigner::from_seed(&[5u8; 32]);
        let receipt = signer.sign_receipt(sample_receipt()).unwrap();
        let mut source = ReceiptVerifier::new();
        source.trust(signer.verifying_key());

        // A holder can rebuild the verifier from the published material alone.
        let mut rebuilt = ReceiptVerifier::new();
        for (key_id, public_key) in source.published_keys() {
            assert_eq!(rebuilt.trust_b64(&public_key).unwrap(), key_id);
        }
        rebuilt.verify(&receipt).unwrap();
        assert!(!rebuilt.is_empty());
    }

    #[test]
    fn an_empty_verifier_trusts_nothing() {
        let signer = ReceiptSigner::generate();
        let receipt = signer.sign_receipt(sample_receipt()).unwrap();
        assert!(ReceiptVerifier::new().verify(&receipt).is_err());
    }

    #[test]
    fn seed_b64_accepts_both_alphabets_and_rejects_wrong_lengths() {
        let seed = [3u8; 32];
        let standard = STANDARD.encode(seed);
        let url_safe = URL_SAFE_NO_PAD.encode(seed);
        let expected = ReceiptSigner::from_seed(&seed).key_id;
        assert_eq!(
            ReceiptSigner::from_seed_b64(&standard).unwrap().key_id,
            expected
        );
        assert_eq!(
            ReceiptSigner::from_seed_b64(&url_safe).unwrap().key_id,
            expected
        );
        assert!(ReceiptSigner::from_seed_b64(&STANDARD.encode([1u8; 16])).is_err());
        assert!(ReceiptSigner::from_seed_b64("not base64!").is_err());
    }

    #[test]
    fn refuses_to_sign_secret_bearing_summary() {
        let signer = ReceiptSigner::generate();
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:x".into(),
            principal_id: PrincipalId::new(),
            organization_id: None,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: "x".into(),
            resource: "y".into(),
            policy_decision_id: "d".into(),
            policy_version_digest: "p".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(serde_json::json!({"refresh_token": "nope"})),
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: 1,
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        assert!(signer.sign_receipt(receipt).is_err());
    }
}
