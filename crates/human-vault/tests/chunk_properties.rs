//! Generative properties for the attachment chunk primitive.
//!
//! The hand-written unit tests pick sizes and mutations a human thought of.
//! These let proptest pick instead, which is where the interesting cases live:
//! empty plaintext, sizes either side of a block boundary, mutations that land
//! on the magic, the nonce, the tag, or the last ciphertext byte.

use opensesame_human_vault::{
    derive_attachment_key, open_chunk, seal_chunk, ChunkAd, ItemDataKey, ENVELOPE_VERSION,
    OSCHUNK_HEADER_LEN,
};
use proptest::prelude::*;

fn ad(index: u32, count: u32) -> ChunkAd {
    ChunkAd {
        envelope_version: ENVELOPE_VERSION,
        attachment_id: "07070707070707070707070707070707".into(),
        item_id: "Taxes/w2".into(),
        chunk_index: index,
        chunk_count: count,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Whatever the bytes, sealing then opening returns exactly them.
    #[test]
    fn seal_open_round_trips(plaintext in prop::collection::vec(any::<u8>(), 0..4096), k in any::<u8>()) {
        let key = derive_attachment_key(&ItemDataKey([k; 32]), &[9u8; 16]);
        let frame = seal_chunk(&key, &plaintext, &ad(0, 1)).unwrap();
        prop_assert_eq!(open_chunk(&key, &frame, &ad(0, 1)).unwrap(), plaintext);
    }

    /// Flipping any single bit anywhere in the frame must break it. There is no
    /// byte of a sealed chunk that is safe to corrupt.
    #[test]
    fn any_single_bit_flip_fails_closed(
        plaintext in prop::collection::vec(any::<u8>(), 1..512),
        byte_idx in any::<prop::sample::Index>(),
        bit in 0u8..8,
    ) {
        let key = derive_attachment_key(&ItemDataKey([3u8; 32]), &[9u8; 16]);
        let mut frame = seal_chunk(&key, &plaintext, &ad(0, 1)).unwrap();
        let i = byte_idx.index(frame.len());
        frame[i] ^= 1 << bit;
        prop_assert!(open_chunk(&key, &frame, &ad(0, 1)).is_err());
    }

    /// Truncating a frame at any point must fail rather than return a prefix.
    #[test]
    fn any_truncation_fails_closed(
        plaintext in prop::collection::vec(any::<u8>(), 1..512),
        cut in any::<prop::sample::Index>(),
    ) {
        let key = derive_attachment_key(&ItemDataKey([3u8; 32]), &[9u8; 16]);
        let frame = seal_chunk(&key, &plaintext, &ad(0, 1)).unwrap();
        let at = cut.index(frame.len());
        prop_assert!(open_chunk(&key, &frame[..at], &ad(0, 1)).is_err());
    }

    /// A chunk sealed at one position must never open at another, for any
    /// position pair in any run length.
    #[test]
    fn position_is_never_interchangeable(
        count in 2u32..64,
        a in 0u32..64,
        b in 0u32..64,
    ) {
        prop_assume!(a < count && b < count && a != b);
        let key = derive_attachment_key(&ItemDataKey([5u8; 32]), &[9u8; 16]);
        let frame = seal_chunk(&key, b"payload", &ad(a, count)).unwrap();
        prop_assert!(open_chunk(&key, &frame, &ad(b, count)).is_err());
    }

    /// Distinct attachment ids must yield distinct keys, so identical documents
    /// never share ciphertext. This is what makes content addressing safe.
    #[test]
    fn distinct_attachment_ids_give_distinct_ciphertext(x in any::<u8>(), y in any::<u8>()) {
        prop_assume!(x != y);
        let idk = ItemDataKey([1u8; 32]);
        let ka = derive_attachment_key(&idk, &[x; 16]);
        let kb = derive_attachment_key(&idk, &[y; 16]);
        prop_assert_ne!(ka.0, kb.0);
        let fa = seal_chunk(&ka, b"same document", &ad(0, 1)).unwrap();
        let fb = seal_chunk(&kb, b"same document", &ad(0, 1)).unwrap();
        // Bodies differ, and neither key opens the other's frame.
        prop_assert_ne!(&fa[OSCHUNK_HEADER_LEN..], &fb[OSCHUNK_HEADER_LEN..]);
        prop_assert!(open_chunk(&ka, &fb, &ad(0, 1)).is_err());
    }
}
