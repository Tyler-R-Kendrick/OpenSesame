//! LIFE-ACTIVATION: AT-ROTATE-ATOMIC and AT-TLS-TIME, driven against a real
//! [`opensesame_transport_security::SecureListener`] with traffic in flight.

use std::sync::Arc;

use chrono::{Duration, Utc};
use opensesame_domain::transport::{
    CredentialStatus, IdentitySourceKind, PeerIdentitySelector, TransportError,
};
use opensesame_transport_security::testkit::{DisposableCa, LeafSpec};
use opensesame_transport_security::{GenerationCandidate, SecretBytes, TlsIdentity};

use crate::transport_lifecycle::activation;
use crate::transport_lifecycle::facts;
use crate::transport_lifecycle::test_support as support;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_candidate_leaves_the_previous_generation_serving_unchanged() {
    // AT-ROTATE-ATOMIC. The connection is open and in use while the bad swap
    // is attempted; the listener keeps serving the identity it had, with the
    // expiry it had, and the failure is a recorded fact.
    let state = support::state().await;
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server = server_ca.issue_server("localhost");
    let generations = support::generations(server.identity(), &client_ca);
    let serving = generations.current();
    let serving_expiry = serving.identity.as_ref().expect("identity").not_after();

    let listener = support::serve(
        Arc::clone(&generations),
        support::profile_fn(&state),
        support::router(Arc::clone(&generations)),
    )
    .await;
    let client_leaf = support::client_leaf(&client_ca, "worker.test");
    let config = support::client(&server_ca, Some(Arc::new(client_leaf.identity())));
    let mut stream = support::connect(Arc::clone(&config), listener.addr)
        .await
        .expect("connect");
    assert_eq!(
        support::request_on(&mut stream, "/protected")
            .await
            .expect("first request")
            .0,
        200,
    );

    // A cert whose key belongs to another leaf: the classic half-written swap.
    let other = server_ca.issue_server("localhost");
    let mismatched = server.with_other_key(&other);
    let error = activation::activate_pem(
        &state,
        "host-tls",
        &generations,
        &mismatched.cert_pem,
        mismatched.key_secret(),
    )
    .await
    .expect_err("a mismatched pair must not activate");
    assert_eq!(error, TransportError::KeyPairMismatch);

    let after = generations.current();
    assert_eq!(after.number, serving.number, "no generation was swapped");
    assert_eq!(
        after.identity.as_ref().expect("identity").not_after(),
        serving_expiry,
        "a failed candidate must never extend the serving identity's expiry",
    );
    // …and the open connection is still good.
    assert_eq!(
        support::request_on(&mut stream, "/protected")
            .await
            .expect("second request")
            .0,
        200,
    );

    let recorded = facts::load(&state, "host-tls").await.expect("facts");
    let failure = recorded
        .latest("reload_failed")
        .expect("reload_failed fact");
    assert!(
        matches!(failure, facts::Fact::ReloadFailed { code, .. } if code == "key_pair_mismatch")
    );
    assert!(
        recorded.latest("active").is_none(),
        "a failed reload is never also an activation",
    );
}

#[tokio::test]
async fn an_expired_or_not_yet_valid_candidate_is_refused_at_its_exact_boundary() {
    // AT-TLS-TIME on the activation side: no clock tolerance is applied.
    let state = support::state().await;
    let ca = DisposableCa::new("servers");
    let now = Utc::now();

    let expired = ca.issue_with(
        &LeafSpec::server("localhost")
            .valid_between(now - Duration::days(2), now - Duration::seconds(1)),
    );
    assert!(
        expired.try_identity().is_err(),
        "a leaf whose not_after has passed must not load",
    );

    let future = ca.issue_with(
        &LeafSpec::server("localhost")
            .valid_between(now + Duration::seconds(30), now + Duration::days(2)),
    );
    assert!(
        future.try_identity().is_err(),
        "a leaf whose not_before has not arrived must not load",
    );

    let live = ca.issue_with(
        &LeafSpec::server("localhost")
            .valid_between(now - Duration::minutes(1), now + Duration::days(1)),
    );
    let identity = live.identity();
    assert!(identity.is_valid_at(now));
    assert!(!identity.is_valid_at(now + Duration::days(2)));

    // The whole candidate is validated at `now`, not merely parsed.
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(identity)),
        peer_trust: [(
            support::profile_ref(support::CLIENTS),
            support::private_root(support::CLIENTS, &ca),
        )]
        .into(),
        own_trust: None,
        identity_required: true,
    };
    assert!(candidate.validate(now).is_ok());
    assert!(
        candidate.validate(now + Duration::days(2)).is_err(),
        "an expired identity must not validate as a candidate",
    );
    drop(state);
}

