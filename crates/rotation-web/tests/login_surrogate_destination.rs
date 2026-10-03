//! Destination, method and encoding: the surrogate is substituted only into a
//! POST to the exact declared origin and path, with an identity body in form
//! or JSON (ADR 0150 §6.3). A wrong destination is `Misdirected` — the
//! signature of a page script sending what it read to somewhere it chose; a
//! request substitution does not handle is `Unsupported`.

#![cfg(feature = "login-surrogate")]

mod login_support;

use login_support::{assert_refused, declared, form, json, post, secret, SURROGATE, URL};
use opensesame_rotation_web::{
    AfterSubstitution, Egress, LoginRequest, ParkReason, RefusalCode, Substituted,
};

fn form_body() -> String {
    format!("password={SURROGATE}")
}

fn to(url: &str) -> Result<Substituted, opensesame_rotation_web::Refusal> {
    let headers = form();
    let body = form_body();
    declared().substitute(&post(url, &headers, body.as_bytes()), &secret())
}

#[test]
fn lookalike_hosts_are_misdirected() {
    for url in [
        "https://login.example.attacker.example/session",
        "https://attacker.example/session",
        "https://xlogin.example/session",
        "https://login.examp1e/session",
        "https://login.example./session",
        "https://sub.login.example/session",
    ] {
        assert_refused(to(url), RefusalCode::Misdirected);
    }
}

#[test]
fn another_port_is_misdirected() {
    for url in [
        "https://login.example:8443/session",
        "https://login.example:444/session",
    ] {
        assert_refused(to(url), RefusalCode::Misdirected);
    }
    // The default port written out is the same origin.
    assert!(to("https://login.example:443/session").is_ok());
}

#[test]
fn cleartext_http_is_misdirected() {
    for url in [
        "http://login.example/session",
        "http://login.example:443/session",
        "ws://login.example/session",
    ] {
        assert_refused(to(url), RefusalCode::Misdirected);
    }
}

#[test]
fn userinfo_lookalike_is_misdirected() {
    assert_refused(
        to("https://login.example@attacker.example/session"),
        RefusalCode::Misdirected,
    );
}

#[test]
fn a_host_carrying_the_surrogate_never_reaches_the_notice() {
    // `assert_refused` checks the refusal carries no surrogate, whichever part
    // of the URL the page put it in.
    for url in [
        format!("https://{SURROGATE}.attacker.example/session"),
        format!("https://attacker.example/{SURROGATE}"),
        format!("https://login.example:8443/{SURROGATE}"),
    ] {
        assert_refused(to(&url), RefusalCode::Misdirected);
    }
}

#[test]
fn a_misdirected_request_is_refused_by_the_egress_hook_too() {
    let headers = form();
    let body = form_body();
    let refusal = declared()
        .egress(
            &post(
                "https://attacker.example/collect",
                &headers,
                body.as_bytes(),
            ),
            &secret(),
        )
        .unwrap_err();
    assert_eq!(refusal.code, RefusalCode::Misdirected);
    assert!(refusal.code.is_tripwire());
}

#[test]
fn path_prefix_or_suffix_is_misdirected() {
    for url in [
        "https://login.example/sessions",
        "https://login.example/session2",
        "https://login.example/sess",
        "https://login.example/session/x",
        "https://login.example/api/session",
        "https://login.example/",
        "https://login.example",
    ] {
        assert_refused(to(url), RefusalCode::Misdirected);
    }
}

#[test]
fn trailing_slash_is_misdirected() {
    assert_refused(
        to("https://login.example/session/"),
        RefusalCode::Misdirected,
    );
}

#[test]
fn dot_segments_are_misdirected() {
    for url in [
        "https://login.example/x/../session",
        "https://login.example/./session",
        "https://login.example/x/%2e%2e/session",
        "https://login.example/%73ession",
        "https://login.example//session",
    ] {
        assert_refused(to(url), RefusalCode::Misdirected);
    }
}

#[test]
fn a_query_on_the_declared_action_is_allowed() {
    assert!(to("https://login.example/session?next=%2Fhome").is_ok());
}

