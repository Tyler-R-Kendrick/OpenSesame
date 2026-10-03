//! A refusal's detail is text the caller chose — a header name, a host, a
//! method — so a caller can make it spell the live surrogate. Every consumer
//! of [`Refusal`] logs or publishes it, so the ledger withholds such a detail
//! where the refusal is made (ADR 0150 §5), not in each consumer.

use super::fixtures::*;
use super::*;

fn leaks(refusal: &Refusal, surrogate: &str) -> bool {
    let hex = &surrogate[SURROGATE_MARKER.len()..];
    let shown = format!("{refusal:?}").to_ascii_lowercase();
    shown.contains(SURROGATE_MARKER) || shown.contains(hex)
}

#[test]
fn a_header_named_after_the_surrogate_does_not_put_it_in_the_refusal() {
    let (ledger, s) = ledger_with(0x51);
    let h = headers(&[
        ("Authorization", &format!("Bearer {s}")),
        (&format!("x-{s}"), "1"),
    ]);
    let r = refused(&ledger, &view("api.github.com", "/", &h, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Misplaced);
    assert_eq!(r.detail.as_deref(), Some(Refusal::WITHHELD));
    assert!(!leaks(&r, &s), "{r:?}");
}

#[test]
fn a_host_that_spells_the_surrogate_does_not_put_it_in_the_refusal() {
    let (ledger, s) = ledger_with(0x52);
    let h = headers(&[("Authorization", &format!("Bearer {s}"))]);
    let host = format!("{s}.evil.example");
    let r = refused(&ledger, &view(&host, "/", &h, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Misdirected);
    assert_eq!(r.detail.as_deref(), Some(Refusal::WITHHELD));
    assert!(!leaks(&r, &s), "{r:?}");
}

#[test]
fn a_host_that_spells_only_the_surrogate_body_is_withheld_too() {
    let (ledger, s) = ledger_with(0x53);
    let h = headers(&[("Authorization", &format!("Bearer {s}"))]);
    let host = format!("{}.evil.example", &s[SURROGATE_MARKER.len()..]);
    let r = refused(&ledger, &view(&host, "/", &h, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Misdirected);
    assert_eq!(r.detail.as_deref(), Some(Refusal::WITHHELD));
    assert!(!leaks(&r, &s), "{r:?}");
}

#[test]
fn a_method_that_is_the_surrogate_does_not_put_it_in_the_refusal() {
    let (ledger, s) = ledger_with(0x54);
    let h = headers(&[("Authorization", &format!("Bearer {s}"))]);
    let mut req = view("api.github.com", "/", &h, b"");
    req.method = &s;
    let r = refused(&ledger, &req, CALLER);
    assert_eq!(r.code, RefusalCode::OutOfScope);
    assert_eq!(r.detail.as_deref(), Some(Refusal::WITHHELD));
    assert!(!leaks(&r, &s), "{r:?}");
}

#[test]
fn a_plain_host_is_still_reported_so_the_owner_knows_where_it_went() {
    let (ledger, s) = ledger_with(0x55);
    let h = headers(&[("Authorization", &format!("Bearer {s}"))]);
    let r = refused(&ledger, &view("evil.example", "/", &h, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Misdirected);
    assert_eq!(r.detail.as_deref(), Some("evil.example"));
    let m = refused(
        &ledger,
        &view("api.github.com", "/", &h, b""),
        "run-b:pid-1",
    );
    assert_eq!(m.code, RefusalCode::ForeignCaller);
    assert_eq!(m.detail, None);
}

#[test]
fn a_misplaced_body_names_the_site_not_the_value() {
    let (ledger, s) = ledger_with(0x56);
    let h = headers(&[("Authorization", &format!("Bearer {s}"))]);
    let body = format!("token={s}");
    let r = refused(
        &ledger,
        &view("api.github.com", "/", &h, body.as_bytes()),
        CALLER,
    );
    assert_eq!(r.code, RefusalCode::Misplaced);
    assert_eq!(r.detail.as_deref(), Some("body"));
}

#[test]
fn a_surrogate_smuggled_in_the_method_alone_is_seen_and_refused() {
    // No header carries it: only the request line's method does. It must not
    // read as "no surrogate at all" and pass to a passthrough host.
    let (ledger, s) = ledger_with(0x57);
    let h = headers(&[("Accept", "*/*")]);
    for host in ["evil.example", "api.github.com"] {
        let mut req = view(host, "/", &h, b"");
        req.method = &s;
        let r = refused(&ledger, &req, CALLER);
        assert!(
            matches!(
                r.code,
                RefusalCode::Misdirected | RefusalCode::Misplaced | RefusalCode::OutOfScope
            ),
            "{host}: {r:?}"
        );
        assert!(!leaks(&r, &s), "{r:?}");
    }
}

#[test]
fn a_forged_surrogate_in_the_method_is_unknown_not_silence() {
    let (ledger, _) = ledger_with(0x58);
    let h = headers(&[]);
    let mut req = view("evil.example", "/", &h, b"");
    let forged = format!("{SURROGATE_MARKER}{}", "ab".repeat(16));
    req.method = &forged;
    assert_eq!(refused(&ledger, &req, CALLER).code, RefusalCode::Unknown);
}
