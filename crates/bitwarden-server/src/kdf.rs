//! The client-side KDF a Bitwarden account unlocks with.
//!
//! The server never runs this KDF — the client does, over the master password,
//! to derive the master key that wraps the user key. The server's job is to
//! remember which KDF the client chose, hand it back at prelogin, and refuse a
//! choice outside the range a Bitwarden server accepts. The ranges live in one
//! table ([`RULES`]), keyed by the wire enum, so a KDF that succeeds Argon2id
//! is a new [`KdfType`] and one new row, not a new code path.

use opensesame_storage::bitwarden::BitwardenKdf;
use serde_json::{json, Value};

use crate::error::ApiError;

/// Bitwarden's wire enum. The discriminant is what goes on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KdfType {
    Pbkdf2Sha256 = 0,
    Argon2id = 1,
}

/// The accepted range of each parameter for one KDF, mirroring Bitwarden's
/// server-side `KdfSettingsValidator`.
#[derive(Clone, Copy, Debug)]
pub struct KdfRule {
    pub kdf_type: KdfType,
    pub name: &'static str,
    pub iterations: (u32, u32),
    /// MiB; `None` when the KDF takes no memory parameter.
    pub memory_mib: Option<(u32, u32)>,
    pub parallelism: Option<(u32, u32)>,
}

/// One row per KDF a new account may choose.
pub const RULES: &[KdfRule] = &[
    KdfRule {
        kdf_type: KdfType::Pbkdf2Sha256,
        name: "PBKDF2",
        iterations: (600_000, 2_000_000),
        memory_mib: None,
        parallelism: None,
    },
    KdfRule {
        kdf_type: KdfType::Argon2id,
        name: "Argon2",
        iterations: (2, 10),
        memory_mib: Some((15, 1024)),
        parallelism: Some((1, 16)),
    },
];

/// A validated KDF choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfConfig {
    pub kdf_type: KdfType,
    pub iterations: u32,
    pub memory_mib: Option<u32>,
    pub parallelism: Option<u32>,
}

impl KdfConfig {
    /// Bitwarden's recommended Argon2id: 64 MiB, three passes, four lanes.
    pub const ARGON2ID_DEFAULT: Self = Self {
        kdf_type: KdfType::Argon2id,
        iterations: 3,
        memory_mib: Some(64),
        parallelism: Some(4),
    };

    /// Bitwarden's PBKDF2 default: 600 000 iterations of HMAC-SHA256.
    pub const PBKDF2_DEFAULT: Self = Self {
        kdf_type: KdfType::Pbkdf2Sha256,
        iterations: 600_000,
        memory_mib: None,
        parallelism: None,
    };

    /// Validate raw wire values against [`RULES`].
    ///
    /// # Errors
    ///
    /// Returns a 400 [`ApiError`] naming the offending parameter, worded as
    /// Bitwarden's server words it.
    pub fn validate(
        kdf_type: i64,
        iterations: i64,
        memory: Option<i64>,
        parallelism: Option<i64>,
    ) -> Result<Self, ApiError> {
        let rule = RULES
            .iter()
            .find(|rule| rule.kdf_type as i64 == kdf_type)
            .ok_or_else(|| ApiError::bad_request("Invalid KDF type."))?;
        let within = |value: Option<i64>, range: (u32, u32)| {
            value
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| (range.0..=range.1).contains(v))
        };
        let iterations = within(Some(iterations), rule.iterations).ok_or_else(|| {
            ApiError::bad_request(format!(
                "KDF iterations must be between {} and {}.",
                rule.iterations.0, rule.iterations.1
            ))
        })?;
        let memory_mib = match rule.memory_mib {
            None => None,
            Some(range) => Some(within(memory, range).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "{} memory must be between {}mb and {}mb.",
                    rule.name, range.0, range.1
                ))
            })?),
        };
        let parallelism = match rule.parallelism {
            None => None,
            Some(range) => Some(within(parallelism, range).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "{} parallelism must be between {} and {}.",
                    rule.name, range.0, range.1
                ))
            })?),
        };
        Ok(Self {
            kdf_type: rule.kdf_type,
            iterations,
            memory_mib,
            parallelism,
        })
    }

    /// What was stored. Stored values were validated when written; an account
    /// imported with an older, weaker setting still unlocks with it.
    #[must_use]
    pub fn from_stored(stored: BitwardenKdf) -> Self {
        let kdf_type = if stored.kdf_type == KdfType::Argon2id as i64 {
            KdfType::Argon2id
        } else {
            KdfType::Pbkdf2Sha256
        };
        let narrow = |v: i64| u32::try_from(v).unwrap_or(u32::MAX);
        Self {
            kdf_type,
            iterations: narrow(stored.iterations),
            memory_mib: stored.memory.map(narrow),
            parallelism: stored.parallelism.map(narrow),
        }
    }

    #[must_use]
    pub fn to_stored(self) -> BitwardenKdf {
        BitwardenKdf {
            kdf_type: self.kdf_type as i64,
            iterations: i64::from(self.iterations),
            memory: self.memory_mib.map(i64::from),
            parallelism: self.parallelism.map(i64::from),
        }
    }

    /// The flat form older clients read: `kdf`, `kdfIterations`, …
    #[must_use]
    pub fn flat_json(self) -> Value {
        json!({
            "kdf": self.kdf_type as i64,
            "kdfIterations": self.iterations,
            "kdfMemory": self.memory_mib,
            "kdfParallelism": self.parallelism,
        })
    }

    /// The nested form current clients read: `{kdfType, iterations, memory, parallelism}`.
    #[must_use]
    pub fn settings_json(self) -> Value {
        json!({
            "kdfType": self.kdf_type as i64,
            "iterations": self.iterations,
            "memory": self.memory_mib,
            "parallelism": self.parallelism,
        })
    }
}

