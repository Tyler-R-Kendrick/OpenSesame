//! The bounded reader: a well-formed answer parses, everything else is
//! `malformed_response`, and error codes map to the frozen set.

use super::*;

fn answer(credentials: &str) -> String {
    format!(
        "<AssumeRoleResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\">\
         <AssumeRoleResult><Credentials>{credentials}</Credentials></AssumeRoleResult>\
         <ResponseMetadata><RequestId>req-0001</RequestId></ResponseMetadata>\
         </AssumeRoleResponse>"
    )
}

const GOOD: &str = "<AccessKeyId>ASIAMINTEDDUMMY00001</AccessKeyId>\
    <SecretAccessKey>MintedDummySecret0123456789abcdef</SecretAccessKey>\
    <SessionToken>MintedDummySessionToken0123456789+/==</SessionToken>\
    <Expiration>2026-10-17T12:15:00Z</Expiration>";

#[test]
fn a_documented_answer_parses() {
    let parsed = parse_assume_role(answer(GOOD).as_bytes()).unwrap();
    assert_eq!(parsed.credentials.access_key_id, "ASIAMINTEDDUMMY00001");
    assert_eq!(parsed.request_id, "req-0001");
    assert_eq!(
        parsed.credentials.expiration.to_rfc3339(),
        "2026-10-17T12:15:00+00:00"
    );
    let shown = format!("{parsed:?}");
    assert!(!shown.contains("MintedDummySecret"), "{shown}");
    assert!(!shown.contains("MintedDummySessionToken"), "{shown}");
}

#[test]
fn anything_short_of_a_complete_answer_is_refused() {
    let missing_token = GOOD.replace(
        "<SessionToken>MintedDummySessionToken0123456789+/==</SessionToken>",
        "",
    );
    let duplicated = format!("{GOOD}<AccessKeyId>ASIAOTHERDUMMY000001</AccessKeyId>");
    let entity = GOOD.replace("Secret0123", "Secret&amp;0123");
    let bad_shape = GOOD.replace("ASIAMINTEDDUMMY00001", "asia-lower");
    let bad_time = GOOD.replace("2026-10-17T12:15:00Z", "tomorrow");
    let deep = format!(
        "{}{}{}",
        "<a>".repeat(MAX_DEPTH + 1),
        answer(GOOD),
        "</a>".repeat(MAX_DEPTH + 1)
    );
    let long_value = GOOD.replace("0123456789+/==", &"A".repeat(MAX_VALUE + 1));
    let cases = [
        answer(&missing_token),
        answer(&duplicated),
        answer(&entity),
        answer(&bad_shape),
        answer(&bad_time),
        deep,
        answer(&long_value),
        format!("<!DOCTYPE x [<!ENTITY e \"x\">]>{}", answer(GOOD)),
        "not xml".to_string(),
        "<AssumeRoleResponse><unclosed></AssumeRoleResponse>".to_string(),
        String::new(),
    ];
    for (index, body) in cases.iter().enumerate() {
        assert_eq!(
            parse_assume_role(body.as_bytes()).map(|_| ()),
            Err(StsFailure::MalformedResponse),
            "case {index}"
        );
    }
    assert_eq!(
        parse_assume_role(&[0xff, 0xfe, 0x00]).map(|_| ()),
        Err(StsFailure::MalformedResponse)
    );
}

#[test]
fn error_codes_map_to_the_frozen_set() {
    let body = |code: &str| {
        format!(
            "<ErrorResponse><Error><Type>Sender</Type><Code>{code}</Code>\
             <Message>m</Message></Error><RequestId>r</RequestId></ErrorResponse>"
        )
    };
    let table = [
        (403, "AccessDenied", StsFailure::AccessDenied),
        (400, "MalformedPolicyDocument", StsFailure::AccessDenied),
        (403, "ExpiredToken", StsFailure::ExpiredSource),
        (403, "InvalidClientTokenId", StsFailure::ExpiredSource),
        (403, "SignatureDoesNotMatch", StsFailure::ExpiredSource),
        (403, "RegionDisabledException", StsFailure::RegionDisabled),
        (400, "Throttling", StsFailure::Throttled),
        (429, "Whatever", StsFailure::Throttled),
        (500, "InternalFailure", StsFailure::Unreachable),
        (503, "ServiceUnavailable", StsFailure::Unreachable),
    ];
    for (status, code, expected) in table {
        let found = error_code(body(code).as_bytes());
        assert_eq!(found.as_deref(), Some(code));
        assert_eq!(classify(status, found.as_deref()), expected, "{code}");
    }
    assert_eq!(
        classify(403, error_code(b"garbage").as_deref()),
        StsFailure::AccessDenied
    );
    assert_eq!(classify(502, None), StsFailure::Unreachable);
}

#[test]
fn an_expiration_outside_the_requested_window_is_refused() {
    let now: DateTime<Utc> = "2026-10-17T12:00:00Z".parse().unwrap();
    let at = |offset: i64| now + Duration::seconds(offset);
    assert!(check_expiration(at(900), now, 900).is_ok());
    assert!(check_expiration(at(900 + EXPIRATION_SKEW_SECONDS), now, 900).is_ok());
    assert!(check_expiration(at(900 + EXPIRATION_SKEW_SECONDS + 1), now, 900).is_err());
    assert!(check_expiration(at(0), now, 900).is_err());
    assert!(check_expiration(at(-60), now, 900).is_err());
    assert!(check_expiration(at(3600), now, 900).is_err());
}
