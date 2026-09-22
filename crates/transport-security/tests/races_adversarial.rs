//! SEC-RACES — safety *and* bounded recovery when configuration changes
//! underneath live traffic.
//!
//! The properties asserted here are the two halves an availability-minded
//! implementation usually gets only one of:
//!
//! - **Safety.** No interleaving lets a request be served under material
//!   that is no longer current, and no concurrent activation produces a
//!   duplicate or out-of-order generation number.
//! - **Bounded recovery.** The deny is not permanent: once the peer
//!   re-handshakes under the new generation it is served again, so an
//!   operator rotation does not silently take the service down.
//!
//! Acceptance: AT-TLS-ROTATE, AT-TLS-REVOKEDLIVE, AT-ROTATE-WINDOW (the
//! "no unbounded task growth" half is SW-LIFECYCLE's).

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    TransportError, TransportPolicy,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    ClientProfile, GenerationCandidate, ServerNamePolicy, TransportGenerations,
};

fn candidate(server_ca: &DisposableCa, client_ca: &DisposableCa) -> GenerationCandidate {
    GenerationCandidate {
        identity: Some(Arc::new(server_ca.issue_server("localhost").identity())),
        peer_trust: [(profile_ref(CLIENTS), private_root(CLIENTS, client_ca))].into(),
        own_trust: None,
        identity_required: true,
    }
}

/// Sixteen activations racing each other produce sixteen distinct,
/// strictly increasing generation numbers with no gap and no repeat. A
/// duplicated number would let stale evidence pass the freshness guard.
#[test]
fn concurrent_activations_never_duplicate_or_reorder_a_generation() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations = TransportGenerations::new(
        candidate(&server_ca, &client_ca)
            .into_generation(1, chrono::Utc::now())
            .expect("initial"),
    );
    let numbers: Vec<u64> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let generations = Arc::clone(&generations);
                let server_ca = &server_ca;
                let client_ca = &client_ca;
                scope.spawn(move || {
                    generations
                        .activate(candidate(server_ca, client_ca))
                        .expect("activation")
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("join"))
            .collect()
    });
    let mut sorted = numbers.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        numbers.len(),
        "duplicate generation: {numbers:?}"
    );
    assert_eq!(sorted, (2..=17).collect::<Vec<_>>(), "gap or reorder");
    assert_eq!(generations.current().number, 17);
}

/// A candidate that does not validate is not a generation. Interleaving good
/// and bad activations must leave the counter advanced only by the good ones,
/// and must never leave half-installed material behind.
#[test]
fn failed_activations_do_not_advance_or_half_install() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations = TransportGenerations::new(
        candidate(&server_ca, &client_ca)
            .into_generation(1, chrono::Utc::now())
            .expect("initial"),
    );
    let bad = GenerationCandidate {
        identity: None,
        peer_trust: std::collections::BTreeMap::default(),
        own_trust: None,
        identity_required: true,
    };
    let before = generations.current();
    std::thread::scope(|scope| {
        for index in 0..8 {
            let generations = Arc::clone(&generations);
            let proposal = if index % 2 == 0 {
                bad.clone()
            } else {
                candidate(&server_ca, &client_ca)
            };
            let expected_good = index % 2 != 0;
            scope.spawn(move || propose(&generations, proposal, expected_good, index));
        }
    });
    let after = generations.current();
    assert_eq!(after.number, 5, "only the four good activations counted");
    assert!(after.identity.is_some(), "identity was dropped");
    assert!(
        after.peer_trust.contains_key(&profile_ref(CLIENTS)),
        "trust was half-installed"
    );
    assert!(before.identity.is_some(), "the old generation was mutated");
}

/// One activation attempt, with the outcome it must have. Extracted from the
/// thread body so the scope stays flat.
fn propose(
    generations: &TransportGenerations,
    proposal: GenerationCandidate,
    expected_good: bool,
    index: usize,
) {
    assert_eq!(
        generations.activate(proposal).is_ok(),
        expected_good,
        "activation {index} had the wrong outcome"
    );
}

