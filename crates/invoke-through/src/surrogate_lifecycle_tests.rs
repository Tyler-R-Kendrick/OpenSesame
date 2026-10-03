//! Surrogate lifecycle and scope (ADR 0150 §3, §5): who may present one, for
//! how long, for what — and what issuing refuses.

use super::fixtures::*;
use super::*;

#[test]
fn a_surrogate_presented_by_another_caller_is_refused() {
    let (ledger, s) = ledger_with(12);
    let h = headers(&[("authorization", &format!("Bearer {s}"))]);
    let r = refused(
        &ledger,
        &view("api.github.com", "/", &h, b""),
        "run-b:pid-7",
    );
    assert_eq!(r.code, RefusalCode::ForeignCaller);
    assert_eq!(r.run_id.as_deref(), Some("run-a"));
}

#[test]
fn a_surrogate_dies_at_its_expiry_and_with_its_run() {
    let (mut ledger, s) = ledger_with(13);
    let other = ledger.issue(spec("run-z", "z"), [14; 16]).unwrap();
    let h = headers(&[("authorization", &format!("Bearer {s}"))]);
    let req = view("api.github.com", "/", &h, b"");
    assert_eq!(
        ledger.admit(&req, CALLER, NOW + 600).unwrap_err().code,
        RefusalCode::Expired
    );
    assert_eq!(ledger.revoke_run("run-a"), 1);
    assert_eq!(ledger.revoke_run("run-a"), 0, "revocation is idempotent");
    assert_eq!(refused(&ledger, &req, CALLER).code, RefusalCode::Revoked);
    // Another run's surrogate is untouched.
    let z = headers(&[("authorization", &format!("Bearer {}", other.as_str()))]);
    assert!(ledger
        .admit(&view("api.github.com", "/", &z, b""), "z", NOW)
        .unwrap()
        .is_some());
}

#[test]
fn issuing_refuses_what_nothing_could_redeem() {
    let mut ledger = SurrogateLedger::new(rules());
    let mut aws = spec("run-a", CALLER);
    aws.provider_id = "aws".into();
    assert_eq!(
        ledger.issue(aws, [1; 16]),
        Err(IssueError::UnsupportedProvider("aws".into()))
    );
    for (field, broken) in [
        (
            "run_id",
            SurrogateSpec {
                run_id: String::new(),
                ..spec("r", "c")
            },
        ),
        (
            "caller",
            SurrogateSpec {
                caller: String::new(),
                ..spec("r", "c")
            },
        ),
        (
            "connection_ref",
            SurrogateSpec {
                connection_ref: String::new(),
                ..spec("r", "c")
            },
        ),
        (
            "methods",
            SurrogateSpec {
                methods: vec![],
                ..spec("r", "c")
            },
        ),
        (
            "path_prefixes",
            SurrogateSpec {
                path_prefixes: vec![],
                ..spec("r", "c")
            },
        ),
        (
            "path_prefixes",
            SurrogateSpec {
                path_prefixes: vec!["repos".into()],
                ..spec("r", "c")
            },
        ),
        (
            "site",
            SurrogateSpec {
                site: SurrogateSite::Header(String::new()),
                ..spec("r", "c")
            },
        ),
    ] {
        assert_eq!(
            ledger.issue(broken, [2; 16]),
            Err(IssueError::Incomplete(field))
        );
    }
    ledger.issue(spec("r", "c"), [3; 16]).unwrap();
    assert_eq!(
        ledger.issue(spec("r", "c"), [3; 16]),
        Err(IssueError::Collision)
    );
}

#[test]
fn a_named_header_site_takes_its_whole_value() {
    let mut ledger = SurrogateLedger::new(rules());
    let s = ledger
        .issue(
            SurrogateSpec {
                site: SurrogateSite::Header("x-api-key".into()),
                ..spec("r", CALLER)
            },
            [16; 16],
        )
        .unwrap();
    let ok = headers(&[("X-Api-Key", s.as_str()), ("accept", "*/*")]);
    let admitted = ledger
        .admit(&view("api.github.com", "/", &ok, b""), CALLER, NOW)
        .unwrap()
        .unwrap();
    assert_eq!(admitted.forward_headers, headers(&[("accept", "*/*")]));
    let bearer = headers(&[("authorization", &format!("Bearer {}", s.as_str()))]);
    assert_eq!(
        refused(&ledger, &view("api.github.com", "/", &bearer, b""), CALLER).code,
        RefusalCode::Misplaced
    );
}

