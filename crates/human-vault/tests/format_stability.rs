//! Characterization tests pinning the on-disk attachment format.
//!
//! Sealed attachments are archives: bytes written today must still open years
//! from now, after refactors nobody remembers. Every value in this file was
//! captured from a real run and is now a contract. A failure here does not mean
//! "update the expected value" — it means the change under test would make
//! every attachment already sealed on disk permanently unreadable.
//!
//! The three things pinned are exactly the three that would silently break
//! existing archives: the key derivation, the associated-data digest, and the
//! frame layout itself.

use opensesame_human_vault::{
    chunk_ad_digest, derive_attachment_key, open_chunk, ChunkAd, ItemDataKey, OSCHUNK_HEADER_LEN,
    OSCHUNK_MAGIC, ENVELOPE_VERSION,
};

/// Fixed inputs. These are arbitrary but frozen.
const ITEM_KEY: [u8; 32] = [0x42u8; 32];
const ATTACHMENT_ID_BYTES: [u8; 16] = [0x07u8; 16];
const ATTACHMENT_ID_HEX: &str = "07070707070707070707070707070707";

/// A chunk frame sealed once, by hand, with the values above.
const GOLDEN_FRAME_HEX: &str = "4f5343484e4b310a4d0732b3b85da7e5463404feb6c20d978438ffef088a1bb0\
6714e2e7389c6d143e5470b2d6a29a9ce9414cbd08a857f12a7544b6675eef99cd12402f7d0701";

const GOLDEN_PLAINTEXT: &[u8] = b"golden vector plaintext";

fn golden_ad() -> ChunkAd {
    ChunkAd {
        envelope_version: ENVELOPE_VERSION,
        attachment_id: ATTACHMENT_ID_HEX.into(),
        item_id: "Taxes/w2".into(),
        chunk_index: 0,
        chunk_count: 2,
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn key_derivation_is_frozen() {
    // Changing the HKDF info string, the salt, or the ikm would all still look
    // like working code — and would orphan every attachment ever sealed.
    let key = derive_attachment_key(&ItemDataKey(ITEM_KEY), &ATTACHMENT_ID_BYTES);
    let hex: String = key.0.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex, "742afdbd3039256b9da1ebaaeece83a4ce651a82b9a53c266ef76a1b9ff61fb6",
        "attachment key derivation changed; every sealed attachment is now unreadable"
    );
}

#[test]
fn associated_data_digest_is_frozen() {
    // The AD digest is the AEAD's aad. Renaming a ChunkAd field, reordering the
    // struct, or switching the hash changes this and breaks every frame.
    assert_eq!(
        chunk_ad_digest(&golden_ad()).unwrap(),
        "blake3:96b1b464a754d94b2c12a24bf2dfa62a723bf0ede9a858a7c9fd2560f33b3a9f",
        "chunk associated-data digest changed; existing frames will not authenticate"
    );
}

#[test]
fn a_frame_sealed_earlier_still_opens() {
    // The end-to-end lock: real ciphertext, captured once, must keep decrypting.
    let key = derive_attachment_key(&ItemDataKey(ITEM_KEY), &ATTACHMENT_ID_BYTES);
    let frame = unhex(GOLDEN_FRAME_HEX);
    let opened = open_chunk(&key, &frame, &golden_ad())
        .expect("a frame sealed by an earlier version must still open");
    assert_eq!(opened, GOLDEN_PLAINTEXT);
}

#[test]
fn frame_geometry_is_frozen() {
    assert_eq!(OSCHUNK_MAGIC, b"OSCHNK1\n", "frame magic is part of the format");
    assert_eq!(OSCHUNK_HEADER_LEN, 32, "8 magic + 24 nonce");
    let frame = unhex(GOLDEN_FRAME_HEX);
    assert!(frame.starts_with(OSCHUNK_MAGIC));
    // 23 bytes of plaintext + 32 header + 16 Poly1305 tag.
    assert_eq!(frame.len(), GOLDEN_PLAINTEXT.len() + OSCHUNK_HEADER_LEN + 16);
}

#[test]
fn the_golden_ad_is_actually_load_bearing() {
    // Guard against the pin above passing vacuously: if the AD were ignored,
    // opening under a different one would still succeed.
    let key = derive_attachment_key(&ItemDataKey(ITEM_KEY), &ATTACHMENT_ID_BYTES);
    let frame = unhex(GOLDEN_FRAME_HEX);
    let mut wrong = golden_ad();
    wrong.chunk_index = 1;
    assert!(open_chunk(&key, &frame, &wrong).is_err());
}
