#![no_main]

//! `parse_ocsp_request` is the entry point of the unauthenticated `/ocsp/*`
//! responder (ADR 0067). It must be total and bounded over arbitrary bytes,
//! and anything it accepts must re-encode to a request that parses back to the
//! same facts.

use libfuzzer_sys::fuzz_target;
use opensesame_pki_core::revocation::{
    build_ocsp_request, parse_ocsp_request, parse_ocsp_response,
};

fuzz_target!(|data: &[u8]| {
    if let Ok(facts) = parse_ocsp_request(data) {
        assert!(!facts.serial_hex.is_empty());
        if let Ok(rebuilt) = build_ocsp_request(&facts) {
            assert_eq!(parse_ocsp_request(&rebuilt).unwrap(), facts);
        }
    }
    let _ = parse_ocsp_response(data);
});
