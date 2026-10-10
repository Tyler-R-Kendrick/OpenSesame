//! A byte string that is a secret: wiped on drop, and never printed.

use std::fmt;

use zeroize::Zeroizing;

/// Secret bytes. `Debug` prints `[REDACTED]`, so a struct that holds one can
/// derive `Debug` without a `{:?}` ever reaching a log line (ADR 0157).
#[derive(Clone)]
pub struct Secret(Zeroizing<Vec<u8>>);

impl Secret {
    /// Take ownership of `bytes`; they are wiped when this value is dropped.
    #[must_use]
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// The bytes. The caller is responsible for not copying them somewhere
    /// that outlives the work.
    #[must_use]
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// Length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// True when there are no bytes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::Secret;

    #[test]
    fn debug_never_shows_the_bytes() {
        let secret = Secret::new(vec![0xAB; 8]);
        assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
        assert_eq!(secret.len(), 8);
        assert!(!secret.is_empty());
    }
}
