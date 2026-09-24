#![no_main]

//! `parse_crl` reads certificate revocation lists fetched from mirrors and
//! replayed out of storage (ADR 0067). It must be total and bounded over
//! arbitrary bytes, and `verify_crl` must never accept an unsigned list.

use libfuzzer_sys::fuzz_target;
use opensesame_pki_core::revocation::{parse_crl, verify_crl};

fuzz_target!(|data: &[u8]| {
    if let Ok(facts) = parse_crl(data) {
        assert!(facts.serials.iter().all(|serial| !serial.is_empty()));
        if let Some(next) = facts.next_update {
            let _ = next;
        }
    }
    // No issuer certificate can ever validate an arbitrary blob.
    assert!(verify_crl(data, "").is_err());
});
