//! ING-REFERENCE: the pinned Caddy reference ingress driven end to end.
//! Runs only under `OPENSESAME_MTLS_FIXTURES=1 ... -- --ignored`, because it
//! needs the fetched binary. Every assertion reads what the origin handler
//! resolved, never the proxy's logs.

mod support;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use opensesame_domain::transport::{
    TlsVersion, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_ingress_evidence::IngressLimits;
use opensesame_transport_security::testkit::IssuedLeaf;
use opensesame_transport_security::{
    plain_provenance_layer, reqwest_builder, ClientProfile, ServerNamePolicy, TrustBundle,
};
use support::caddy::{self, Edge, INGRESS_NAME};
use support::{
    byte_sequence, client, client_cert, spawn_origin_with, url, Handled, Pki, Seen,
    TRUSTED_LISTENER,
};

/// Caddy forwards the leaf only, so the origin's trust file carries the
/// originating root *and* intermediate (see ops/ingress/README.md).
fn origin_trust(pki: &Pki) -> TrustBundle {
    let mut pem = pki.originating_root.ca_pem();
    pem.extend_from_slice(&pki.originating_int.ca_pem());
    TrustBundle::from_pem(
        Pki::originating_profile(),
        TrustProfileKind::PrivateRoot,
        &pem,
    )
    .expect("trust")
}

fn via_proxy(
    edge: &Edge,
    identity: Option<&IssuedLeaf>,
    proxy: std::net::SocketAddr,
) -> reqwest::Client {
    let profile = ClientProfile {
        server_trust: TrustBundle::from_pem(
            TrustProfileRef::new("edge").expect("profile"),
            TrustProfileKind::PrivateRoot,
            &edge.ca.ca_pem(),
        )
        .expect("edge trust"),
        server_name: ServerNamePolicy::Dns(INGRESS_NAME.into()),
        identity: identity.map(|leaf| Arc::new(leaf.identity())),
        min_version: TlsVersion::Tls13,
    };
    let base = reqwest::Client::builder()
        .no_proxy()
        .resolve(INGRESS_NAME, proxy);
    reqwest_builder(&profile, base)
        .expect("profile")
        .build()
        .expect("client")
}

fn proxy_url(proxy: std::net::SocketAddr, path: &str) -> String {
    format!("https://{INGRESS_NAME}:{}{path}", proxy.port())
}

async fn seen(response: reqwest::Response) -> Seen {
    assert_eq!(response.status(), 200);
    response.json().await.expect("seen json")
}

type Origin = support::Origin;
type Proxy = support::caddy::Caddy;

/// A valid originating client is resolved at the origin and labelled honestly;
/// forged fields from that client are replaced (leaf) and deleted (chain).
async fn assert_forwarded_and_sanitized(pki: &Pki, edge: &Edge, proxy: &Proxy) {
    let alice = via_proxy(edge, Some(&pki.alice), proxy.addr);
    let plain = seen(
        alice
            .get(proxy_url(proxy.addr, "/whoami"))
            .send()
            .await
            .expect("alice"),
    )
    .await;
    assert_eq!(plain.listener, TRUSTED_LISTENER);
    assert_eq!(
        plain.peer.as_deref(),
        Some(pki.ingress.thumbprint.as_str()),
        "hop 2 peer is the proxy"
    );
    assert_eq!(
        plain.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str())
    );
    assert_eq!(
        plain.originating_source.as_deref(),
        Some("TrustedIngressAssertion")
    );
    assert_eq!(
        plain.originating_ingress.as_deref(),
        Some(pki.ingress.thumbprint.as_str())
    );
    assert!(!plain.client_cert_header_present);
    let forged = seen(
        alice
            .get(proxy_url(proxy.addr, "/whoami"))
            .header("client-cert", client_cert(&pki.bob))
            .header("client-cert-chain", ":AAAA:")
            .send()
            .await
            .expect("forged"),
    )
    .await;
    assert_eq!(
        forged.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str()),
        "AT-INGRESS-SPOOF via the edge"
    );
}

/// Two originating clients over the proxy's pooled upstream connection stay request-local.
async fn assert_pooled_requests_stay_local(pki: &Pki, edge: &Edge, proxy: &Proxy, origin: &Origin) {
    let alice = via_proxy(edge, Some(&pki.alice), proxy.addr);
    let bob = via_proxy(edge, Some(&pki.bob), proxy.addr);
    let as_bob = seen(
        bob.get(proxy_url(proxy.addr, "/whoami"))
            .send()
            .await
            .expect("bob"),
    )
    .await;
    let as_alice = seen(
        alice
            .get(proxy_url(proxy.addr, "/whoami"))
            .send()
            .await
            .expect("alice again"),
    )
    .await;
    assert_eq!(
        as_bob.originating.as_deref(),
        Some(pki.bob.thumbprint.as_str())
    );
    assert_eq!(
        as_alice.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str())
    );
    assert_eq!(
        origin.counters.handshakes_ok(),
        1,
        "AT-INGRESS-POOL: every request so far rode one ingress→origin TLS connection; log:\n{}",
        proxy.log()
    );
}

