//! AT-ROTATE-ATOMIC, AT-ROTATE-VALID, AT-TLS-REVOKEDLIVE, AT-TLS-RESUME,
//! AT-SPIFFE-WITHDRAW (listener side) and graceful shutdown.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TransportError, TransportPolicy,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, GenerationCandidate, ServerNamePolicy,
};

struct World {
    server_ca: DisposableCa,
    client_ca: DisposableCa,
    gens: Arc<opensesame_transport_security::TransportGenerations>,
    served: Served,
    hits: Hits,
}

async fn world() -> World {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server = server_ca.issue_server("localhost").identity();
    let gens = generations(server, &client_ca);
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens.clone(), hits.clone()),
    )
    .await;
    World {
        server_ca,
        client_ca,
        gens,
        served,
        hits,
    }
}

impl World {
    fn client(&self, name: &str) -> (Arc<rustls::ClientConfig>, String) {
        let leaf = self
            .client_ca
            .issue_client(PeerIdentitySelector::DnsName(name.into()));
        let profile = ClientProfile {
            server_trust: private_root("servers", &self.server_ca),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(leaf.identity())),
            min_version: TlsVersion::Tls13,
        };
        (Arc::new(client_config(&profile).unwrap()), leaf.thumbprint)
    }

    fn candidate(&self, server: opensesame_transport_security::TlsIdentity) -> GenerationCandidate {
        GenerationCandidate {
            identity: Some(Arc::new(server)),
            peer_trust: self.gens.current().peer_trust.clone(),
            own_trust: None,
            identity_required: true,
        }
    }
}

#[tokio::test]
async fn failed_activation_leaves_the_old_generation_serving_and_in_flight_requests_complete() {
    let w = world().await;
    let (config, _) = w.client("a.internal");
    let slow = tokio::spawn(raw_get(config.clone(), w.served.addr, localhost(), "/slow"));
    tokio::time::sleep(Duration::from_millis(50)).await;

    // A candidate whose identity is expired: refused whole.
    let expired = w.server_ca.issue_with(
        &opensesame_transport_security::testkit::LeafSpec::server("localhost").valid_between(
            chrono::Utc::now() - chrono::Duration::hours(2),
            chrono::Utc::now() - chrono::Duration::seconds(1),
        ),
    );
    assert_eq!(
        expired.try_identity().unwrap_err(),
        TransportError::EvidenceExpired
    );
    // A candidate with a mismatched key cannot even be built.
    let other = w.server_ca.issue_server("localhost");
    assert!(w
        .server_ca
        .issue_server("localhost")
        .with_other_key(&other)
        .try_identity()
        .is_err());
    // A candidate missing the identity a required listener needs.
    let err = w
        .gens
        .activate(GenerationCandidate {
            identity_required: true,
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err, TransportError::IdentityMissing);
    // A candidate whose chain does not build to its own trust.
    let rogue = DisposableCa::new("rogue")
        .issue_server("localhost")
        .identity();
    let mut bad = w.candidate(rogue);
    bad.own_trust = Some(profile_ref(CLIENTS));
    assert_eq!(
        w.gens.activate(bad).unwrap_err(),
        TransportError::TrustUnknown
    );
    assert_eq!(w.gens.current().number, 1, "nothing was half-installed");

    assert_eq!(slow.await.unwrap().unwrap(), (200, "slow ok".into()));
    assert_eq!(
        raw_get(config, w.served.addr, localhost(), "/health")
            .await
            .unwrap()
            .0,
        200
    );
}

#[tokio::test]
async fn valid_activation_under_concurrent_requests_switches_new_connections_only() {
    let w = world().await;
    let (config, _) = w.client("b.internal");
    let mut inflight = Vec::new();
    for _ in 0..8 {
        inflight.push(tokio::spawn(raw_get(
            config.clone(),
            w.served.addr,
            localhost(),
            "/slow",
        )));
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
    // Concurrent activations from several tasks: every one is validated and
    // applied in order; numbers stay monotonic and unique.
    let mut activations = Vec::new();
    for _ in 0..4 {
        let gens = w.gens.clone();
        let candidate = w.candidate(w.server_ca.issue_server("localhost").identity());
        activations.push(tokio::task::spawn_blocking(move || {
            gens.activate(candidate)
        }));
    }
    let mut numbers: Vec<u64> = futures_join(activations).await;
    numbers.sort_unstable();
    assert_eq!(numbers, vec![2, 3, 4, 5]);
    assert_eq!(w.gens.current().number, 5);
    let mut rx = w.gens.subscribe();
    assert_eq!(*rx.borrow_and_update(), 5);
    for request in inflight {
        assert_eq!(
            request.await.unwrap().unwrap().0,
            200,
            "in-flight requests complete"
        );
    }
    let (_, body) = raw_get(config, w.served.addr, localhost(), "/whoami")
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["generation"], 5);
    assert_eq!(json["peer"]["credential_generation"], 5);
}

async fn futures_join(
    tasks: Vec<tokio::task::JoinHandle<Result<u64, TransportError>>>,
) -> Vec<u64> {
    let mut out = Vec::new();
    for task in tasks {
        out.push(task.await.unwrap().unwrap());
    }
    out
}

#[tokio::test]
async fn revoked_live_connection_is_denied_on_its_next_request() {
    let w = world().await;
    let (config, thumbprint) = w.client("live.internal");
    let mut stream = connect(config.clone(), w.served.addr, localhost())
        .await
        .unwrap();
    assert_eq!(
        request_on(&mut stream, "/protected").await.unwrap(),
        (200, "protected ok".into())
    );
    assert_eq!(w.hits.protected(), 1);

    // Process-wide denylist: same connection, no new handshake.
    w.gens.deny_thumbprint(&thumbprint);
    let (status, body) = request_on(&mut stream, "/protected").await.unwrap();
    assert_eq!(status, 403);
    assert!(body.contains("evidence_revoked"), "{body}");
    assert_eq!(w.hits.protected(), 1, "protected handler did not run");
    assert_eq!(
        w.served.counters.handshakes_ok(),
        1,
        "still the original connection"
    );
    // And a *new* connection with the denied leaf is refused at the handshake.
    assert!(
        raw_get(config.clone(), w.served.addr, localhost(), "/health")
            .await
            .is_err()
    );

    // Generation rotation: another live connection goes stale.
    let (config2, _) = w.client("live2.internal");
    let mut stream2 = connect(config2.clone(), w.served.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut stream2, "/protected").await.unwrap().0, 200);
    w.gens
        .activate(w.candidate(w.server_ca.issue_server("localhost").identity()))
        .unwrap();
    let (status, body) = request_on(&mut stream2, "/protected").await.unwrap();
    assert_eq!(
        (status, body.contains("generation_stale")),
        (403, true),
        "{body}"
    );
    assert_eq!(
        request_on(&mut stream2, "/health").await.unwrap().0,
        200,
        "unguarded routes are admission's job"
    );
    assert_eq!(
        raw_get(config2, w.served.addr, localhost(), "/protected")
            .await
            .unwrap()
            .0,
        200,
        "a fresh handshake is fine"
    );
    assert_eq!(w.hits.protected(), 3);
}

