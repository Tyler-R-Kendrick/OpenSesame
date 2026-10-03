//! ADR 0150 section 8, on real sockets: a surrogate issued for a bounded
//! scope is refused outside it as `surrogate.out_of_scope`, the credential
//! tool is never run for the refused request, and the real bearer never
//! reaches the upstream for it.

mod support;

use opensesame_invoke_through::{Refusal, RefusalCode};
use opensesame_surrogate_proxy::RunSpec;
use support::client::{bearer, request, through_proxy};
use support::{grant, harness, CANARY, HOST};

fn bounded_run(h: &support::Harness, id: &str) -> opensesame_surrogate_proxy::RunHandle {
    let mut bounded = grant();
    bounded.methods = vec!["GET".into()];
    bounded.path_prefixes = vec!["/repos/acme".into(), "/user".into()];
    h.start_with(
        id,
        &RunSpec {
            grants: vec![bounded],
            ..RunSpec::default()
        },
    )
}

#[tokio::test]
async fn a_request_inside_the_prefix_is_brokered() {
    let h = harness().await;
    let run = bounded_run(&h, "run-scope-in");
    for path in ["/user", "/repos/acme", "/repos/acme/app/pulls?state=open"] {
        let seen = through_proxy(
            &run,
            HOST,
            request("GET", HOST, path, &[("authorization", &bearer(&run))]),
        )
        .await
        .expect("answered");
        assert_eq!(seen.status, 200, "{path}");
    }
    assert!(h.refusals.codes().is_empty());
    assert_eq!(h.upstream.hits().len(), 3);
}

#[tokio::test]
async fn a_request_outside_the_prefix_is_out_of_scope_and_the_credential_never_leaves() {
    let h = harness().await;
    let run = bounded_run(&h, "run-scope-out");
    let paths = [
        "/admin/users",
        "/orgs/acme/members",
        "/repos/acme-private/secrets",
        "/repos",
        "/",
        "/repos/acme/../other/x",
        "/repos/acme/%2e%2e/other/x",
        "/user/../admin",
        "/repos/acme/..\\admin",
        "/repos/acme/..%5c..%5cadmin",
        "/repos/acme/%2e%2e%5cadmin",
        "/repos/acme/;/x",
        "/repos/acme/%3b/x",
        "/repos/acme/x%00",
    ];
    for path in paths {
        let seen = through_proxy(
            &run,
            HOST,
            request("GET", HOST, path, &[("authorization", &bearer(&run))]),
        )
        .await
        .expect("answered");
        assert_eq!(seen.status, 403, "{path}");
        assert_eq!(seen.body, Refusal::CLIENT_MESSAGE, "{path}");
        assert!(!seen.body.contains(CANARY), "{path}");
    }
    let codes = h.refusals.codes();
    assert_eq!(codes.len(), paths.len(), "{codes:?}");
    assert!(
        codes.iter().all(|code| *code == RefusalCode::OutOfScope),
        "{codes:?}"
    );
    // Refused before the credential tool ran, and nothing went upstream.
    assert_eq!(h.source_calls(), 0, "the credential was acquired");
    assert!(
        h.upstream.hits().is_empty(),
        "a request reached the upstream"
    );
    assert!(h.receipts.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_method_outside_the_declared_methods_is_out_of_scope_inside_the_prefix() {
    let h = harness().await;
    let run = bounded_run(&h, "run-scope-method");
    let seen = through_proxy(
        &run,
        HOST,
        request(
            "DELETE",
            HOST,
            "/repos/acme/app",
            &[("authorization", &bearer(&run))],
        ),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(h.refusals.codes(), [RefusalCode::OutOfScope]);
    assert_eq!(h.source_calls(), 0);
    assert!(h.upstream.hits().is_empty());
}
