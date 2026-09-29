//! The adversarial matrix for surrogate admission (ADR 0150 §3–§5): where a
//! surrogate may be sent, and where in a request it may sit. One test per
//! attack; each names the attack, not the code path.

use super::fixtures::*;
use super::*;

#[test]
fn a_well_formed_request_is_admitted_with_its_surrogate_stripped() {
    let (ledger, s) = ledger_with(0xab);
    let h = headers(&[
        ("Authorization", &format!("Bearer {s}")),
        ("Accept", "application/vnd.github+json"),
    ]);
    let admitted = ledger
        .admit(&view("api.github.com", "/user", &h, b""), CALLER, NOW)
        .expect("admitted")
        .expect("carried a surrogate");
    assert_eq!(admitted.provider_id, "github");
    assert_eq!(admitted.connection_ref, "conn://acme/gh");
    assert_eq!(admitted.run_id, "run-a");
    // The surrogate's header is gone; invoke-through writes its own.
    assert_eq!(
        admitted.forward_headers,
        headers(&[("Accept", "application/vnd.github+json")])
    );
}

#[test]
fn the_token_scheme_is_the_same_site_and_basic_is_not() {
    let (ledger, s) = ledger_with(1);
    let token = headers(&[("authorization", &format!("token {s}"))]);
    assert!(ledger
        .admit(&view("api.github.com", "/", &token, b""), CALLER, NOW)
        .unwrap()
        .is_some());
    let basic = headers(&[("authorization", &format!("Basic {s}"))]);
    let r = refused(&ledger, &view("api.github.com", "/", &basic, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Misplaced);
}

#[test]
fn a_request_without_a_surrogate_is_not_this_modules_business() {
    let (ledger, _) = ledger_with(2);
    let h = headers(&[("authorization", "Bearer ghp_theirownrealtoken")]);
    assert_eq!(
        ledger.admit(&view("example.com", "/", &h, b"osr_short"), CALLER, NOW),
        Ok(None)
    );
}

/// The exfiltration signature: a prompt-injected agent sends its surrogate to
/// a host it controls. Nothing is substituted, and the owner hears about it.
#[test]
fn a_surrogate_sent_to_another_host_is_a_tripwire() {
    let (ledger, s) = ledger_with(3);
    let h = headers(&[("authorization", &format!("Bearer {s}"))]);
    for host in ["evil.test", "api.github.com.evil.test", "github.com"] {
        let r = refused(&ledger, &view(host, "/", &h, b""), CALLER);
        assert_eq!(r.code, RefusalCode::Misdirected, "{host}");
        assert_eq!(r.run_id.as_deref(), Some("run-a"));
        assert_eq!(r.detail.as_deref(), Some(host));
    }
    let mut odd_port = view("api.github.com", "/", &h, b"");
    odd_port.port = Some(8443);
    assert_eq!(
        refused(&ledger, &odd_port, CALLER).code,
        RefusalCode::Misdirected
    );
}

#[test]
fn a_surrogate_over_plain_http_is_refused_even_to_the_right_host() {
    let (ledger, s) = ledger_with(4);
    let h = headers(&[("authorization", &format!("Bearer {s}"))]);
    let mut req = view("api.github.com", "/", &h, b"");
    req.scheme = "http";
    assert_eq!(refused(&ledger, &req, CALLER).code, RefusalCode::Cleartext);
}

/// The reflection oracle: put the surrogate where the allowed host will store
/// and show it back (a gist, an issue body), with a valid Authorization beside
/// it. A find-and-replace proxy would write the credential into the gist.
#[test]
fn a_surrogate_in_the_body_is_refused_even_beside_a_valid_header() {
    let (ledger, s) = ledger_with(5);
    let h = headers(&[("authorization", &format!("Bearer {s}"))]);
    let body = format!("{{\"files\":{{\"t.txt\":{{\"content\":\"{s}\"}}}}}}");
    let r = refused(
        &ledger,
        &view("api.github.com", "/gists", &h, body.as_bytes()),
        CALLER,
    );
    assert_eq!(r.code, RefusalCode::Misplaced);
    assert_eq!(r.detail.as_deref(), Some("body"));
}

#[test]
fn a_surrogate_in_the_query_or_path_is_refused_encoded_or_not() {
    let (ledger, s) = ledger_with(6);
    let h = headers(&[("authorization", &format!("Bearer {s}"))]);
    let escaped = s.replace('_', "%5F");
    for path in [
        format!("/user?access_token={s}"),
        format!("/repos/{s}/x"),
        format!("/user?t={escaped}"),
    ] {
        let r = refused(&ledger, &view("api.github.com", &path, &h, b""), CALLER);
        assert_eq!(r.code, RefusalCode::Misplaced, "{path}");
        assert_eq!(r.detail.as_deref(), Some("path"));
    }
}

#[test]
fn a_surrogate_in_any_other_header_is_refused() {
    let (ledger, s) = ledger_with(7);
    for extra in [
        headers(&[
            ("authorization", &format!("Bearer {s}")),
            ("x-debug-echo", &s),
        ]),
        headers(&[
            ("authorization", &format!("Bearer {s}")),
            (&s, "name-smuggled"),
        ]),
    ] {
        let r = refused(&ledger, &view("api.github.com", "/", &extra, b""), CALLER);
        assert_eq!(r.code, RefusalCode::Misplaced);
    }
}

#[test]
fn a_repeated_or_decorated_site_is_refused() {
    let (ledger, s) = ledger_with(8);
    for h in [
        headers(&[
            ("authorization", &format!("Bearer {s}")),
            ("Authorization", &format!("Bearer {s}")),
        ]),
        headers(&[("authorization", &format!("Bearer {s} {s}"))]),
        headers(&[("authorization", &format!("Bearer {s}a"))]),
        headers(&[("authorization", &format!("Bearer {s}, Basic eDp5"))]),
        headers(&[("authorization", &format!("Bearer  {s}"))]),
    ] {
        let r = refused(&ledger, &view("api.github.com", "/", &h, b""), CALLER);
        assert_eq!(r.code, RefusalCode::Misplaced, "{h:?}");
    }
}

/// Two connections' surrogates in one request would let one request carry
/// the authority of both. Refused before either is looked up.
#[test]
fn two_distinct_surrogates_in_one_request_are_ambiguous() {
    let (mut ledger, a) = ledger_with(9);
    let b = ledger.issue(spec("run-a", CALLER), [10; 16]).unwrap();
    let h = headers(&[
        ("authorization", &format!("Bearer {a}")),
        ("x-api-key", b.as_str()),
    ]);
    let r = refused(&ledger, &view("api.github.com", "/", &h, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Ambiguous);
    assert_eq!(r.run_id, None);
}

#[test]
fn a_forged_surrogate_is_unknown_and_names_no_run() {
    let (ledger, _) = ledger_with(11);
    let forged = format!("osr_{}", "0".repeat(32));
    let h = headers(&[("authorization", &format!("Bearer {forged}"))]);
    let r = refused(&ledger, &view("api.github.com", "/", &h, b""), CALLER);
    assert_eq!(r.code, RefusalCode::Unknown);
    assert_eq!((r.run_id, r.provider_id), (None, None));
}

/// A surrogate copied out of one run (a log, a transcript, a model provider's
/// retention) is dead in the hands of any other process.
/// A client that transforms its surrogate (case, encoding) can smuggle it
/// anywhere undetected — and redeem nothing, because only the exact issued
/// text in its exact site is ever admitted. Detection is best effort;
/// confidentiality does not depend on it.
#[test]
fn a_transformed_surrogate_is_inert() {
    let (ledger, s) = ledger_with(15);
    let upper = s.to_ascii_uppercase();
    let h = headers(&[("authorization", &format!("Bearer {upper}"))]);
    assert_eq!(
        ledger.admit(&view("api.github.com", "/", &h, b""), CALLER, NOW),
        Ok(None),
        "not a surrogate, so not admitted: the upstream gets a dead string"
    );
}
