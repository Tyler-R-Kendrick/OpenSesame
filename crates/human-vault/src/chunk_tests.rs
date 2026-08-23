//! Direct unit tests for the attachment chunk crypto in `lib.rs`.
//!
//! These sit beside the sealed-store pact suite, which exercises the same
//! primitives end to end through real attachments. What is covered here is the
//! frame and associated-data contract itself: every field bound into `ChunkAd`
//! must be load-bearing, and a malformed frame must fail closed rather than
//! panic.

use super::*;

fn ad(index: u32, count: u32) -> ChunkAd {
    ChunkAd {
        envelope_version: ENVELOPE_VERSION,
        attachment_id: "0123456789abcdef0123456789abcdef".into(),
        item_id: "Taxes/w2".into(),
        chunk_index: index,
        chunk_count: count,
    }
}

fn key() -> AttachmentKey {
    derive_attachment_key(&ItemDataKey([3u8; 32]), &[9u8; 16])
}

#[test]
fn chunk_round_trips_at_edge_sizes() {
    let k = key();
    for size in [0usize, 1, 31, 4096] {
        let pt = vec![0xABu8; size];
        let frame = seal_chunk(&k, &pt, &ad(0, 1)).unwrap();
        assert!(frame.starts_with(OSCHUNK_MAGIC));
        assert_eq!(open_chunk(&k, &frame, &ad(0, 1)).unwrap(), pt);
    }
}

#[test]
fn every_bound_field_is_load_bearing() {
    let k = key();
    let frame = seal_chunk(&k, b"payload", &ad(0, 3)).unwrap();
    // Reordering the chunk within its run.
    assert!(open_chunk(&k, &frame, &ad(1, 3)).is_err());
    // Truncating the run it belongs to.
    assert!(open_chunk(&k, &frame, &ad(0, 2)).is_err());
    // Moving it to another attachment.
    let mut other = ad(0, 3);
    other.attachment_id = "ffffffffffffffffffffffffffffffff".into();
    assert!(open_chunk(&k, &frame, &other).is_err());
    // Moving it to another store path.
    let mut moved = ad(0, 3);
    moved.item_id = "Taxes/1099".into();
    assert!(open_chunk(&k, &frame, &moved).is_err());
}

#[test]
fn a_different_key_cannot_open_a_frame() {
    let frame = seal_chunk(&key(), b"payload", &ad(0, 1)).unwrap();
    let other = derive_attachment_key(&ItemDataKey([3u8; 32]), &[8u8; 16]);
    assert!(open_chunk(&other, &frame, &ad(0, 1)).is_err());
}

#[test]
fn derivation_is_stable_and_separated() {
    let idk = ItemDataKey([1u8; 32]);
    assert_eq!(
        derive_attachment_key(&idk, &[2u8; 16]).0,
        derive_attachment_key(&idk, &[2u8; 16]).0
    );
    assert_ne!(
        derive_attachment_key(&idk, &[2u8; 16]).0,
        derive_attachment_key(&idk, &[3u8; 16]).0
    );
    assert_ne!(
        derive_attachment_key(&idk, &[2u8; 16]).0,
        derive_attachment_key(&ItemDataKey([4u8; 32]), &[2u8; 16]).0
    );
}

#[test]
fn malformed_frames_fail_closed_without_panicking() {
    let k = key();
    let frame = seal_chunk(&k, b"payload", &ad(0, 1)).unwrap();

    // Anything too short to hold a nonce and a tag is refused before indexing.
    for len in 0..frame.len().min(OSCHUNK_HEADER_LEN + 16) {
        assert!(open_chunk(&k, &frame[..len], &ad(0, 1)).is_err());
    }
    // Wrong magic.
    let mut wrong_magic = frame.clone();
    wrong_magic[0] ^= 0xFF;
    assert!(open_chunk(&k, &wrong_magic, &ad(0, 1)).is_err());
    // Flipped nonce byte.
    let mut flipped_nonce = frame.clone();
    flipped_nonce[OSCHUNK_MAGIC.len()] ^= 0x01;
    assert!(open_chunk(&k, &flipped_nonce, &ad(0, 1)).is_err());
    // Flipped ciphertext byte.
    let mut flipped_ct = frame.clone();
    let last = flipped_ct.len() - 1;
    flipped_ct[last] ^= 0x01;
    assert!(open_chunk(&k, &flipped_ct, &ad(0, 1)).is_err());
}

#[test]
fn an_index_outside_the_run_is_refused_on_both_paths() {
    let k = key();
    assert!(seal_chunk(&k, b"x", &ad(1, 1)).is_err());
    let frame = seal_chunk(&k, b"x", &ad(0, 1)).unwrap();
    assert!(open_chunk(&k, &frame, &ad(2, 1)).is_err());
}

#[test]
fn an_unsupported_version_is_refused() {
    let k = key();
    let mut bad = ad(0, 1);
    bad.envelope_version = 99;
    assert!(matches!(
        seal_chunk(&k, b"x", &bad),
        Err(VaultCryptoError::UnsupportedVersion(99))
    ));
}

#[test]
fn nonces_do_not_repeat_across_seals() {
    let k = key();
    let a = seal_chunk(&k, b"same", &ad(0, 1)).unwrap();
    let b = seal_chunk(&k, b"same", &ad(0, 1)).unwrap();
    let nonce_of = |f: &[u8]| f[OSCHUNK_MAGIC.len()..OSCHUNK_HEADER_LEN].to_vec();
    assert_ne!(nonce_of(&a), nonce_of(&b));
    // Identical plaintext under one key must still produce distinct frames.
    assert_ne!(a, b);
}
