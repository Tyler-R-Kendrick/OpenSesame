//! Bitwarden key-derivation parameters, and the policy range a server's
//! prelogin answer must fall inside before any derivation runs.

use std::ops::RangeInclusive;

use crate::error::{Error, Result};

/// Bitwarden's current `PBKDF2` default (raised from `100_000` in 2023).
pub const DEFAULT_PBKDF2_ITERATIONS: u32 = 600_000;
/// Bitwarden's own server-enforced floor. Anything lower is a downgrade.
pub const MIN_PBKDF2_ITERATIONS: u32 = 5_000;
/// Bitwarden's client-side `PBKDF2` ceiling.
pub const MAX_PBKDF2_ITERATIONS: u32 = 2_000_000;
/// Bitwarden's client-side `Argon2id` pass range.
pub const MIN_ARGON2_ITERATIONS: u32 = 2;
/// See [`MIN_ARGON2_ITERATIONS`].
pub const MAX_ARGON2_ITERATIONS: u32 = 10;
/// Bitwarden's client-side `Argon2id` memory range, in MiB (the wire unit).
pub const MIN_ARGON2_MEMORY_MIB: u32 = 16;
/// See [`MIN_ARGON2_MEMORY_MIB`].
pub const MAX_ARGON2_MEMORY_MIB: u32 = 1024;
/// Bitwarden's client-side `Argon2id` lane ceiling (the floor is one).
pub const MAX_ARGON2_PARALLELISM: u32 = 16;

const PBKDF2_ITERATIONS: RangeInclusive<u32> = MIN_PBKDF2_ITERATIONS..=MAX_PBKDF2_ITERATIONS;
const ARGON2_ITERATIONS: RangeInclusive<u32> = MIN_ARGON2_ITERATIONS..=MAX_ARGON2_ITERATIONS;
const ARGON2_MEMORY_MIB: RangeInclusive<u32> = MIN_ARGON2_MEMORY_MIB..=MAX_ARGON2_MEMORY_MIB;
const ARGON2_PARALLELISM: RangeInclusive<u32> = 1..=MAX_ARGON2_PARALLELISM;

fn within(what: &str, value: u32, range: RangeInclusive<u32>) -> Result<()> {
    if range.contains(&value) {
        return Ok(());
    }
    Err(Error::InvalidKdfParameters(format!(
        "{what} {value} outside Bitwarden's {}..={} range",
        range.start(),
        range.end()
    )))
}

/// Key-derivation function named by `POST /identity/accounts/prelogin`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kdf {
    /// `kdf: 0`
    Pbkdf2 { iterations: u32 },
    /// `kdf: 1`
    Argon2id {
        iterations: u32,
        memory_kib: u32,
        parallelism: u32,
    },
}

impl Kdf {
    /// Build from the raw prelogin fields. `kdf_memory` is in **MiB** on the
    /// wire, as Bitwarden's UI presents it.
    ///
    /// Prelogin is unauthenticated server input that is run *before* anything
    /// the server says can be checked, so every parameter must fall inside
    /// the range Bitwarden's own clients accept: a floor so a hostile server
    /// cannot downgrade the master key, and a ceiling so it cannot make the
    /// derivation eat the machine.
    ///
    /// # Errors
    ///
    /// Returns [`Error::UnsupportedKdf`] for an unknown KDF or
    /// [`Error::InvalidKdfParameters`] for missing, unsafe, or overflowing
    /// parameters.
    pub fn from_prelogin(
        kdf: u32,
        iterations: u32,
        memory_mebibytes: Option<u32>,
        parallelism: Option<u32>,
    ) -> Result<Self> {
        match kdf {
            0 => {
                within("PBKDF2 iterations", iterations, PBKDF2_ITERATIONS)?;
                Ok(Kdf::Pbkdf2 { iterations })
            }
            1 => {
                let memory_mebibytes = memory_mebibytes.ok_or_else(|| {
                    Error::InvalidKdfParameters("Argon2id requires kdfMemory".into())
                })?;
                let parallelism = parallelism.ok_or_else(|| {
                    Error::InvalidKdfParameters("Argon2id requires kdfParallelism".into())
                })?;
                within("Argon2id iterations", iterations, ARGON2_ITERATIONS)?;
                within(
                    "Argon2id kdfMemory (MiB)",
                    memory_mebibytes,
                    ARGON2_MEMORY_MIB,
                )?;
                within("Argon2id parallelism", parallelism, ARGON2_PARALLELISM)?;
                let memory_kib = memory_mebibytes.checked_mul(1024).ok_or_else(|| {
                    Error::InvalidKdfParameters(format!(
                        "kdfMemory {memory_mebibytes} MiB overflows"
                    ))
                })?;
                Self::argon2id(iterations, memory_kib, parallelism)
            }
            other => Err(Error::UnsupportedKdf(other)),
        }
    }