#[test]
fn a_non_post_carrying_the_surrogate_is_misplaced_not_a_fallback() {
    // A page script that read the surrogate beacons it to the declared
    // endpoint with another verb. That is exfiltration, not an unsupported
    // shape: it parks the run and must never fall back to filling the real
    // credential into the page that just copied the surrogate.
    let headers = form();
    let body = form_body();
    for method in ["PUT", "PATCH", "GET", "DELETE", "post"] {
        let request = LoginRequest {
            method,
            url: URL,
            headers: &headers,
            body: body.as_bytes(),
        };
        let refusal = assert_refused(
            declared().substitute(&request, &secret()),
            RefusalCode::Misplaced,
        );
        assert_eq!(refusal.detail.as_deref(), Some("body"), "{method}");
        assert_eq!(
            refusal.next(),
            AfterSubstitution::Park(ParkReason::Tripwire(RefusalCode::Misplaced)),
            "{method}"
        );
    }
}

#[test]
fn a_get_that_beacons_the_surrogate_in_the_query_parks_the_run() {
    let url = format!("{URL}?leak={SURROGATE}");
    for method in ["GET", "PUT", "DELETE"] {
        let request = LoginRequest {
            method,
            url: &url,
            headers: &[],
            body: b"",
        };
        let refusal = assert_refused(
            declared().substitute(&request, &secret()),
            RefusalCode::Misplaced,
        );
        assert_eq!(refusal.detail.as_deref(), Some("query"), "{method}");
        assert_eq!(
            refusal.next(),
            AfterSubstitution::Park(ParkReason::Tripwire(RefusalCode::Misplaced))
        );
    }
}

#[test]
fn a_non_post_with_no_surrogate_is_merely_unsupported() {
    let headers = form();
    for method in ["PUT", "PATCH", "GET", "post"] {
        let request = LoginRequest {
            method,
            url: URL,
            headers: &headers,
            body: b"username=alice",
        };
        let refusal = assert_refused(
            declared().substitute(&request, &secret()),
            RefusalCode::Unsupported,
        );
        assert_eq!(refusal.detail.as_deref(), Some("method"), "{method}");
    }
}

#[test]
fn gzip_content_encoding_is_unsupported() {
    for coding in ["gzip", "br", "deflate", "identity, gzip", "x-custom"] {
        let mut headers = form();
        headers.push(("Content-Encoding".into(), coding.into()));
        let body = form_body();
        let refusal = assert_refused(
            declared().substitute(&post(URL, &headers, body.as_bytes()), &secret()),
            RefusalCode::Unsupported,
        );
        assert_eq!(refusal.detail.as_deref(), Some("content-encoding"));
    }
    let mut identity = form();
    identity.push(("content-encoding".into(), "Identity".into()));
    let body = form_body();
    assert!(declared()
        .substitute(&post(URL, &identity, body.as_bytes()), &secret())
        .is_ok());
}

#[test]
fn other_charsets_are_unsupported() {
    let headers = login_support::headers("application/x-www-form-urlencoded; charset=ISO-8859-1");
    let body = form_body();
    let refusal = assert_refused(
        declared().substitute(&post(URL, &headers, body.as_bytes()), &secret()),
        RefusalCode::Unsupported,
    );
    assert_eq!(refusal.detail.as_deref(), Some("charset"));
    let utf8 = login_support::headers("application/json; charset=\"UTF-8\"");
    let body = format!(r#"{{"password":"{SURROGATE}"}}"#);
    assert!(declared()
        .substitute(&post(URL, &utf8, body.as_bytes()), &secret())
        .is_ok());
}

#[test]
fn a_missing_or_repeated_content_type_is_not_parsed() {
    let body = form_body();
    let none: Vec<(String, String)> = Vec::new();
    assert_refused(
        declared().substitute(&post(URL, &none, body.as_bytes()), &secret()),
        RefusalCode::Misplaced,
    );
    let mut twice = form();
    twice.extend(json());
    assert_refused(
        declared().substitute(&post(URL, &twice, body.as_bytes()), &secret()),
        RefusalCode::Misplaced,
    );
}

#[test]
fn an_unknown_content_type_with_no_surrogate_is_unsupported() {
    let headers = login_support::headers("application/xml");
    let refusal = assert_refused(
        declared().substitute(&post(URL, &headers, b"<p/>"), &secret()),
        RefusalCode::Unsupported,
    );
    assert_eq!(refusal.detail.as_deref(), Some("content-type"));
}

#[test]
fn the_egress_hook_substitutes_the_declared_submission() {
    let headers = form();
    let body = form_body();
    let egress = declared()
        .egress(&post(URL, &headers, body.as_bytes()), &secret())
        .unwrap();
    let Egress::Substituted(substituted) = egress else {
        panic!("the declared submission must be substituted");
    };
    assert!(!substituted.is_empty());
    assert!(!String::from_utf8_lossy(substituted.body()).contains(SURROGATE));
}
