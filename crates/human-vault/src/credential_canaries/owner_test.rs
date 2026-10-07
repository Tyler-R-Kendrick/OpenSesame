//! Private native owner freshness witnesses; never included in receiver packets or redacted status.
use super::{receiver::ReceiverError, DeviceState, OwnerTestWitness};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
fn digest(policy: &[u8]) -> String {
    STANDARD.encode(Sha256::digest(policy))
}
impl DeviceState {
    /// # Errors
    /// Caller supplies the complete original canonical authenticated owner policy under its edit
    /// lock. Only a queued test gets a witness; normal sealed telemetry needs no owner admission.
    pub fn pin_owner_test(&mut self, package_id: &str, policy: &[u8]) -> Result<(), ReceiverError> {
        if policy.len() > 65536
            || !self
                .outbox
                .entries
                .iter()
                .any(|entry| entry.testing && entry.package.package_id == package_id)
        {
            return Err(ReceiverError::Invalid);
        }
        self.owner_test_witnesses.retain(|witness| {
            witness.package_id != package_id
                && self
                    .outbox
                    .entries
                    .iter()
                    .any(|entry| entry.package.package_id == witness.package_id)
        });
        self.owner_test_witnesses.push(OwnerTestWitness {
            package_id: package_id.into(),
            manifest_digest_b64: digest(policy),
        });
        Ok(())
    }
    #[must_use]
    pub fn owner_test_current(&self, package_id: &str, policy: &[u8]) -> bool {
        policy.len() <= 65536
            && self.owner_test_witnesses.iter().any(|witness| {
                witness.package_id == package_id && witness.manifest_digest_b64 == digest(policy)
            })
    }
    pub fn remove_owner_test(&mut self, package_id: &str) {
        self.owner_test_witnesses
            .retain(|witness| witness.package_id != package_id);
    }
}
