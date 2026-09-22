//! Real-handshake refusals: AT-TLS-NOCLIENT, AT-TLS-WRONGKEY (rustls side),
//! AT-TLS-BADCHAIN and AT-TLS-TIME. Every denial also asserts the protected
//! handler did not run.

mod common;
#[path = "common/reject.rs"]
mod reject;

use std::sync::Arc;

use chrono::{Duration, Utc};
use common::*;
use opensesame_domain::transport::{PeerIdentitySelector, TransportError};
use opensesame_transport_security::client_config;
use opensesame_transport_security::testkit::{DisposableCa, LeafSpec};
use reject::*;

#[tokio::test]
async fn no_client_certificate_never_reaches_the_router() {
    let stack = stack().await;
    let config = Arc::new(client_config(&profile(&stack, None)).unwrap());
    expect_refused(&stack, config, "AT-TLS-NOCLIENT").await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(stack.served.counters.handshakes_ok(), 0);
    assert_eq!(stack.served.counters.handshakes_failed(), 1);
}

#[tokio::test]
async fn wrong_key_fails_at_configuration_in_rustls_too() {
    let stack = stack().await;
    let a = stack
        .client_ca
        .issue_client(PeerIdentitySelector::DnsName("a.internal".into()));
    let b = stack
        .client_ca
        .issue_client(PeerIdentitySelector::DnsName("b.internal".into()));
    let mismatched = a.with_other_key(&b);
    assert_eq!(
        mismatched.try_identity().unwrap_err(),
        TransportError::KeyPairMismatch
    );
    assert!(
        raw_client(&stack, &mismatched).is_err(),
        "rustls refuses the pair at config time"
    );
    assert_eq!(stack.hits.protected(), 0);
}

#[tokio::test]
async fn bad_chains_are_rejected_by_the_real_verifier() {
    let stack = stack().await;
    // Untrusted root.
    let rogue = DisposableCa::new("rogue");
    let leaf = rogue.issue_client(PeerIdentitySelector::DnsName("rogue.internal".into()));
    expect_refused(&stack, raw_client(&stack, &leaf).unwrap(), "untrusted root").await;
    // Missing intermediate.
    let intermediate = stack.client_ca.intermediate("clients-int");
    let leaf = intermediate.issue_client(PeerIdentitySelector::DnsName("int.internal".into()));
    let ok = raw_client(&stack, &leaf).unwrap();
    assert_eq!(
        raw_get(ok, stack.served.addr, localhost(), "/health")
            .await
            .unwrap()
            .0,
        200,
        "with the intermediate it is fine"
    );
    expect_refused(
        &stack,
        raw_client(&stack, &leaf.without_intermediates()).unwrap(),
        "missing intermediate",
    )
    .await;
    // Bad signature.
    let leaf = stack
        .client_ca
        .issue_client(PeerIdentitySelector::DnsName("sig.internal".into()));
    let corrupted = leaf.with_corrupted_signature();
    assert!(
        corrupted.try_identity().is_ok(),
        "the leaf still parses; only the CA signature is wrong"
    );
    expect_refused(
        &stack,
        raw_client(&stack, &corrupted).unwrap(),
        "bad signature",
    )
    .await;
    // Unsupported critical extension: rustls refuses to load the leaf into
    // a client config at all (webpki parses it first); had it got through,
    // the server's verifier would refuse it the same way.
    let mut spec = LeafSpec::client(vec![]);
    spec.unknown_critical_extension = true;
    match raw_client(&stack, &stack.client_ca.issue_with(&spec)) {
        Err(error) => assert!(
            format!("{error:?}").contains("UnsupportedCriticalExtension"),
            "{error:?}"
        ),
        Ok(config) => expect_refused(&stack, config, "critical ext").await,
    }
    // Intermediate that is not a CA (invalid intermediate constraints).
    let not_ca = stack.client_ca.intermediate_with(
        "not-ca",
        Utc::now() - Duration::hours(1),
        Utc::now() + Duration::hours(1),
        false,
    );
    let leaf = not_ca.issue_client(PeerIdentitySelector::DnsName(
        "under-not-ca.internal".into(),
    ));
    expect_refused(
        &stack,
        raw_client(&stack, &leaf).unwrap(),
        "non-CA intermediate",
    )
    .await;
    // Chain deeper than the bound.
    let mut deep = stack.client_ca.intermediate("d1");
    for n in ["d2", "d3", "d4", "d5"] {
        deep = deep.intermediate(n);
    }
    expect_refused(
        &stack,
        raw_client(
            &stack,
            &deep.issue_client(PeerIdentitySelector::DnsName("deep.internal".into())),
        )
        .unwrap(),
        "depth",
    )
    .await;
}

#[tokio::test]
async fn time_boundaries_are_enforced_by_the_server() {
    let stack = stack().await;
    let now = Utc::now();
    let expired = stack.client_ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now - Duration::hours(1), now - Duration::seconds(1)),
    );
    expect_refused(
        &stack,
        raw_client(&stack, &expired).unwrap(),
        "expired leaf",
    )
    .await;
    let future = stack.client_ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now + Duration::seconds(3), now + Duration::hours(1)),
    );
    expect_refused(
        &stack,
        raw_client(&stack, &future).unwrap(),
        "not yet valid leaf",
    )
    .await;
    // Expired intermediate with a valid leaf, and a not-yet-valid one.
    let expired_int = stack.client_ca.intermediate_with(
        "expired-int",
        now - Duration::hours(2),
        now - Duration::seconds(1),
        true,
    );
    let leaf = expired_int.issue_client(PeerIdentitySelector::DnsName(
        "under-expired.internal".into(),
    ));
    expect_refused(
        &stack,
        raw_client(&stack, &leaf).unwrap(),
        "expired intermediate",
    )
    .await;
    let future_int = stack.client_ca.intermediate_with(
        "future-int",
        now + Duration::seconds(3),
        now + Duration::hours(1),
        true,
    );
    let leaf = future_int.issue_client(PeerIdentitySelector::DnsName(
        "under-future.internal".into(),
    ));
    expect_refused(
        &stack,
        raw_client(&stack, &leaf).unwrap(),
        "not-yet-valid intermediate",
    )
    .await;
    // A leaf valid for a few more seconds is accepted right now.
    let edge = stack.client_ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now - Duration::hours(1), now + Duration::seconds(20)),
    );
    assert_eq!(
        raw_get(
            raw_client(&stack, &edge).unwrap(),
            stack.served.addr,
            localhost(),
            "/health"
        )
        .await
        .unwrap()
        .0,
        200
    );
}
