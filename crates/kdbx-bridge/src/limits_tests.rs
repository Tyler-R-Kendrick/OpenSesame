//! Unit tests for [`super`], over hand-built outer headers.

use super::*;

fn len32(len: usize) -> [u8; 4] {
    u32::try_from(len)
        .expect("fixture length fits u32")
        .to_le_bytes()
}

/// A KDF variant dictionary holding `entries`, in order.
fn dictionary(entries: &[(&[u8], u8, Vec<u8>)]) -> Vec<u8> {
    let mut vd = Vec::new();
    vd.extend_from_slice(&0x0100u16.to_le_bytes());
    for (name, value_type, value) in entries {
        vd.push(*value_type);
        vd.extend_from_slice(&len32(name.len()));
        vd.extend_from_slice(name);
        vd.extend_from_slice(&len32(value.len()));
        vd.extend_from_slice(value);
    }
    vd.push(VD_END);
    vd
}

fn version_header(secondary: u32, major: u16) -> Vec<u8> {
    let mut out = KDBX_SIGNATURE.to_vec();
    out.extend_from_slice(&secondary.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // minor
    out.extend_from_slice(&major.to_le_bytes());
    out
}

/// A KDBX 4 header of `fields` (`u32` lengths), then the end marker.
fn kdbx4(fields: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut out = version_header(KEEPASS_LATEST_ID, 4);
    for (id, data) in fields {
        out.push(*id);
        out.extend_from_slice(&len32(data.len()));
        out.extend_from_slice(data);
    }
    out.push(HEADER_END);
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

/// A KDBX 3 header of `fields` (`u16` lengths), then the end marker.
fn kdbx3(fields: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut out = version_header(KEEPASS_LATEST_ID, 3);
    for (id, data) in fields {
        out.push(*id);
        let len = u16::try_from(data.len()).expect("fixture field fits u16");
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(data);
    }
    out.push(HEADER_END);
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Build a KDBX 4 header carrying one KDF variant dictionary, after a field
/// the walker must skip over.
fn header_with(entries: &[(&[u8], u8, Vec<u8>)]) -> Vec<u8> {
    kdbx4(&[(4, vec![0u8; 32]), (HEADER_KDF_PARAMS, dictionary(entries))])
}

fn u64v(value: u64) -> Vec<u8> {
    value.to_le_bytes().to_vec()
}

fn u32v(value: u32) -> Vec<u8> {
    value.to_le_bytes().to_vec()
}

fn is_malformed(bytes: &[u8]) -> bool {
    matches!(check_kdf_limits(bytes), Err(KdbxError::Malformed(_)))
}

#[test]
fn realistic_argon2_parameters_pass() {
    let header = header_with(&[
        (b"M", VD_U64, u64v(64 * 1024 * 1024)),
        (b"I", VD_U64, u64v(2)),
        (b"P", VD_U32, u32v(4)),
    ]);
    assert!(check_kdf_limits(&header).is_ok());
    // KeePassXC's own ceiling-ish settings: 1 GiB × 16 passes.
    let heavy = header_with(&[(b"M", VD_U64, u64v(1 << 30)), (b"I", VD_U64, u64v(16))]);
    assert!(check_kdf_limits(&heavy).is_ok());
}

#[test]
fn a_terabyte_of_memory_is_refused() {
    let header = header_with(&[(b"M", VD_U64, u64v(1 << 40))]);
    let err = check_kdf_limits(&header).unwrap_err();
    assert!(matches!(err, KdbxError::Malformed(_)), "{err:?}");
    assert!(err.to_string().contains("memory cost"));
}

#[test]
fn absurd_iteration_lane_and_round_counts_are_refused() {
    assert!(is_malformed(&header_with(&[(
        b"I",
        VD_U64,
        u64v(u64::MAX)
    )])));
    assert!(is_malformed(&header_with(&[(
        b"P",
        VD_U32,
        u32v(u32::MAX)
    )])));
    assert!(is_malformed(&header_with(&[(
        b"R",
        VD_U64,
        u64v(u64::MAX)
    )])));
}

#[test]
fn memory_times_iterations_is_capped_even_when_each_is_in_range() {
    let header = header_with(&[
        (b"M", VD_U64, u64v(MAX_KDF_MEMORY_BYTES)),
        (b"I", VD_U64, u64v(MAX_KDF_ITERATIONS)),
    ]);
    let err = check_kdf_limits(&header).unwrap_err();
    assert!(err.to_string().contains("KDF work"), "{err}");
}

#[test]
fn limits_are_inclusive_at_the_boundary() {
    let at = header_with(&[(b"M", VD_U64, u64v(MAX_KDF_MEMORY_BYTES))]);
    assert!(check_kdf_limits(&at).is_ok());
    let over = header_with(&[(b"M", VD_U64, u64v(MAX_KDF_MEMORY_BYTES + 1))]);
    assert!(check_kdf_limits(&over).is_err());
}

#[test]
fn a_second_kdf_parameters_field_is_refused() {
    // The parser keeps the last field; a benign first one must not vouch for it.
    let benign = dictionary(&[(b"M", VD_U64, u64v(64 << 20))]);
    let hostile = dictionary(&[(b"M", VD_U64, u64v(1 << 40))]);
    let header = kdbx4(&[
        (HEADER_KDF_PARAMS, benign.clone()),
        (HEADER_KDF_PARAMS, hostile),
    ]);
    assert!(is_malformed(&header));
    let twice = kdbx4(&[
        (HEADER_KDF_PARAMS, benign.clone()),
        (HEADER_KDF_PARAMS, benign),
    ]);
    assert!(is_malformed(&twice));
}

#[test]
fn the_last_duplicate_dictionary_entry_is_the_one_screened() {
    let header = header_with(&[
        (b"M", VD_U64, u64v(64 << 20)),
        (b"M", VD_U64, u64v(1 << 40)),
    ]);
    assert!(is_malformed(&header));
    // A named value too short for the parser's read is refused, not skipped.
    assert!(is_malformed(&header_with(&[(b"M", VD_U64, vec![0xff; 3])])));
}

#[test]
fn kdbx3_transform_rounds_are_screened() {
    let ok = kdbx3(&[(4, vec![0u8; 32]), (HEADER_TRANSFORM_ROUNDS, u64v(60_000))]);
    assert!(check_kdf_limits(&ok).is_ok());
    let at = kdbx3(&[(HEADER_TRANSFORM_ROUNDS, u64v(MAX_AES_KDF_ROUNDS))]);
    assert!(check_kdf_limits(&at).is_ok());
    let hostile = kdbx3(&[(HEADER_TRANSFORM_ROUNDS, u64v(u64::MAX))]);
    let err = check_kdf_limits(&hostile).unwrap_err();
    assert!(err.to_string().contains("AES-KDF round count"), "{err}");
    // Every occurrence counts, whichever the parser keeps.
    let dup = kdbx3(&[
        (HEADER_TRANSFORM_ROUNDS, u64v(u64::MAX)),
        (HEADER_TRANSFORM_ROUNDS, u64v(60_000)),
    ]);
    assert!(is_malformed(&dup));
    assert!(is_malformed(&kdbx3(&[(
        HEADER_TRANSFORM_ROUNDS,
        vec![1, 2, 3]
    )])));
}

#[test]
fn keepass1_transform_rounds_are_screened() {
    let mut header = version_header(KEEPASS_1_ID, 0);
    header.resize(KDB1_ROUNDS_OFFSET + 4, 0);
    header[KDB1_ROUNDS_OFFSET..].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(is_malformed(&header));
    header[KDB1_ROUNDS_OFFSET..].copy_from_slice(&60_000u32.to_le_bytes());
    assert!(check_kdf_limits(&header).is_ok());
}

#[test]
fn truncated_kdbx_headers_fail_closed() {
    for full in [
        header_with(&[(b"M", VD_U64, u64v(1 << 40))]),
        kdbx3(&[(HEADER_TRANSFORM_ROUNDS, u64v(u64::MAX))]),
    ] {
        // Every prefix that names a KDBX 3/4 version but stops short of the
        // end marker is refused — never a panic, never passed on unscreened.
        for len in VERSION_HEADER_BYTES..full.len() {
            assert!(is_malformed(&full[..len]), "prefix of {len} bytes");
        }
        for len in 0..VERSION_HEADER_BYTES {
            let _ = check_kdf_limits(&full[..len]);
        }
    }
    // No recognizable version header: the parser rejects it before any KDF.
    assert!(check_kdf_limits(&[]).is_ok());
    assert!(check_kdf_limits(&[0xff; 12]).is_ok());
}

#[test]
fn a_header_field_claiming_a_huge_length_is_refused_not_scanned() {
    let mut header = version_header(KEEPASS_LATEST_ID, 4);
    header.push(4);
    header.extend_from_slice(&u32::MAX.to_le_bytes());
    header.extend_from_slice(&[0u8; 64]);
    assert!(is_malformed(&header));
    // A stream of small fields is capped too: the walk never follows it far.
    let many = kdbx3(&vec![(1u8, vec![0u8; 1024]); (MAX_HEADER_BYTES / 1024) + 2]);
    assert!(is_malformed(&many));
}

#[test]
fn a_dictionary_with_wrong_value_types_is_ignored() {
    // `M` declared as a u32 is not the Argon2 memory field.
    let header = header_with(&[(b"M", VD_U32, u32v(u32::MAX))]);
    assert!(check_kdf_limits(&header).is_ok());
}
