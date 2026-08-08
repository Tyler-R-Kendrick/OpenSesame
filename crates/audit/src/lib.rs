use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use opensesame_domain::{digest_json, DomainError, InvocationReceipt};
use rand::rngs::OsRng;
use serde_json::Value;

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
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self::from_signing_key(SigningKey::from_bytes(seed))
    }

    /// `from_seed` over a base64 (standard or URL-safe, padded or not) 32-byte seed.
    pub fn from_seed_b64(encoded: &str) -> Result<Self, DomainError> {
        let trimmed = encoded.trim();
        let bytes = STANDARD
            .decode(trimmed)
            .or_else(|_| URL_SAFE_NO_PAD.decode(trimmed.trim_end_matches('=')))
            .map_err(|_| {
                DomainError::Canonicalization("receipt signing key is not valid base64".into())
            })?;
        let seed: [u8; 32] = bytes.try_into().map_err(|_| {
            DomainError::Canonicalization("receipt signing key must be 32 bytes".into())
        })?;
        Ok(Self::from_seed(&seed))
    }

    fn from_signing_key(signing_key: SigningKey) -> Self {
        Self {
            key_id: format!(
                "receipt-key:{}",
                hex::encode(signing_key.verifying_key().as_bytes())
            ),
            signing_key,
        }
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }

    pub fn sign_receipt(
        &self,
        mut receipt: InvocationReceipt,
    ) -> Result<InvocationReceipt, DomainError> {
        if !receipt.assert_no_secret_leak() {
            return Err(DomainError::Canonicalization(
                "receipt summary contains secret material".into(),
            ));
        }
        receipt.authority_key_id = self.key_id.clone();
        receipt.signature = String::new();
        let digest = digest_json(
            &serde_json::to_value(&receipt)
                .map_err(|e| DomainError::Canonicalization(e.to_string()))?,
        )?;
        let sig = self.signing_key.sign(digest.as_bytes());
        receipt.signature = STANDARD.encode(sig.to_bytes());
        Ok(receipt)
    }

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
        let mut clone = receipt.clone();
        let sig_b64 = clone.signature.clone();
        clone.signature = String::new();
        let digest = digest_json(
            &serde_json::to_value(&clone)
                .map_err(|e| DomainError::Canonicalization(e.to_string()))?,
        )?;
        let bytes = STANDARD
            .decode(sig_b64)
            .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
        let sig = Signature::from_slice(&bytes)
            .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
        self.verifying_key()
            .verify(digest.as_bytes(), &sig)
            .map_err(|e| DomainError::Canonicalization(e.to_string()))
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
        let signed = signer.sign_receipt(receipt).unwrap();
        signer.verify_receipt(&signed).unwrap();
    }

    #[test]
    fn tampered_receipt_fails_verify() {
        let signer = ReceiptSigner::generate();
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:x".into(),
            principal_id: PrincipalId::new(),
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
        let mut signed = signer.sign_receipt(receipt).unwrap();
        signed.operation = "admin.destroy".into();
        assert!(signer.verify_receipt(&signed).is_err());
    }

    fn sample_receipt() -> InvocationReceipt {
        InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:x".into(),
            principal_id: PrincipalId::new(),
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
