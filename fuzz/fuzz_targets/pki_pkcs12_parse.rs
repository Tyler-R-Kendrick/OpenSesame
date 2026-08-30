#![no_main]

//! `parse_pkcs12` opens operator-supplied keystores during certificate import
//! (ADR 0066). It must be total and bounded over arbitrary bytes and
//! arbitrary passwords, and must never hand back an entry it could not parse.

use libfuzzer_sys::fuzz_target;
use opensesame_pki_core::bundle::parse_pkcs12;

fuzz_target!(|data: &[u8]| {
    // Split the input so the fuzzer can steer the password as well as the
    // keystore body.
    let split = data.first().map_or(0, |byte| usize::from(*byte) % 32);
    let split = split.min(data.len());
    let (password, body) = data.split_at(split);
    let password = String::from_utf8_lossy(password);

    if let Ok(entries) = parse_pkcs12(body, &password) {
        for entry in entries {
            assert!(entry.certificate_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        }
    }
    let _ = parse_pkcs12(data, "");
});