/// Which KDFs a new account, or a KDF change, may choose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfPolicy {
    /// Answered at prelogin for an email with no account, so an unknown
    /// address looks like a known one that chose the default.
    pub default: KdfConfig,
    /// Bitwarden accepts PBKDF2 for new accounts; an operator may insist on
    /// Argon2id instead.
    pub allow_pbkdf2: bool,
}

impl Default for KdfPolicy {
    fn default() -> Self {
        Self {
            default: KdfConfig::ARGON2ID_DEFAULT,
            allow_pbkdf2: true,
        }
    }
}

impl KdfPolicy {
    /// Validate a client's choice, then apply the operator's narrowing.
    ///
    /// # Errors
    ///
    /// Returns a 400 [`ApiError`] for an out-of-range or refused KDF.
    pub fn admit(
        self,
        kdf_type: i64,
        iterations: i64,
        memory: Option<i64>,
        parallelism: Option<i64>,
    ) -> Result<KdfConfig, ApiError> {
        let config = KdfConfig::validate(kdf_type, iterations, memory, parallelism)?;
        if config.kdf_type == KdfType::Pbkdf2Sha256 && !self.allow_pbkdf2 {
            return Err(ApiError::bad_request(
                "This server requires Argon2id. Change your KDF algorithm to Argon2id.",
            ));
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(kdf: i64, t: i64, m: Option<i64>, p: Option<i64>) -> bool {
        KdfConfig::validate(kdf, t, m, p).is_err()
    }

    #[test]
    fn bitwarden_server_ranges_hold_on_both_sides() {
        assert!(KdfConfig::validate(0, 600_000, None, None).is_ok());
        assert!(KdfConfig::validate(0, 2_000_000, None, None).is_ok());
        assert!(refused(0, 599_999, None, None));
        assert!(refused(0, 2_000_001, None, None));
        assert!(KdfConfig::validate(1, 2, Some(15), Some(1)).is_ok());
        assert!(KdfConfig::validate(1, 10, Some(1024), Some(16)).is_ok());
        assert!(refused(1, 1, Some(64), Some(4)));
        assert!(refused(1, 11, Some(64), Some(4)));
        assert!(refused(1, 3, Some(14), Some(4)));
        assert!(refused(1, 3, Some(1025), Some(4)));
        assert!(refused(1, 3, None, Some(4)));
        assert!(refused(1, 3, Some(64), Some(0)));
        assert!(refused(1, 3, Some(64), Some(17)));
        assert!(refused(1, 3, Some(64), None));
        assert!(refused(1, -3, Some(64), Some(4)));
        assert!(refused(2, 3, Some(64), Some(4)));
    }

    #[test]
    fn argon2id_is_the_default_and_pbkdf2_can_be_refused() {
        let policy = KdfPolicy::default();
        assert_eq!(policy.default, KdfConfig::ARGON2ID_DEFAULT);
        assert!(policy.admit(0, 600_000, None, None).is_ok());
        let strict = KdfPolicy {
            allow_pbkdf2: false,
            ..policy
        };
        assert!(strict.admit(0, 600_000, None, None).is_err());
        assert_eq!(
            strict.admit(1, 3, Some(64), Some(4)).unwrap(),
            KdfConfig::ARGON2ID_DEFAULT
        );
    }

    #[test]
    fn stored_values_round_trip_and_both_wire_forms_agree() {
        let config = KdfConfig::ARGON2ID_DEFAULT;
        assert_eq!(KdfConfig::from_stored(config.to_stored()), config);
        assert_eq!(
            config.flat_json(),
            json!({"kdf": 1, "kdfIterations": 3, "kdfMemory": 64, "kdfParallelism": 4})
        );
        assert_eq!(
            KdfConfig::PBKDF2_DEFAULT.settings_json(),
            json!({"kdfType": 0, "iterations": 600_000, "memory": null, "parallelism": null})
        );
    }
}
