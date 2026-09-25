//! Argon2id (RFC 9106), the current scheme.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};

use super::{HashError, PasswordHashScheme};

/// Argon2id v1.3 under one parameter set.
#[derive(Clone, Debug)]
pub struct Argon2idScheme {
    params: Params,
}

impl Argon2idScheme {
    /// OWASP's first server-side recommendation: 19 MiB, two passes, one lane.
    /// The input is already the output of the client's own KDF, so this layer
    /// guards a leaked database, not a guessable password.
    pub const DEFAULT_MEMORY_KIB: u32 = 19 * 1024;
    /// See [`Self::DEFAULT_MEMORY_KIB`].
    pub const DEFAULT_ITERATIONS: u32 = 2;
    /// See [`Self::DEFAULT_MEMORY_KIB`].
    pub const DEFAULT_PARALLELISM: u32 = 1;

    /// Argon2id with explicit parameters (memory in KiB).
    ///
    /// # Errors
    ///
    /// Returns [`HashError`] when Argon2 refuses the parameters.
    pub fn new(memory_kib: u32, iterations: u32, parallelism: u32) -> Result<Self, HashError> {
        let params = Params::new(memory_kib, iterations, parallelism, Some(32))
            .map_err(|e| HashError(e.to_string()))?;
        Ok(Self { params })
    }

    fn engine(&self) -> Argon2<'static> {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, self.params.clone())
    }
}

impl Default for Argon2idScheme {
    fn default() -> Self {
        Self::new(
            Self::DEFAULT_MEMORY_KIB,
            Self::DEFAULT_ITERATIONS,
            Self::DEFAULT_PARALLELISM,
        )
        .expect("the default Argon2id parameters are valid")
    }
}

impl PasswordHashScheme for Argon2idScheme {
    fn id(&self) -> &'static str {
        "argon2id"
    }

    fn hash(&self, secret: &[u8]) -> Result<String, HashError> {
        let salt = SaltString::generate(&mut OsRng);
        self.engine()
            .hash_password(secret, &salt)
            .map(|hash| hash.to_string())
            .map_err(|e| HashError(e.to_string()))
    }

    fn verify(&self, stored: &PasswordHash<'_>, secret: &[u8]) -> bool {
        // The stored string names its own parameters; the engine's are only
        // the defaults it falls back to.
        self.engine().verify_password(secret, stored).is_ok()
    }

    fn is_current(&self, stored: &PasswordHash<'_>) -> bool {
        stored.algorithm.as_str() == self.id()
            && stored.version == Some(Version::V0x13.into())
            && Params::try_from(stored).is_ok_and(|p| {
                p.m_cost() == self.params.m_cost()
                    && p.t_cost() == self.params.t_cost()
                    && p.p_cost() == self.params.p_cost()
            })
    }
}
