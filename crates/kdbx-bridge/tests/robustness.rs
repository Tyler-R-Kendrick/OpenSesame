//! Malformed input must produce a classified error and never a panic.
//!
//! The same entry point is fuzzed by `fuzz/fuzz_targets/kdbx_parse.rs`; these
//! are the named, table-driven cases that pin the classification.

mod common;

use opensesame_kdbx_bridge::{map_kdbx, KdbxError};

use common::{build_weak_bytes, FIXTURE_PASSWORD};

/// Discriminant-only view of [`KdbxError`], so cases can name an expectation
/// without pinning the `keepass` crate's message wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    NotKdbx,
    Unsupported,
    MissingCredentials,
    Locked,
    Malformed,
    Any,
}

fn classify(err: &KdbxError) -> Class {
    match err {
        KdbxError::NotKdbx(_) => Class::NotKdbx,
        KdbxError::UnsupportedVersion(_) => Class::Unsupported,
        KdbxError::MissingCredentials => Class::MissingCredentials,
        KdbxError::Locked => Class::Locked,
        KdbxError::Malformed(_) => Class::Malformed,
        KdbxError::Write(_) | KdbxError::Store(_) => Class::Any,
    }
}

fn kdbx1_header() -> Vec<u8> {
    // KDBX signature followed by the KeePass 1 secondary identifier.
    let mut bytes = vec![0x03, 0xd9, 0xa2, 0x9a];
    bytes.extend_from_slice(&0xb54b_fb65u32.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 32]);
    bytes
}

fn kdbx2_header() -> Vec<u8> {
    let mut bytes = vec![0x03, 0xd9, 0xa2, 0x9a];
    bytes.extend_from_slice(&0xb54b_fb66u32.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 32]);
    bytes
}

fn unknown_secondary_id() -> Vec<u8> {
    let mut bytes = vec![0x03, 0xd9, 0xa2, 0x9a];
    bytes.extend_from_slice(&0xdead_beefu32.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 32]);
    bytes
}

type MalformedCase = (&'static str, Vec<u8>, Option<&'static str>, Class);

fn malformed_cases(valid: &[u8]) -> Vec<MalformedCase> {
    let mut header_flipped = valid.to_vec();
    header_flipped[20] ^= 0xff;

    let mut body_flipped = valid.to_vec();
    let middle = body_flipped.len() / 2;
    body_flipped[middle] ^= 0xff;

    vec![
        ("empty", Vec::new(), Some(FIXTURE_PASSWORD), Class::NotKdbx),
        (
            "one byte",
            vec![0x03],
            Some(FIXTURE_PASSWORD),
            Class::NotKdbx,
        ),
        (
            "bad magic",
            vec![0xff; 4096],
            Some(FIXTURE_PASSWORD),
            Class::NotKdbx,
        ),
        (
            "signature only",
            vec![0x03, 0xd9, 0xa2, 0x9a],
            Some(FIXTURE_PASSWORD),
            Class::NotKdbx,
        ),
        (
            "signature plus zeros",
            {
                let mut bytes = vec![0x03, 0xd9, 0xa2, 0x9a];
                bytes.extend_from_slice(&[0u8; 64]);
                bytes
            },
            Some(FIXTURE_PASSWORD),
            Class::Unsupported,
        ),
        (
            "kdbx1 header",
            kdbx1_header(),
            Some(FIXTURE_PASSWORD),
            Class::Any,
        ),
        (
            "kdbx2 header",
            kdbx2_header(),
            Some(FIXTURE_PASSWORD),
            Class::Unsupported,
        ),
        (
            "unknown secondary id",
            unknown_secondary_id(),
            Some(FIXTURE_PASSWORD),
            Class::Unsupported,
        ),
        (
            "truncated header",
            valid[..40].to_vec(),
            Some(FIXTURE_PASSWORD),
            Class::Any,
        ),
        (
            "truncated mid-file",
            valid[..valid.len() / 2].to_vec(),
            Some(FIXTURE_PASSWORD),
            Class::Any,
        ),
        (
            "truncated by one byte",
            valid[..valid.len() - 1].to_vec(),
            Some(FIXTURE_PASSWORD),
            Class::Any,
        ),
        (
            "flipped header byte",
            header_flipped,
            Some(FIXTURE_PASSWORD),
            Class::Any,
        ),
        (
            "corrupt hmac block",
            body_flipped,
            Some(FIXTURE_PASSWORD),
            Class::Any,
        ),
        (
            "wrong password",
            valid.to_vec(),
            Some("wrong"),
            Class::Locked,
        ),
        (
            "no credentials",
            valid.to_vec(),
            None,
            Class::MissingCredentials,
        ),
    ]
}

#[test]
fn malformed_inputs_are_classified_and_never_panic() {
    let valid = build_weak_bytes();

    let mut trailing_junk = valid.clone();
    trailing_junk.extend_from_slice(&[0xaa; 512]);

    for (name, bytes, password, expected) in malformed_cases(&valid) {
        let result = map_kdbx(&bytes, password, None, None);
        let err = match result {
            Ok((items, _)) => panic!("{name}: expected an error, mapped {} items", items.len()),
            Err(err) => err,
        };
        if expected != Class::Any {
            assert_eq!(classify(&err), expected, "{name}: {err}");
        }
        // Errors classify the failure; they never echo credentials.
        let text = err.to_string();
        assert!(!text.contains(FIXTURE_PASSWORD), "{name} leaked a password");
    }

    // Trailing junk after a complete database must be handled, either way,
    // without panicking.
    let _ = map_kdbx(&trailing_junk, Some(FIXTURE_PASSWORD), None, None);
}

#[test]
fn every_truncation_of_a_real_database_is_handled() {
    let valid = build_weak_bytes();
    // Sample truncation points across the whole file rather than all of them:
    // the point is coverage of header, HMAC-block and payload boundaries.
    for len in (0..valid.len()).step_by(valid.len() / 12 + 1) {
        let bytes = &valid[..len];
        let _ = map_kdbx(bytes, Some(FIXTURE_PASSWORD), None, None);
    }
}

#[test]
fn arbitrary_bytes_with_a_valid_signature_never_panic() {
    for seed in 0u8..64 {
        let mut bytes = vec![0x03, 0xd9, 0xa2, 0x9a];
        bytes.extend((0..512u32).map(|i| i.to_le_bytes()[0].wrapping_mul(seed.wrapping_add(1))));
        let _ = map_kdbx(&bytes, Some("x"), None, None);
        let _ = map_kdbx(&bytes, None, Some(&bytes.clone()), None);
    }
}

#[test]
fn a_keyfile_of_arbitrary_bytes_is_not_a_panic() {
    let valid = build_weak_bytes();
    for keyfile in [
        Vec::new(),
        vec![0u8; 32],
        vec![0u8; 64],
        b"<KeyFile><Key><Data>not base64</Data></Key></KeyFile>".to_vec(),
        b"<KeyFile>".to_vec(),
    ] {
        let err = map_kdbx(&valid, Some(FIXTURE_PASSWORD), Some(&keyfile), None)
            .expect_err("fixture has no keyfile");
        assert!(
            matches!(err, KdbxError::Locked | KdbxError::Malformed(_)),
            "got {err:?}"
        );
    }
}