/// No certificate at hop 1 is a handshake failure; the health listener answers
/// for the proxy only and never reaches the origin.
async fn assert_anonymous_refused_and_health_local(edge: &Edge, proxy: &Proxy, origin: &Origin) {
    let anonymous = via_proxy(edge, None, proxy.addr);
    assert!(
        anonymous
            .get(proxy_url(proxy.addr, "/whoami"))
            .send()
            .await
            .is_err(),
        "require_and_verify"
    );
    let handled_before = origin.handled.0.load(Ordering::SeqCst);
    let http = reqwest::Client::builder().no_proxy().build().expect("http");
    let health = http
        .get(format!("http://{}/healthz", proxy.health))
        .send()
        .await
        .expect("health");
    assert_eq!(health.status(), 200);
    assert_eq!(health.text().await.expect("body"), "ok");
    let other = http
        .get(format!("http://{}/whoami", proxy.health))
        .send()
        .await
        .expect("other");
    assert_eq!(other.status(), 404);
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), handled_before);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned Caddy binary; run with OPENSESAME_MTLS_FIXTURES=1 -- --ignored"]
async fn reference_ingress_forwards_verified_identity_strips_forgeries_and_pools() {
    if !caddy::fixtures_enabled() {
        eprintln!("OPENSESAME_MTLS_FIXTURES != 1; not executed");
        return;
    }
    let pki = Pki::new();
    let edge = Edge::new();
    let origin = spawn_origin_with(
        &pki,
        TransportPolicy::TrustedIngress,
        TRUSTED_LISTENER,
        origin_trust(&pki),
    )
    .await;
    let proxy = caddy::start(&pki, &edge, &pki.ingress, origin.addr);
    eprintln!(
        "caddy log head: {}",
        proxy.log().lines().take(2).collect::<Vec<_>>().join(" | ")
    );
    assert_forwarded_and_sanitized(&pki, &edge, &proxy).await;
    assert_pooled_requests_stay_local(&pki, &edge, &proxy, &origin).await;
    assert_anonymous_refused_and_health_local(&edge, &proxy, &origin).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned Caddy binary; run with OPENSESAME_MTLS_FIXTURES=1 -- --ignored"]
async fn unauthorized_proxy_identity_is_refused_at_origin_admission() {
    if !caddy::fixtures_enabled() {
        eprintln!("OPENSESAME_MTLS_FIXTURES != 1; not executed");
        return;
    }
    let pki = Pki::new();
    let edge = Edge::new();
    let origin = spawn_origin_with(
        &pki,
        TransportPolicy::TrustedIngress,
        TRUSTED_LISTENER,
        origin_trust(&pki),
    )
    .await;
    // Same private root as the bound ingress, but not bound.
    let rogue = caddy::start(&pki, &edge, &pki.stranger, origin.addr);
    let alice = via_proxy(&edge, Some(&pki.alice), rogue.addr);
    let response = alice
        .get(proxy_url(rogue.addr, "/whoami"))
        .send()
        .await
        .expect("via rogue");
    assert_eq!(response.status(), 403, "AT-INGRESS-WRONGPEER");
    assert_eq!(
        response
            .headers()
            .get("x-opensesame-transport-error")
            .map(|v| v.to_str().unwrap_or("")),
        Some("peer_not_bound")
    );
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), 0, "no handler ran");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned Caddy binary; run with OPENSESAME_MTLS_FIXTURES=1 -- --ignored"]
async fn bypassing_the_proxy_yields_no_protected_operation() {
    if !caddy::fixtures_enabled() {
        eprintln!("OPENSESAME_MTLS_FIXTURES != 1; not executed");
        return;
    }
    let pki = Pki::new();
    let origin = spawn_origin_with(
        &pki,
        TransportPolicy::TrustedIngress,
        TRUSTED_LISTENER,
        origin_trust(&pki),
    )
    .await;

    // Straight at the trusted listener with an originating-client certificate: not an ingress CA leaf.
    let alice_direct = client(&pki, Some(&pki.alice), origin.addr);
    assert!(
        alice_direct
            .get(url(origin.addr, "/whoami"))
            .send()
            .await
            .is_err(),
        "handshake refused"
    );
    // Straight at it with no certificate at all.
    let anonymous = client(&pki, None, origin.addr);
    assert!(anonymous
        .get(url(origin.addr, "/whoami"))
        .send()
        .await
        .is_err());
    // Straight at it with an unbound leaf from the ingress root, forging the fields.
    let stranger = client(&pki, Some(&pki.stranger), origin.addr);
    let response = stranger
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .header(
            "client-cert-chain",
            byte_sequence(&pki.originating_int.ca_der()),
        )
        .send()
        .await
        .expect("stranger");
    assert_eq!(response.status(), 403);
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), 0);

    // The plain listener, IPv4 and IPv6, with forged fields: reachable, but no identity.
    for bind in ["127.0.0.1:0", "[::1]:0"] {
        let Ok(listener) = tokio::net::TcpListener::bind(bind).await else {
            eprintln!("{bind}: not bindable here; skipped");
            continue;
        };
        let addr = listener.local_addr().expect("addr");
        let handled = Handled(Arc::default());
        let app = support::router_with_trust(&pki, handled.clone(), origin_trust(&pki))
            .layer(plain_provenance_layer("host-plain"));
        let task = tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
        let http = reqwest::Client::builder().no_proxy().build().expect("http");
        let response = http
            .get(format!("http://{addr}/whoami"))
            .header("client-cert", client_cert(&pki.alice))
            .header(
                "client-cert-chain",
                byte_sequence(&pki.originating_int.ca_der()),
            )
            .send()
            .await
            .expect("plain");
        let seen = seen(response).await;
        task.abort();
        assert_eq!(seen.listener, "host-plain", "{bind}");
        assert_eq!(seen.peer, None, "{bind}: AT-TLS-PLAINTEXT");
        assert_eq!(seen.originating, None, "{bind}: AT-INGRESS-ORIGIN");
        assert!(!seen.client_cert_header_present);
    }
    let _ = IngressLimits::DEFAULT;
}
