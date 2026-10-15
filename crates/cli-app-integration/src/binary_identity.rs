//! Binary identity pins for enroll and daemon attestation (D7-2 b).

use sha2::{Digest, Sha256};

/// SHA-256 hex of this process executable, when readable.
#[must_use]
pub fn process_executable_sha256_hex() -> Option<String> {
    #[cfg(unix)]
    {
        let path = std::fs::read_link("/proc/self/exe").ok()?;
        let bytes = std::fs::read(path).ok()?;
        return Some(hex::encode(Sha256::digest(bytes)));
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// Compare a wire pin to this process. Empty expected means "pin not configured".
#[must_use]
pub fn pin_matches(expected_hex: &str) -> bool {
    let trimmed = expected_hex.trim();
    if trimmed.is_empty() {
        return true;
    }
    match process_executable_sha256_hex() {
        Some(actual) => actual == trimmed,
        None => false,
    }
}
