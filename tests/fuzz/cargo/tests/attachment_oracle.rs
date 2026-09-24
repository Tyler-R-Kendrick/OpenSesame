//! Drives the attachment fuzz oracle directly.
//!
//! cargo-fuzz supplies coverage-guided inputs, but it needs nightly and a
//! sanitizer, so the oracle itself can go unexercised in an ordinary build —
//! and an oracle with a bad index or a vacuous assertion is worse than none.
//! This runs it over inputs derived from raw byte strings, the same way
//! libfuzzer would, and simply requires that it never panics.

use arbitrary::{Arbitrary, Unstructured};
use opensesame_fuzz::fuzz_attachment_chunk;
use opensesame_fuzz::types::AttachmentChunkInput;

/// Cheap deterministic byte source; no rand dependency needed.
fn pseudo_random(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

#[test]
fn oracle_survives_arbitrary_inputs() {
    let mut built = 0usize;
    for seed in 0..256u64 {
        let bytes = pseudo_random(seed, 512);
        let mut u = Unstructured::new(&bytes);
        if let Ok(input) = AttachmentChunkInput::arbitrary(&mut u) {
            built += 1;
            fuzz_attachment_chunk(input);
        }
    }
    assert!(built > 0, "no inputs were constructed; the oracle ran on nothing");
}

#[test]
fn oracle_handles_the_degenerate_shapes() {
    // The shapes most likely to index out of bounds: empty everything, a
    // zero chunk_count, and a truncation offset past the end.
    let cases = [
        AttachmentChunkInput {
            key: [0u8; 32],
            attachment_id: [0u8; 16],
            plaintext: vec![],
            hostile_frame: vec![],
            chunk_index: 0,
            chunk_count: 0,
            prefix_with_magic: false,
            truncate_at: 0,
        },
        AttachmentChunkInput {
            key: [0xffu8; 32],
            attachment_id: [0xffu8; 16],
            plaintext: vec![7u8; 64],
            hostile_frame: vec![0u8; 8],
            chunk_index: u32::MAX,
            chunk_count: 0,
            prefix_with_magic: true,
            truncate_at: u16::MAX,
        },
    ];
    for case in cases {
        fuzz_attachment_chunk(case);
    }
}
