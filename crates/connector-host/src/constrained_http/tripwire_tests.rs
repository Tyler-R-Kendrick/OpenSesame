//! The tripwire report never repeats a placeholder, whatever the caller put
//! where the refusal's detail comes from. Each attack runs a real ledger, so
//! the detail under test is the one admission actually produced.

use super::*;
use opensesame_invoke_through::{
    RefusalCode, RequestView, SurrogateLedger, SurrogateSite, SurrogateSpec, EGRESS_RULES,
};

const CALLER: &str = "demo-conn";

fn ledger() -> (SurrogateLedger, String) {
    let mut ledger = SurrogateLedger::new(EGRESS_RULES.to_vec());
    let surrogate = ledger
        .issue(
            SurrogateSpec {
                provider_id: "github".into(),
                connection_ref: "conn://acme/github".into(),
                run_id: "run-a".into(),
                caller: CALLER.into(),
                site: SurrogateSite::Authorization,
                methods: vec!["GET".into()],
                path_prefixes: vec!["/".into()],
                expires_at_unix: u64::MAX,
            },
            [7; 16],
        )
        .expect("issued");
    (ledger, surrogate.as_str().to_string())
}

/// Refuse one request and return what the report would say.
fn reported(method: &str, host: &str, headers: &[(String, String)]) -> (RefusalCode, String) {
    let (ledger, _) = ledger();
    let view = RequestView {
        method,
        scheme: "https",
        host,
        port: None,
        path_and_query: "/repos/acme/x",
        headers,
        body: b"",
    };
    let refusal = ledger
        .admit(&view, CALLER, 0)
        .expect_err("refused at admission");
    (refusal.code, reported_detail(&refusal).to_string())
}

fn bearer(ph: &str) -> (String, String) {
    ("authorization".into(), format!("Bearer {ph}"))
}

#[test]
fn a_header_named_for_the_placeholder_is_not_repeated_in_the_report() {
    let (_, ph) = ledger();
    let headers = [bearer(&ph), (ph.clone(), "x".into())];
    let (code, detail) = reported("GET", "api.github.com", &headers);
    assert_eq!(code, RefusalCode::Misplaced);
    assert!(!detail.contains(&ph), "{detail}");
    assert_eq!(detail, WITHHELD);
}

#[test]
fn a_host_spelling_the_placeholder_is_not_repeated_in_the_report() {
    let (_, ph) = ledger();
    let host = format!("{ph}.evil.example");
    let (code, detail) = reported("GET", &host, &[bearer(&ph)]);
    assert_eq!(code, RefusalCode::Misdirected);
    assert!(!detail.contains(&ph), "{detail}");
    // The body alone, without its marker, is withheld too.
    let bare = format!("{}.evil.example", &ph["osr_".len()..]);
    let (_, detail) = reported("GET", &bare, &[bearer(&ph)]);
    assert_eq!(detail, WITHHELD);
}

#[test]
fn a_method_that_is_the_placeholder_is_not_repeated_in_the_report() {
    let (_, ph) = ledger();
    let (code, detail) = reported(&ph, "api.github.com", &[bearer(&ph)]);
    assert_eq!(code, RefusalCode::OutOfScope);
    assert!(!detail.contains(&ph), "{detail}");
}

#[test]
fn a_plain_site_host_or_method_is_still_reported() {
    let (_, ph) = ledger();
    let (_, host) = reported("GET", "gist.github.com", &[bearer(&ph)]);
    assert_eq!(host, "gist.github.com");
    let (_, method) = reported("DELETE", "api.github.com", &[bearer(&ph)]);
    assert_eq!(method, "DELETE");
    let headers = [bearer(&ph), ("x-note".into(), ph.clone())];
    let (_, site) = reported("GET", "api.github.com", &headers);
    assert_eq!(site, "x-note");
}
