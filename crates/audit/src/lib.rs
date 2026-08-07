use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey, Signature};
use opensesame_domain::{InvocationReceipt, DomainError, digest_json};
use rand::rngs::OsRng;
use serde_json::Value;

pub struct ReceiptSigner {
    pub key_id: String,
    signing_key: SigningKey,
}

impl ReceiptSigner {
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        Self {
            key_id: format!("receipt-key:{}", hex::encode(signing_key.verifying_key().as_bytes())),
            signing_key,
        }
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }

    pub fn sign_receipt(&self, mut receipt: InvocationReceipt) -> Result<InvocationReceipt, DomainError> {
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

    pub fn verify_receipt(
        &self,
        receipt: &InvocationReceipt,
    ) -> Result<(), DomainError> {
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
