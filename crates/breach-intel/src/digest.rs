//! k-anonymity digests for the Pwned Passwords range API.
//!
//! Checking whether a password is in a breach corpus normally means telling
//! somebody the password. The range API's whole design is to avoid that: the
//! client hashes the secret with SHA-1, sends the **first five hex characters
//! only**, and receives every suffix sharing that prefix — on the order of
//! several hundred — then matches locally. The service learns that somebody
//! asked about one bucket in 2^20, and never which member of it.
//!
//! Two rules keep that true on our side, and both are enforced by the types:
//!
//! - [`PwnedDigest::of_secret`] is the only way in, and it does not retain the
//!   plaintext. The caller holds the secret for the length of one call.
//! - The digest is itself sensitive — a SHA-1 of a password is a crackable
//!   artifact, not an anonymous token — so it zeroizes on drop and its `Debug`
//!   shows the prefix only. It is never persisted and never logged.
//!
//! SHA-1 is used because the corpus is indexed by SHA-1. It is not a security
//! choice here and carries no security claim: it is the lookup key of somebody
//! else's index.

use std::fmt;

use sha1::{Digest as _, Sha1};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Hex characters sent to the service.
pub const PREFIX_CHARS: usize = 5;
/// Hex characters kept locally and matched against the response.
pub const SUFFIX_CHARS: usize = 35;
/// Length of a full SHA-1 in hex.
pub const DIGEST_CHARS: usize = PREFIX_CHARS + SUFFIX_CHARS;

/// A password's SHA-1, split the way the range API expects.
///
/// Uppercase hex throughout: the API returns uppercase suffixes, and matching
/// without a case fold is one less thing to get wrong.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct PwnedDigest {
    hex: String,
}

impl PwnedDigest {
    /// Hash a secret into its range-API digest.
    ///
    /// Takes the secret by reference for one call and keeps nothing: what is
    /// stored is the hash, and what leaves the host is
    /// [`PwnedDigest::prefix`].
    #[must_use]
    pub fn of_secret(secret: &str) -> Self {
        Self::of_bytes(secret.as_bytes())
    }

    /// Hash raw bytes, for a secret that is not valid UTF-8.
    #[must_use]
    pub fn of_bytes(secret: &[u8]) -> Self {
        let mut hasher = Sha1::new();
        hasher.update(secret);
        let mut hex = String::with_capacity(DIGEST_CHARS);
        for byte in hasher.finalize() {
            use fmt::Write as _;
            // Writing into a String cannot fail; the result is discarded
            // rather than unwrapped so a formatting change cannot panic here.
            let _ = write!(hex, "{byte:02X}");
        }
        Self { hex }
    }

    /// The five characters sent to the service.
    #[must_use]
    pub fn prefix(&self) -> &str {
        &self.hex[..PREFIX_CHARS]
    }

    /// The thirty-five characters that never leave the host.
    #[must_use]
    pub fn suffix(&self) -> &str {
        &self.hex[PREFIX_CHARS..]
    }
}

/// Shows the prefix only.
///
/// The prefix is the part we already disclose to the service, so it is safe in
/// a log line and useful for correlating one lookup. The suffix is what makes
/// the digest crackable, and a `{:?}` in a stray `tracing` call is exactly how
/// it would otherwise escape.
impl fmt::Debug for PwnedDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PwnedDigest")
            .field("prefix", &self.prefix())
            .field("suffix", &"[REDACTED]")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-1("password") — the canonical worked example in HIBP's own API
    /// documentation, so this pins us to the same bucket their docs describe.
    const PASSWORD_SHA1: &str = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8";

    #[test]
    fn a_known_secret_hashes_to_its_documented_digest() {
        let digest = PwnedDigest::of_secret("password");
        assert_eq!(digest.prefix(), &PASSWORD_SHA1[..PREFIX_CHARS]);
        assert_eq!(digest.suffix(), &PASSWORD_SHA1[PREFIX_CHARS..]);
    }

    #[test]
    fn only_five_characters_are_ever_disclosed() {
        let digest = PwnedDigest::of_secret("correct horse battery staple");
        assert_eq!(digest.prefix().chars().count(), PREFIX_CHARS);
        assert_eq!(digest.suffix().chars().count(), SUFFIX_CHARS);
    }

    #[test]
    fn digests_are_uppercase_hex_so_matching_needs_no_case_fold() {
        let digest = PwnedDigest::of_secret("password");
        for part in [digest.prefix(), digest.suffix()] {
            assert!(
                part.chars()
                    .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase()),
                "{part} is not uppercase hex",
            );
        }
    }

    #[test]
    fn bytes_and_text_agree_for_the_same_secret() {
        assert_eq!(
            PwnedDigest::of_secret("password"),
            PwnedDigest::of_bytes(b"password"),
        );
    }

    #[test]
    fn an_empty_secret_still_produces_a_well_formed_digest() {
        let digest = PwnedDigest::of_secret("");
        assert_eq!(digest.prefix().chars().count(), PREFIX_CHARS);
        assert_eq!(digest.suffix().chars().count(), SUFFIX_CHARS);
    }

    #[test]
    fn debug_never_shows_the_suffix() {
        let digest = PwnedDigest::of_secret("password");
        let shown = format!("{digest:?}");
        assert!(shown.contains(digest.prefix()));
        assert!(
            !shown.contains(digest.suffix()),
            "a debug print must not make the digest crackable: {shown}",
        );
        assert!(shown.contains("[REDACTED]"));
    }

    #[test]
    fn the_plaintext_never_appears_in_a_debug_print() {
        let shown = format!("{:?}", PwnedDigest::of_secret("hunter2"));
        assert!(!shown.contains("hunter2"));
    }

    #[test]
    fn different_secrets_land_in_different_buckets_or_at_least_differ() {
        let first = PwnedDigest::of_secret("password");
        let second = PwnedDigest::of_secret("password1");
        assert_ne!(first.suffix(), second.suffix());
    }
}
