//! Identical physical lease names across Node and native writer adapters; no authority.
use sha2::{Digest, Sha256};
use std::io;
/// Physical protocol namespace. Logical names are hashed as exact UTF-8, never normalized.
pub const PHYSICAL_WRITER_LEASE_PREFIX: &str = ".opensesame-lease-v1-";
/// Select the physical lease file for a bounded exact original logical lock name.
/// # Errors
/// Refuses empty, NUL-containing or greater-than512-byte logical names.
pub fn physical_writer_lease_name(logical: &str) -> io::Result<String> {
    if logical.is_empty() || logical.len() > 512 || logical.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid physical lease name",
        ));
    }
    Ok(format!(
        "{}{:x}",
        PHYSICAL_WRITER_LEASE_PREFIX,
        Sha256::digest(logical.as_bytes())
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_utf8_protocol_names_are_bounded_and_never_normalized() {
        assert_eq!(
            physical_writer_lease_name("opensesame.retired-credentials").unwrap(),
            ".opensesame-lease-v1-f160eb3bf56c3b827cea8eea60ae4806e16384029c5e116106564e00bce0e274"
        );
        assert_ne!(
            physical_writer_lease_name("é").unwrap(),
            physical_writer_lease_name("e\u{301}").unwrap()
        );
        assert_ne!(
            physical_writer_lease_name("opensesame.retired-credentials").unwrap(),
            physical_writer_lease_name("opensesame:vault-body:main").unwrap()
        );
        for name in ["".to_owned(), "x\0y".to_owned(), "x".repeat(513)] {
            assert!(physical_writer_lease_name(&name).is_err());
        }
        assert!(physical_writer_lease_name(&"x".repeat(512)).is_ok());
    }
}