/// Revocation on a connection that is already authenticated and kept alive:
/// the *next* request is denied without touching the generation, and a fresh
/// handshake by that leaf is refused too. This is the revocation lever that
/// does not require a rotation, so its bound matters — it is "the next
/// request", not "the next connection".
#[tokio::test(flavor = "multi_thread")]
async fn a_denied_leaf_is_refused_on_its_open_connection_and_on_a_new_one() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let client = client_ca.issue_client(PeerIdentitySelector::DnsName("svc.internal".into()));
    let generations = TransportGenerations::new(
        candidate(&server_ca, &client_ca)
            .into_generation(1, chrono::Utc::now())
            .expect("initial"),
    );
    let hits = Hits::default();
    let served = serve(
        Arc::clone(&generations),
        profile_fn(TransportPolicy::MtlsRequired),
        router(Arc::clone(&generations), hits.clone()),
    )
    .await;
    let config = Arc::new(
        opensesame_transport_security::client_config(&ClientProfile {
            server_trust: private_root("servers", &server_ca),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(client.identity())),
            min_version: opensesame_domain::transport::TlsVersion::Tls13,
        })
        .expect("client config"),
    );

    let mut stream = connect(Arc::clone(&config), served.addr, localhost())
        .await
        .expect("connect");
    let (status, _) = request_on(&mut stream, "/protected").await.expect("first");
    assert_eq!(status, 200, "a bound, unrevoked peer is served");

    generations.deny_thumbprint(&client.thumbprint);

    let (status, body) = request_on(&mut stream, "/protected")
        .await
        .expect("second request on the same connection");
    assert_eq!(status, 403, "revoked leaf still served: {body}");
    assert!(body.contains("evidence_revoked"), "{body}");
    let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream).await;

    // A brand new connection is refused at the handshake, not at the route.
    let refused = raw_get(config, served.addr, localhost(), "/protected").await;
    assert!(refused.is_err(), "revoked leaf completed a new handshake");
    served.shutdown().await.expect("shutdown");
}

/// A generation activated while a peer is mid-conversation denies that
/// peer's next request (its evidence is stale) — and the *recovery* is
/// bounded: reconnecting under the new generation is served again. Both
/// halves are asserted, because only asserting the deny would be satisfied
/// by an implementation that simply never recovers.
#[tokio::test(flavor = "multi_thread")]
async fn rotation_denies_stale_evidence_and_recovery_is_one_handshake() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let client = client_ca.issue_client(PeerIdentitySelector::DnsName("svc.internal".into()));
    let generations = TransportGenerations::new(
        candidate(&server_ca, &client_ca)
            .into_generation(1, chrono::Utc::now())
            .expect("initial"),
    );
    let hits = Hits::default();
    let served = serve(
        Arc::clone(&generations),
        profile_fn(TransportPolicy::MtlsRequired),
        router(Arc::clone(&generations), hits.clone()),
    )
    .await;
    let config = Arc::new(
        opensesame_transport_security::client_config(&ClientProfile {
            server_trust: private_root("servers", &server_ca),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(client.identity())),
            min_version: opensesame_domain::transport::TlsVersion::Tls13,
        })
        .expect("client config"),
    );

    let mut stream = connect(Arc::clone(&config), served.addr, localhost())
        .await
        .expect("connect");
    assert_eq!(
        request_on(&mut stream, "/protected")
            .await
            .expect("first")
            .0,
        200
    );

    generations
        .activate(candidate(&server_ca, &client_ca))
        .expect("rotate");

    let (status, body) = request_on(&mut stream, "/protected").await.expect("second");
    assert_eq!(status, 403, "stale evidence was served: {body}");
    assert!(body.contains("generation_stale"), "{body}");
    let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream).await;

    let (status, _) = tokio::time::timeout(
        Duration::from_secs(10),
        raw_get(config, served.addr, localhost(), "/protected"),
    )
    .await
    .expect("recovery did not complete")
    .expect("recovery handshake");
    assert_eq!(status, 200, "no bounded recovery after a rotation");
    served.shutdown().await.expect("shutdown");
}

