//! Stable opaque entry identifiers for foreign password-manager protocols.

use std::fmt::Write as _;

pub(super) fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

/// A stable, non-secret opaque id for an entry, used where a foreign protocol
/// addresses entries by UUID. Derived from the logical path only.
#[must_use]
pub fn entry_uuid(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"opensesame-entry\0");
    hasher.update(name.as_bytes());
    hex(&hasher.finalize()[..16])
}