#[test]
fn the_shape_is_marker_plus_128_bits_and_debug_hides_it() {
    let mut ledger = SurrogateLedger::new(rules());
    let s = ledger.issue(spec("r", "c"), [0xa5; 16]).unwrap();
    assert_eq!(s.as_str(), format!("osr_{}", "a5".repeat(16)));
    assert_eq!(format!("{s:?}"), "Surrogate(osr_…)");
    let debug = format!("{ledger:?}");
    // The ledger's own Debug is for tests and panics; it must not print keys.
    assert!(!debug.contains(s.as_str()), "{debug}");
}

#[test]
fn every_refusal_tells_the_client_the_same_thing() {
    assert_eq!(
        Refusal::CLIENT_MESSAGE,
        "request refused by the credential broker"
    );
    let codes = [
        RefusalCode::Ambiguous,
        RefusalCode::Unknown,
        RefusalCode::Revoked,
        RefusalCode::Expired,
        RefusalCode::ForeignCaller,
        RefusalCode::Misdirected,
        RefusalCode::Cleartext,
        RefusalCode::Misplaced,
        RefusalCode::OutOfScope,
    ];
    let names: std::collections::HashSet<_> = codes.iter().map(|c| c.as_str()).collect();
    assert_eq!(names.len(), codes.len());
    assert!(names.iter().all(|n| n.starts_with("surrogate.")));
}

/// Theft is closed; misuse is not, by construction — a surrogate is the
/// connection's authority on its host. Scope is what bounds it: a surrogate
/// issued to read one repository cannot delete another.
#[test]
fn a_surrogate_is_bounded_by_its_method_and_path_scope() {
    let mut ledger = SurrogateLedger::new(rules());
    let s = ledger
        .issue(
            SurrogateSpec {
                methods: vec!["GET".into()],
                path_prefixes: vec!["/repos/acme/app".into()],
                ..spec("run-a", CALLER)
            },
            [17; 16],
        )
        .unwrap();
    let h = headers(&[("authorization", &format!("Bearer {}", s.as_str()))]);
    let at = |method: &'static str, path: &'static str| {
        let mut req = view("api.github.com", path, &h, b"");
        req.method = method;
        ledger.admit(&req, CALLER, NOW).map(|a| a.is_some())
    };
    assert_eq!(at("GET", "/repos/acme/app"), Ok(true));
    assert_eq!(at("get", "/repos/acme/app/issues?state=open"), Ok(true));
    assert_eq!(at("GET", "/repos/acme/app/x?next=a;b\\c%5c"), Ok(true));
    for (method, path) in [
        ("DELETE", "/repos/acme/app"),
        ("GET", "/repos/acme/app-private"),
        ("GET", "/repos/acme"),
        ("GET", "/user"),
        ("GET", "/repos/acme/app/../other"),
        ("GET", "/repos/acme/app/%2e%2e/other"),
        ("GET", "/repos/acme/app/./x"),
        ("GET", "repos/acme/app"),
        ("GET", "/repos/acme/app/..\\admin"),
        ("GET", "/repos/acme/app/..%5cadmin"),
        ("GET", "/repos/acme/app/..%5Cadmin"),
        ("GET", "/repos/acme/app/%2e%2e%5cadmin"),
        ("GET", "/repos/acme/app\\x"),
        ("GET", "/repos/acme/app/;/x"),
        ("GET", "/repos/acme/app/x;jsessionid=1"),
        ("GET", "/repos/acme/app/%3b/x"),
        ("GET", "/repos/acme/app/%3B/x"),
        ("GET", "/repos/acme/app/x%00"),
        ("GET", "/repos/acme/app/x%0a"),
        ("GET", "/repos/acme/app/x%09y"),
        ("GET", "/repos/acme/app/x\ty"),
        ("GET", "/repos/acme/app/x\u{7f}"),
    ] {
        let r = at(method, path).expect_err(path);
        assert_eq!(r.code, RefusalCode::OutOfScope, "{method} {path}");
    }
}
