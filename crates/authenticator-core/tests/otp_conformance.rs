//! ADR 0139: the one-time-password cases `packages/vault-core` runs too
//! (`spec/conformance/otp-cases.json`).

use opensesame_authenticator_core::{
    hotp_code, parse_hotp, parse_totp, totp_code, OtpAlgorithm, OtpUri,
};
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("../../../spec/conformance/otp-cases.json"))
        .expect("otp-cases.json parses")
}

fn algorithm(otp: &OtpUri) -> &'static str {
    match otp.algorithm {
        OtpAlgorithm::Sha1 => "SHA-1",
        OtpAlgorithm::Sha256 => "SHA-256",
        OtpAlgorithm::Sha512 => "SHA-512",
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn check_parse(
    group: &str,
    parse: fn(&str) -> Result<OtpUri, opensesame_authenticator_core::OtpError>,
) {
    for case in cases()[group].as_array().expect("case list") {
        let name = case["name"].as_str().expect("name");
        let input = case["input"].as_str().expect("input");
        let parsed = parse(input);
        let Some(expect) = case.get("expect") else {
            assert!(
                parsed.is_err(),
                "{group} `{name}`: {input} should be refused"
            );
            continue;
        };
        let otp = parsed.unwrap_or_else(|e| panic!("{group} `{name}`: {input}: {e}"));
        assert_eq!(
            hex(&otp.secret),
            expect["secretHex"],
            "{group} `{name}` secret"
        );
        assert_eq!(
            u64::from(otp.digits),
            expect["digits"],
            "{group} `{name}` digits"
        );
        assert_eq!(
            algorithm(&otp),
            expect["algorithm"],
            "{group} `{name}` algorithm"
        );
        if let Some(period) = expect.get("period") {
            assert_eq!(otp.period, *period, "{group} `{name}` period");
        }
        if let Some(counter) = expect.get("counter") {
            assert_eq!(otp.counter, counter.as_u64(), "{group} `{name}` counter");
        }
    }
}

#[test]
fn parse_totp_matches_the_shared_cases() {
    check_parse("parseTotp", parse_totp);
}

#[test]
fn parse_hotp_matches_the_shared_cases() {
    check_parse("parseHotp", parse_hotp);
}

#[test]
fn codes_match_the_shared_cases() {
    for case in cases()["codes"].as_array().expect("case list") {
        let name = case["name"].as_str().expect("name");
        let uri = case["uri"].as_str().expect("uri");
        let code = if case["kind"] == "hotp" {
            let counter = case["counter"].as_u64().expect("counter");
            hotp_code(&parse_hotp(uri).expect(name), counter)
        } else {
            let at = case["atSeconds"].as_u64().expect("atSeconds");
            totp_code(&parse_totp(uri).expect(name), at)
        };
        assert_eq!(
            code.expect(name),
            case["code"].as_str().expect("code"),
            "{name}"
        );
    }
}