    /// Argon2id with memory already in KiB (the unit `argon2` wants).
    ///
    /// Locally chosen parameters only: this checks what `argon2` itself needs,
    /// not Bitwarden's policy range, which [`Self::from_prelogin`] enforces on
    /// anything a server sends.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKdfParameters`] when iterations or parallelism
    /// are zero, or when the memory cost is below Argon2's minimum.
    pub fn argon2id(iterations: u32, memory_kib: u32, parallelism: u32) -> Result<Self> {
        if iterations == 0 || parallelism == 0 {
            return Err(Error::InvalidKdfParameters(
                "Argon2id iterations and parallelism must be non-zero".into(),
            ));
        }
        if memory_kib < 8 * parallelism {
            return Err(Error::InvalidKdfParameters(format!(
                "Argon2id memory {memory_kib} KiB is below the 8×parallelism minimum"
            )));
        }
        Ok(Kdf::Argon2id {
            iterations,
            memory_kib,
            parallelism,
        })
    }
}

impl Default for Kdf {
    fn default() -> Self {
        Kdf::Pbkdf2 {
            iterations: DEFAULT_PBKDF2_ITERATIONS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prelogin_kdf_parameters_are_validated() {
        assert_eq!(
            Kdf::from_prelogin(0, 600_000, None, None).unwrap(),
            Kdf::Pbkdf2 {
                iterations: 600_000
            }
        );
        assert_eq!(
            Kdf::from_prelogin(0, 100, None, None).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, Some(64), Some(4)).unwrap(),
            Kdf::Argon2id {
                iterations: 3,
                memory_kib: 64 * 1024,
                parallelism: 4
            }
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, None, Some(4)).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, Some(64), None).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 0, Some(64), Some(4))
                .unwrap_err()
                .code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, Some(u32::MAX), Some(1))
                .unwrap_err()
                .code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(9, 3, None, None).unwrap_err().code(),
            "unsupported_kdf"
        );
        assert_eq!(
            Kdf::default(),
            Kdf::Pbkdf2 {
                iterations: DEFAULT_PBKDF2_ITERATIONS
            }
        );
    }

    #[test]
    fn argon2_memory_must_cover_its_lanes() {
        assert_eq!(
            Kdf::argon2id(3, 8, 4).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert!(Kdf::argon2id(3, 32, 4).is_ok());
    }

    fn refused(kdf: u32, iterations: u32, memory: Option<u32>, lanes: Option<u32>) -> bool {
        Kdf::from_prelogin(kdf, iterations, memory, lanes)
            .is_err_and(|e| e.code() == "invalid_kdf_parameters")
    }

    #[test]
    fn prelogin_pbkdf2_is_bounded_on_both_sides() {
        assert!(Kdf::from_prelogin(0, MIN_PBKDF2_ITERATIONS, None, None).is_ok());
        assert!(Kdf::from_prelogin(0, MAX_PBKDF2_ITERATIONS, None, None).is_ok());
        assert!(refused(0, MIN_PBKDF2_ITERATIONS - 1, None, None));
        assert!(refused(0, MAX_PBKDF2_ITERATIONS + 1, None, None));
        assert!(refused(0, u32::MAX, None, None));
    }

    #[test]
    fn prelogin_argon2id_is_held_to_bitwarden_client_limits() {
        // Both corners of the accepted box.
        assert!(Kdf::from_prelogin(1, 2, Some(16), Some(1)).is_ok());
        assert!(Kdf::from_prelogin(1, 10, Some(1024), Some(16)).is_ok());
        // Floors: a hostile server cannot downgrade the master key.
        assert!(refused(1, 1, Some(64), Some(4)));
        assert!(refused(1, 3, Some(15), Some(4)));
        assert!(refused(1, 3, Some(1), Some(1)));
        assert!(refused(1, 3, Some(64), Some(0)));
        // Ceilings: nor make the derivation eat the machine.
        assert!(refused(1, 11, Some(64), Some(4)));
        assert!(refused(1, u32::MAX, Some(64), Some(4)));
        assert!(refused(1, 3, Some(1025), Some(4)));
        assert!(refused(1, 3, Some(4_194_303), Some(4)));
        assert!(refused(1, 3, Some(64), Some(17)));
        assert!(refused(1, 3, Some(64), Some(u32::MAX)));
    }
}
