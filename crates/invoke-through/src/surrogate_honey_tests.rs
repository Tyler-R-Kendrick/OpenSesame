//! Self-managed honey tokens: a planted `osr_hny_` value is never admitted.

use super::fixtures::*;
use super::*;

fn honey() -> (String, String) {
    let id = "0123456789abcdef0123456789abcdef".to_string();
    let secret = "a".repeat(HONEY_TOKEN_SECRET_LEN);
    (format!("{HONEY_TOKEN_MARKER}{id}_{secret}"), id)
}

#[test]
fn a_honey_token_is_a_critical_tripwire_even_on_an_issued_host() {
    let (ledger, _) = ledger_with(5);
    let (token, id) = honey();
    let h = headers(&[("authorization", &format!("Bearer {token}"))]);
    let refusal = refused(&ledger, &view("api.github.com", "/user", &h, b""), CALLER);
    assert_eq!(refusal.code, RefusalCode::HoneyToken);
    assert_eq!(refusal.run_id.as_deref(), Some(id.as_str()));
    assert_eq!(refusal.provider_id.as_deref(), Some("honey-token"));
    assert_eq!(refusal.detail, None);
    assert_eq!(refusal.code.as_str(), "surrogate.honey_token");
}

#[test]
fn malformed_near_misses_are_not_honey_tokens() {
    for value in [
        "osr_hny_short_deadbeef",
        "osr_hny_0123456789abcdef0123456789abcdef_short",
        "osr_hny_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz_fedcba9876543210fedcba9876543210",
    ] {
        assert_eq!(honey_token_id(value), None, "{value}");
        assert_eq!(
            SurrogateLedger::new(rules()).admit(
                &view(
                    "api.github.com",
                    "/",
                    &headers(&[("authorization", &format!("Bearer {value}"))]),
                    b""
                ),
                CALLER,
                NOW
            ),
            Ok(None),
            "{value}"
        );
    }
    // A normal surrogate-shaped unknown remains an ordinary unknown refusal.
    assert_eq!(
        refused(
            &SurrogateLedger::new(rules()),
            &view(
                "api.github.com",
                "/",
                &headers(&[(
                    "authorization",
                    "Bearer osr_0123456789abcdef0123456789abcdef"
                )]),
                b""
            ),
            CALLER
        )
        .code,
        RefusalCode::Unknown
    );
}

#[test]
fn a_honey_token_is_refused_without_a_run_lease_or_provider() {
    let (token, _) = honey();
    let ledger = SurrogateLedger::new(vec![]);
    let h = headers(&[("x-api-key", &token)]);
    let refusal = refused(&ledger, &view("evil.test", "/", &h, b""), CALLER);
    assert_eq!(refusal.code, RefusalCode::HoneyToken);
}

#[test]
fn every_distinct_honey_id_is_reported_even_before_a_second_one() {
    let (first, first_id) = honey();
    let second_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let second = format!("{HONEY_TOKEN_MARKER}{second_id}_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let body = format!("first={first} second={second}");
    let refusal = SurrogateLedger::new(vec![])
        .honey_refusals(&view("api.github.com", "/", &headers(&[]), body.as_bytes()))
        .into_iter()
        .map(|refusal| refusal.run_id.unwrap())
        .collect::<Vec<_>>();
    assert_eq!(refusal, [first_id, second_id.to_string()]);
}

#[test]
fn an_uppercase_id_is_reported_in_lowercase_for_the_pwa_match() {
    let value = "osr_hny_ABCDEF0123456789ABCDEF0123456789_fedcba9876543210fedcba9876543210";
    assert_eq!(
        honey_token_id(value).as_deref(),
        Some("abcdef0123456789abcdef0123456789")
    );
}

#[test]
fn a_normal_looking_surrogate_id_in_the_honey_namespace_is_detected() {
    let value = "osr_c0de0123456789abcdef0123456789ab";
    assert_eq!(
        honey_token_id(value).as_deref(),
        Some("c0de0123456789abcdef0123456789ab")
    );
    assert_eq!(honey_token_id("osr_c0de0123456789abcdef0123456"), None);
    assert_eq!(honey_token_id("osr_0123456789abcdef0123456789abcdef"), None);
}