/// Replace the live set with an empty one and announce it.
fn replace_set(live: &std::sync::RwLock<ServiceBindingSet>, replaced: &AtomicBool) {
    std::thread::sleep(Duration::from_millis(2));
    *live.write().expect("write") = ServiceBindingSet {
        revision: 2,
        bindings: Vec::new(),
    };
    replaced.store(true, Ordering::SeqCst);
}

/// Read the live set until the replacement has landed, then a little longer,
/// so both sides of the swap are observed.
fn read_across(
    live: &std::sync::RwLock<ServiceBindingSet>,
    presented: &[PeerIdentitySelector],
    now: chrono::DateTime<chrono::Utc>,
    replaced: &AtomicBool,
) -> Vec<bool> {
    let mut series = Vec::new();
    let mut after = 0;
    while after < 50 {
        if replaced.load(Ordering::SeqCst) {
            after += 1;
        }
        series.push(resolves(live, presented, now));
    }
    series
}

/// One coherent read of the live set: `true` when the peer is bound, `false`
/// when it is not. Any other outcome is a torn or unexpected state and fails
/// the assertion here rather than being folded into the series.
fn resolves(
    live: &std::sync::RwLock<ServiceBindingSet>,
    presented: &[PeerIdentitySelector],
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let set = live.read().expect("read");
    match set.resolve(
        &profile_ref(CLIENTS),
        presented,
        BindingPurpose::WorkerClient,
        now,
    ) {
        Ok(binding) => {
            assert_eq!(binding.service_principal, "svc");
            true
        }
        Err(error) => {
            assert_eq!(error, TransportError::PeerNotBound);
            false
        }
    }
}

fn bound(peer: PeerIdentitySelector) -> ServiceBinding {
    ServiceBinding {
        id: "svc".into(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: profile_ref(CLIENTS),
        peer,
        service_principal: "svc".into(),
        purpose: BindingPurpose::WorkerClient,
        allowed_operations: vec!["worker.providers.list".into()],
        allowed_audiences: Vec::new(),
        not_after: None,
        denied_thumbprints: Vec::new(),
    }
}

/// Admission reading the live binding set while an operator replaces it sees
/// one coherent set or the other, never a mixture: every read either binds
/// the peer or refuses it with `peer_not_bound`, and once the replacement has
/// landed every subsequent read refuses. A torn read would show up as a
/// resolution that succeeded *after* a refusal.
#[test]
fn a_binding_replacement_is_never_observed_half_applied() {
    let peer = PeerIdentitySelector::DnsName("svc.internal".into());
    let live = Arc::new(std::sync::RwLock::new(ServiceBindingSet {
        revision: 1,
        bindings: vec![bound(peer.clone())],
    }));
    let presented = [peer];
    let now = chrono::Utc::now();
    let outcomes: Vec<Vec<bool>> = std::thread::scope(|scope| {
        let replaced = Arc::new(AtomicBool::new(false));
        let writer = {
            let live = Arc::clone(&live);
            let replaced = Arc::clone(&replaced);
            scope.spawn(move || replace_set(&live, &replaced))
        };
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let live = Arc::clone(&live);
                let presented = presented.clone();
                let replaced = Arc::clone(&replaced);
                scope.spawn(move || read_across(&live, &presented, now, &replaced))
            })
            .collect();
        writer.join().expect("writer");
        readers
            .into_iter()
            .map(|h| h.join().expect("reader"))
            .collect()
    });
    for series in &outcomes {
        // Once a reader has seen the replacement it must never see the old
        // set again: the sequence is monotonically "bound then unbound".
        let first_unbound = series.iter().position(|bound| !bound);
        if let Some(index) = first_unbound {
            assert!(
                series[index..].iter().all(|bound| !bound),
                "a reader went back to the replaced set"
            );
        }
    }
    assert!(
        outcomes.iter().flatten().any(|bound| !bound),
        "the replacement never landed; the test proved nothing"
    );
}
