#![no_main]

//! `parse_csr` is reachable from unauthenticated ACME, EST and SCEP
//! enrollment bodies (ADR 0066). It must be total and bounded over arbitrary
//! bytes, whether they arrive as raw text or wearing PEM armour.

use libfuzzer_sys::fuzz_target;
use opensesame_pki_core::csr::parse_csr;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    if let Ok(facts) = parse_csr(&text) {
        assert!(facts.sans.len() <= 256);
        assert!(!facts.public_key_der.is_empty());
    }

    // The same bytes wrapped in CSR armour, which is the shape an enrollment
    // endpoint actually receives.
    let armoured = format!(
        "-----BEGIN CERTIFICATE REQUEST-----\n{}\n-----END CERTIFICATE REQUEST-----\n",
        base64_encode(data)
    );
    let _ = parse_csr(&armoured);
});

/// Minimal standard-alphabet base64, so the target pulls in no extra crate.
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map_or(0, |v| u32::from(*v));
        let b2 = chunk.get(2).map_or(0, |v| u32::from(*v));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((triple >> (18 - index * 6)) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}
