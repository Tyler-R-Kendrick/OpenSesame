use super::*;

/// RFC 6238 Appendix B seed ASCII "12345678901234567890" as base32.
const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

fn rfc_uri(digits: u32) -> String {
    format!(
        "otpauth://totp/Example:alice@example.com?secret={RFC_SEED}&issuer=Example&digits={digits}&algorithm=SHA1&period=30"
    )
}

#[test]
fn rfc6238_sha1_8_digits() {
    let otp = parse_otpauth(&rfc_uri(8)).unwrap();
    let vectors: &[(u64, &str)] = &[
        (59, "94287082"),
        (1_111_111_109, "07081804"),
        (1_111_111_111, "14050471"),
        (1_234_567_890, "89005924"),
        (2_000_000_000, "69279037"),
        (20_000_000_000, "65353130"),
    ];
    for &(secs, expected) in vectors {
        assert_eq!(totp_code(&otp, secs).unwrap(), expected, "T={secs}");
    }
}

#[test]
fn rfc4226_hotp_vectors() {
    let otp = parse_otpauth(&format!(
        "otpauth://hotp/Example:alice@example.com?secret={RFC_SEED}&issuer=Example&digits=6&counter=0"
    ))
    .unwrap();
    let expected = [
        "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871",
        "520489",
    ];
    for (counter, code) in expected.iter().enumerate() {
        assert_eq!(hotp_code(&otp, counter as u64).unwrap(), *code);
    }
}

#[test]
fn hotp_requires_counter_and_type_specific_generation() {
    assert_eq!(
        parse_otpauth(&format!("otpauth://hotp/x?secret={RFC_SEED}"))
            .unwrap_err()
            .to_string(),
        "HOTP URI has no counter"
    );
    let totp = parse_otpauth(&rfc_uri(6)).unwrap();
    assert!(matches!(
        hotp_code(&totp, 0),
        Err(OtpError::UnsupportedType)
    ));
}

#[test]
fn validate_rejects_missing_secret() {
    assert!(!validate_otpauth("otpauth://totp/Example?issuer=Example"));
}

#[test]
fn rejects_ambiguous_or_silently_normalized_parameters() {
    for uri in [
        format!("otpauth://totp/x?secret={RFC_SEED}&secret={RFC_SEED}"),
        format!("otpauth://totp/x?secret={RFC_SEED}&digits=5"),
        format!("otpauth://totp/x?secret={RFC_SEED}&digits=garbage"),
        format!("otpauth://totp/x?secret={RFC_SEED}&period=0"),
        format!("otpauth://totp/x?secret={RFC_SEED}#fragment"),
    ] {
        assert!(parse_otpauth(&uri).is_err(), "accepted {uri}");
    }
}

#[test]
fn ten_digits_do_not_overflow() {
    let otp = parse_otpauth(&rfc_uri(10)).unwrap();
    let code = totp_code(&otp, 59).unwrap();
    assert_eq!(code.len(), 10);
    assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
}

#[test]
fn find_and_sync_trailer() {
    let trailer = "url: https://example.com\notpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\nnote: hi\n"; // gitleaks:allow -- RFC fixture
    let found = find_otpauth_in_trailer(trailer).unwrap();
    assert!(found.uri.contains("otpauth://totp/x"));
    let synced = sync_trailer_otp(trailer, Some(&found));
    assert_eq!(
        synced
            .lines()
            .filter(|l| l.starts_with("otpauth://"))
            .count(),
        1
    );
    assert!(synced.contains("url: https://example.com"));
    assert!(synced.contains("note: hi"));
}
