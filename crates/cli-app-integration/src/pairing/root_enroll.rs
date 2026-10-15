//! Apply a persisted root-trust record to in-memory pairings.

use super::CliAppIntegrationPairings;
use crate::root_trust::RootTrustRecord;

impl CliAppIntegrationPairings {
    /// Mark the root trust key enrolled from a trust-store record.
    ///
    /// The daemon calls this on startup after the sealed trust store loads.
    /// Confirm, registration arm, `WebAuthn` register, and exchange stay refused
    /// until it runs. Operator issue is not gated.
    pub fn mark_root_key_enrolled(&mut self, record: RootTrustRecord) {
        self.wipe_legacy_pairings_without_passkey();
        self.root_trust = Some(record);
        self.root_key_enrolled = true;
    }

    /// Drop pairings that predate passkey registration (downgrade closure).
    pub fn wipe_legacy_pairings_without_passkey(&mut self) {
        self.paired.retain(|page| page.webauthn.is_some());
    }

    /// Fingerprint and enrollment epoch loaded from the trust store.
    ///
    /// `None` when the key was enrolled only through the test seam.
    #[must_use]
    pub fn root_trust(&self) -> Option<&RootTrustRecord> {
        self.root_trust.as_ref()
    }
}