#[tokio::test]
async fn a_valid_candidate_activates_and_records_loaded_active_and_superseded() {
    let state = support::state().await;
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations =
        support::generations(server_ca.issue_server("localhost").identity(), &client_ca);

    let next = server_ca.issue_server("localhost");
    let number = activation::activate_pem(
        &state,
        "host-tls",
        &generations,
        &next.cert_pem,
        next.key_secret(),
    )
    .await
    .expect("activate");
    assert_eq!(number, 2);
    assert_eq!(generations.current().number, 2);

    let recorded = facts::load(&state, "host-tls").await.expect("facts");
    for kind in ["loaded", "active", "superseded"] {
        assert!(recorded.latest(kind).is_some(), "missing {kind} fact");
    }
    assert!(
        recorded.latest("reload_failed").is_none(),
        "a success must not also record a failure",
    );
    // Issuance is a separate fact and this path never invents one: a renewal
    // that issued is not an installation that happened.
    assert!(recorded.latest("issued").is_none());
}

#[tokio::test]
async fn the_credential_status_says_revoked_and_expired_before_it_says_configured() {
    let state = support::state().await;
    let ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let leaf = ca.issue_server("localhost");
    let generations = support::generations(leaf.identity(), &client_ca);

    let status = activation::credential_status(
        &generations,
        IdentitySourceKind::ManagedCertificate,
        &state.transport_lifecycle,
    );
    assert!(matches!(
        status,
        CredentialStatus::Configured {
            custody: opensesame_domain::transport::Custody::HostSealedExportableToHost,
            ..
        }
    ));
    // Truthful custody: host-sealed *and exportable to the host*, never
    // relabelled as hardware-bound.
    state.transport_lifecycle.deny(&leaf.thumbprint);
    let status = activation::credential_status(
        &generations,
        IdentitySourceKind::ManagedCertificate,
        &state.transport_lifecycle,
    );
    assert!(matches!(status, CredentialStatus::Revoked { .. }));
    let rendered = format!("{status:?}");
    assert!(!rendered.contains("PRIVATE KEY"), "{rendered}");
}

#[tokio::test]
async fn a_pem_pair_that_will_not_parse_records_the_failure_and_returns_it() {
    let state = support::state().await;
    let ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations = support::generations(ca.issue_server("localhost").identity(), &client_ca);
    let error = activation::activate_pem(
        &state,
        "host-tls",
        &generations,
        b"not a certificate",
        SecretBytes::new(Box::new(b"not a key".to_vec())),
    )
    .await
    .expect_err("garbage must not activate");
    assert!(matches!(error, TransportError::MalformedConfiguration(_)));
    assert_eq!(generations.current().number, 1);
    let recorded = facts::load(&state, "host-tls").await.expect("facts");
    assert!(recorded.latest("reload_failed").is_some());
}

#[tokio::test]
async fn an_identity_the_host_holds_no_runtime_for_still_records_what_happened() {
    let state = support::state().await;
    assert!(state.transport_lifecycle.generations().is_none());
    let error = activation::activate_managed(
        &state,
        "host-tls",
        "certificate:none",
        crate::managed_certs_tls::TransportPurpose::Listener,
        None,
    )
    .await
    .expect_err("no runtime");
    assert_eq!(error, TransportError::SourceUnsupported);
    let recorded = facts::load(&state, "host-tls").await.expect("facts");
    assert!(recorded.latest("reload_failed").is_some());
}

#[tokio::test]
async fn a_client_leaf_is_never_accepted_as_the_listener_identity() {
    let ca = DisposableCa::new("mixed");
    let client = ca.issue_client(PeerIdentitySelector::DnsName("worker.test".into()));
    let identity: TlsIdentity = client.identity();
    assert!(!identity.usage().permits_server_auth());
}
