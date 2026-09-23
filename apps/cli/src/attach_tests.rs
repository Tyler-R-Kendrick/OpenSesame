//! Unit tests for [`super`].

use std::io::Write as _;

use super::*;

#[test]
fn units_are_classified_by_what_the_gateway_needs() {
    let digest = "ab".repeat(32);
    match classify(&format!(".attachments/objects/ab/{digest}.oschunk")) {
        Some(Unit::Chunk { digest: got }) => assert_eq!(got, digest),
        _ => panic!("chunk should classify by digest"),
    }
    match classify("Taxes/2025.osattach") {
        Some(Unit::Manifest { logical }) => assert_eq!(logical, "Taxes/2025"),
        _ => panic!("manifest should classify by logical path"),
    }
    // Anything else in the store is not ours to replicate.
    assert!(classify("Dev/token.osseal").is_none());
    assert!(classify(".opensesame-key").is_none());
    // A chunk whose name is not a digest is not addressable by the endpoint.
    assert!(classify(".attachments/objects/zz/nothex.oschunk").is_none());
}

#[test]
fn query_characters_that_would_reshape_a_url_are_encoded() {
    assert_eq!(urlencoding_path("Taxes/2025"), "Taxes/2025");
    assert_eq!(urlencoding_path("a&b"), "a%26b");
    assert_eq!(urlencoding_path("a b"), "a%20b");
    assert_eq!(urlencoding_path("a#b"), "a%23b");
    assert_eq!(urlencoding_path("100%"), "100%25");
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
#[cfg(unix)]
fn revealed_plaintext_is_owner_only_from_its_first_byte() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("w2.pdf");
    // An existing world-readable document is replaced, not reused.
    std::fs::write(&dest, b"old").unwrap();
    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o644)).unwrap();
    let partial = dest.with_extension("partial");
    write_owner_only(&dest, |file| {
        // Mid-write, the only copy on disk is already 0600.
        assert_eq!(mode_of(&partial), 0o600);
        Ok(file.write_all(b"plaintext")?)
    })
    .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"plaintext");
    assert_eq!(mode_of(&dest), 0o600);
    assert!(!partial.exists());
}

#[test]
fn a_failed_write_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("doc.txt");
    // A stale partial from an earlier crash is replaced, never appended to.
    std::fs::write(dest.with_extension("partial"), b"stale").unwrap();
    let err = write_owner_only(&dest, |file| {
        file.write_all(b"half")?;
        anyhow::bail!("chunk failed to open")
    })
    .unwrap_err();
    assert!(err.to_string().contains("chunk failed"));
    assert!(!dest.exists());
    assert!(!dest.with_extension("partial").exists());
}

#[test]
#[cfg(unix)]
fn a_planted_partial_symlink_is_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("doc.txt");
    let target = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&target, dest.with_extension("partial")).unwrap();
    write_owner_only(&dest, |file| Ok(file.write_all(b"secret")?)).unwrap();
    assert!(!target.exists(), "plaintext must not land behind a symlink");
    assert_eq!(mode_of(&dest), 0o600);
}
