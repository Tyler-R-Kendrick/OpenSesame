//! Versioned trust anchor state for CLI app-integration (D7-2).
//!
//! The approver root key (ARK) lives in the unlocked PWA; the daemon stores only
//! the public half after enrollment. Until an ARK is enrolled, legacy browser
//! pairing remains available for the optional daemon add-on.

use sha2::{Digest, Sha256};

use crate::device_crypto::parse_verifying_key_spki_b64;

pub const TRUST_STORE_VERSION: u32 = 3;
pub const MIN_PROTOCOL_VERSION: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustAnchor {
    pub ark_pub_spki_b64: String,
    pub origin: String,
    pub enrolled_at: u64,
    pub epoch: u64,
}

#[derive(Clone, Debug, Default)]
pub struct TrustStore {
    version: u32,
    ark: Option<TrustAnchor>,
    /// Pinned daemon identity (SPKI) shown to the PWA at enrollment.
    daemon_pub_spki_b64: Option<String>,
    weak_tty_anchor: bool,
}

impl TrustStore {
    #[must_use]
    pub fn new() -> Self {
        Self {
            version: MIN_PROTOCOL_VERSION,
            ark: None,
            daemon_pub_spki_b64: None,
            weak_tty_anchor: false,
        }
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.ark.as_ref().map_or(0, |a| a.epoch)
    }

    #[must_use]
    pub fn ark_enrolled(&self) -> bool {
        self.ark.is_some()
    }

    #[must_use]
    pub fn legacy_pairing_permitted(&self) -> bool {
        !self.ark_enrolled()
    }

    #[must_use]
    pub fn anchor(&self) -> Option<&TrustAnchor> {
        self.ark.as_ref()
    }

    #[must_use]
    pub fn daemon_pub_spki_b64(&self) -> Option<&str> {
        self.daemon_pub_spki_b64.as_deref()
    }

    #[must_use]
    pub fn weak_tty_anchor(&self) -> bool {
        self.weak_tty_anchor
    }

    pub fn enroll_ark(
        &mut self,
        ark_pub_spki_b64: &str,
        origin: &str,
        daemon_pub_spki_b64: &str,
        now: u64,
        weak_tty_anchor: bool,
    ) -> bool {
        if parse_verifying_key_spki_b64(ark_pub_spki_b64).is_none() {
            return false;
        }
        let next_epoch = self.epoch().saturating_add(1).max(1);
        self.ark = Some(TrustAnchor {
            ark_pub_spki_b64: ark_pub_spki_b64.to_string(),
            origin: origin.to_string(),
            enrolled_at: now,
            epoch: next_epoch,
        });
        self.daemon_pub_spki_b64 = Some(daemon_pub_spki_b64.to_string());
        self.weak_tty_anchor = weak_tty_anchor;
        self.version = TRUST_STORE_VERSION;
        true
    }

    /// Wipe legacy in-memory pairings when upgrading to the current trust format.
    pub fn migrate_from_legacy(&mut self, had_legacy_pairings: bool) {
        if had_legacy_pairings && self.version < MIN_PROTOCOL_VERSION {
            self.version = TRUST_STORE_VERSION;
        }
    }

    #[must_use]
    pub fn ark_fingerprint_hex(&self) -> Option<String> {
        self.ark
            .as_ref()
            .map(|a| fingerprint_hex(&a.ark_pub_spki_b64))
    }

    #[must_use]
    pub fn daemon_fingerprint_hex(&self) -> Option<String> {
        self.daemon_pub_spki_b64.as_deref().map(fingerprint_hex)
    }
}

#[must_use]
pub fn fingerprint_hex(spki_b64: &str) -> String {
    let digest = Sha256::digest(spki_b64.as_bytes());
    hex::encode(&digest[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_pairing_allowed_until_ark_enrolled() {
        let store = TrustStore::new();
        assert!(store.legacy_pairing_permitted());
    }
}