#[tokio::test]
async fn usable_until_bounds_an_open_connection() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let gens = generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let hits = Hits::default();
    let mut limits = opensesame_transport_security::ListenerLimits::default();
    limits.usable_for = Duration::from_secs(1);
    let served = serve(
        gens.clone(),
        profile_fn_with(TransportPolicy::MtlsRequired, limits),
        router(gens.clone(), hits.clone()),
    )
    .await;
    let w = World {
        server_ca,
        client_ca,
        gens,
        served,
        hits,
    };
    let (config, _) = w.client("short.internal");
    let mut stream = connect(config, w.served.addr, localhost()).await.unwrap();
    assert_eq!(request_on(&mut stream, "/protected").await.unwrap().0, 200);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let (status, body) = request_on(&mut stream, "/protected").await.unwrap();
    assert_eq!(
        (status, body.contains("evidence_expired")),
        (403, true),
        "{body}"
    );
    assert_eq!(w.hits.protected(), 1);
}

#[tokio::test]
async fn withdraw_refuses_new_connections_and_open_ones() {
    let w = world().await;
    let (config, _) = w.client("w.internal");
    let mut stream = connect(config.clone(), w.served.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut stream, "/protected").await.unwrap().0, 200);
    w.gens.withdraw(TransportError::EvidenceRevoked);
    assert_eq!(
        w.gens.current().withdrawn,
        Some(TransportError::EvidenceRevoked)
    );
    let (status, body) = request_on(&mut stream, "/protected").await.unwrap();
    assert_eq!(
        (status, body.contains("evidence_revoked")),
        (403, true),
        "{body}"
    );
    let err = raw_get(config.clone(), w.served.addr, localhost(), "/health")
        .await
        .unwrap_err();
    assert!(err.starts_with("tls:"), "refused before a handshake: {err}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(w.served.counters.refused_withdrawn(), 1);
    // A fresh valid generation brings the listener back.
    w.gens
        .activate(w.candidate(w.server_ca.issue_server("localhost").identity()))
        .unwrap();
    assert_eq!(
        raw_get(config, w.served.addr, localhost(), "/health")
            .await
            .unwrap()
            .0,
        200
    );
    assert_eq!(w.hits.protected(), 1);
}

#[tokio::test]
async fn resumption_is_disabled_on_mtls_required() {
    let w = world().await;
    let (config, thumbprint) = w.client("resume.internal");
    // The client keeps rustls's default resumption store; the server never
    // hands it a ticket, so every connection is a full handshake and every
    // one yields fresh evidence.
    for _ in 0..4 {
        let mut stream = connect(config.clone(), w.served.addr, localhost())
            .await
            .unwrap();
        let (_, body) = request_on(&mut stream, "/whoami").await.unwrap();
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["peer"]["leaf_thumbprint_sha256"], thumbprint);
        let (_, conn) = stream.get_ref();
        assert_eq!(
            conn.handshake_kind(),
            Some(rustls::HandshakeKind::Full),
            "no ticket was ever issued"
        );
        assert!(!conn.is_early_data_accepted());
    }
    assert_eq!(w.served.counters.resumed(), 0);
    assert_eq!(w.served.counters.handshakes_ok(), 4);
}

#[tokio::test]
async fn graceful_shutdown_finishes_in_flight_requests() {
    let w = world().await;
    let (config, _) = w.client("bye.internal");
    let slow = tokio::spawn(raw_get(config.clone(), w.served.addr, localhost(), "/slow"));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let addr = w.served.addr;
    let World { served, .. } = w;
    tokio::time::timeout(Duration::from_secs(5), served.shutdown())
        .await
        .expect("drains")
        .unwrap();
    assert_eq!(slow.await.unwrap().unwrap(), (200, "slow ok".into()));
    assert!(
        tokio::net::TcpStream::connect(addr).await.is_err()
            || raw_get(config, addr, localhost(), "/health").await.is_err()
    );
}
