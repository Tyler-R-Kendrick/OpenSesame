//! Metadata-only resource admission. Untrusted wrappers cannot select a policy.

use crate::{VaultCryptoError, MIN_ARGON_M_KIB, MIN_ARGON_T};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KdfPolicy {
    Native,
    Browser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfWork {
    pub memory_bytes: u64,
    pub memory_pass_bytes: u64,
}

/// A native offline migration's explicit, human-confirmed resource budget.
/// Not deserializable: wrapper metadata cannot construct or select this policy.
#[cfg(not(target_arch = "wasm32"))]
pub struct OfflineMigrationBudget {
    memory_kib: u32,
    passes: u32,
}

#[cfg(not(target_arch = "wasm32"))]
impl OfflineMigrationBudget {
    /// Called only after displaying the metadata diagnostic and obtaining user consent.
    ///
    /// # Errors
    /// Refuses absent confirmation or a budget outside the historical bounded policy.
    pub fn after_user_confirmation(
        memory_kib: u32,
        passes: u32,
        confirmed: bool,
    ) -> Result<Self, VaultCryptoError> {
        if !confirmed
            || !(MIN_ARGON_M_KIB..=1024 * 1024).contains(&memory_kib)
            || !(MIN_ARGON_T..=16).contains(&passes)
        {
            return Err(VaultCryptoError::KdfParamsOutOfRange);
        }
        Ok(Self { memory_kib, passes })
    }

    pub(crate) fn admit(
        &self,
        memory_kib: u32,
        passes: u32,
        lanes: u32,
    ) -> Result<(), VaultCryptoError> {
        if memory_kib > self.memory_kib || passes > self.passes {
            return Err(VaultCryptoError::KdfParamsOutOfRange);
        }
        inspect_legacy_kdf(memory_kib, passes, lanes).map(|_| ())
    }
}

impl KdfPolicy {
    #[must_use]
    pub const fn current_platform() -> Self {
        if cfg!(target_arch = "wasm32") {
            Self::Browser
        } else {
            Self::Native
        }
    }

    #[must_use]
    pub const fn ceilings(self) -> (u32, u32, u32) {
        match self {
            Self::Native => (256 * 1024, 8, 4),
            Self::Browser => (64 * 1024, 3, 1),
        }
    }

    /// Inspect parameters without allocating Argon2 memory or deriving a key.
    ///
    /// # Errors
    /// Refuses unsafe floors, resource ceilings, or arithmetic overflow.
    pub fn inspect(
        self,
        memory_kib: u32,
        passes: u32,
        lanes: u32,
    ) -> Result<KdfWork, VaultCryptoError> {
        let (max_memory, max_passes, max_lanes) = self.ceilings();
        if !(MIN_ARGON_M_KIB..=max_memory).contains(&memory_kib)
            || !(MIN_ARGON_T..=max_passes).contains(&passes)
            || !(1..=max_lanes).contains(&lanes)
        {
            return Err(VaultCryptoError::KdfParamsOutOfRange);
        }
        estimate(memory_kib, passes)
    }
}

fn estimate(memory_kib: u32, passes: u32) -> Result<KdfWork, VaultCryptoError> {
    let memory_bytes = u64::from(memory_kib)
        .checked_mul(1024)
        .ok_or(VaultCryptoError::KdfParamsOutOfRange)?;
    let memory_pass_bytes = memory_bytes
        .checked_mul(u64::from(passes))
        .ok_or(VaultCryptoError::KdfParamsOutOfRange)?;
    Ok(KdfWork {
        memory_bytes,
        memory_pass_bytes,
    })
}

/// Diagnostic for an offline migration UI. This does not authorize decryption
/// or raise the network-facing resource policy.
///
/// # Errors
/// Refuses parameters below the security floor, invalid lanes, or work overflow.
pub fn inspect_legacy_kdf(
    memory_kib: u32,
    passes: u32,
    lanes: u32,
) -> Result<KdfWork, VaultCryptoError> {
    if memory_kib < MIN_ARGON_M_KIB || passes < MIN_ARGON_T || !(1..=4).contains(&lanes) {
        return Err(VaultCryptoError::KdfParamsOutOfRange);
    }
    estimate(memory_kib, passes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_ceilings_preserve_writer_floor() {
        for policy in [KdfPolicy::Native, KdfPolicy::Browser] {
            let (m, t, p) = policy.ceilings();
            assert!(policy.inspect(MIN_ARGON_M_KIB, MIN_ARGON_T, 1).is_ok());
            assert!(policy.inspect(m, t, p).is_ok());
            assert!(policy.inspect(m + 1, t, p).is_err());
            assert!(policy.inspect(m, t + 1, p).is_err());
            assert!(policy.inspect(m, t, p + 1).is_err());
            assert!(policy.inspect(u32::MAX, u32::MAX, u32::MAX).is_err());
        }
        assert!(inspect_legacy_kdf(u32::MAX, u32::MAX, 1).is_err());
    }

    #[test]
    fn diagnostics_do_not_admit_legacy_work() {
        let work = inspect_legacy_kdf(1024 * 1024, 16, 4).unwrap();
        assert_eq!(work.memory_bytes, 1024 * 1024 * 1024);
        assert!(KdfPolicy::Native.inspect(1024 * 1024, 16, 4).is_err());
        assert!(KdfPolicy::Browser.inspect(128 * 1024, 3, 1).is_err());
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn offline_budget_requires_confirmation_and_cannot_expand_itself() {
        assert!(OfflineMigrationBudget::after_user_confirmation(1024 * 1024, 16, false).is_err());
        assert!(OfflineMigrationBudget::after_user_confirmation(u32::MAX, 16, true).is_err());
        let budget = OfflineMigrationBudget::after_user_confirmation(128 * 1024, 4, true).unwrap();
        assert!(budget.admit(128 * 1024, 4, 1).is_ok());
        assert!(budget.admit(256 * 1024, 4, 1).is_err());
        assert!(budget.admit(128 * 1024, 5, 1).is_err());
        assert!(budget.admit(32 * 1024, 3, 1).is_err());
    }
}
