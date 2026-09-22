//! SEC-CONFUSION — the ingress and the client it vouches for are two
//! different identities, and neither may be played in the other's role.
//!
//! The RFC 9440 profile has exactly two identities on one request: the
//! proxy's own TLS identity, which is what the connection authenticated, and
//! the originating client's, which is an *assertion* about a handshake that
//! happened somewhere else. The failure this file attacks is the one where
//! those two are accidentally unioned — a proxy that forwards its own leaf
//! and is treated as the caller, a caller that reaches the ingress listener
//! directly and is treated as the proxy, or an identity that arrives twice
//! and is counted twice.
//!
//! Acceptance: AT-INGRESS-SPOOF, AT-INGRESS-WRONGPEER, AT-INGRESS-ORIGIN.

mod support;

use std::sync::atomic::Ordering;

use opensesame_domain::transport::TransportPolicy;
use support::{byte_sequence, client, client_cert, spawn_origin, url, Pki, Seen, TRUSTED_LISTENER};

/// The originating intermediate and root, as the ingress forwards them.
fn chain(pki: &Pki) -> String {
    format!(
        "{}, {}",
        byte_sequence(&pki.originating_int.ca_der()),
        byte_sequence(&pki.originating_root.ca_der())
    )
}

async fn seen(response: reqwest::Response) -> Seen {
    assert_eq!(response.status(), 200, "handler answered");
    response.json().await.expect("seen json")
}

/// The ingress forwards **its own** leaf as the originating client. Its
/// certificate is perfectly valid — it is the one that just authenticated
/// the connection — but it belongs to the ingress trust profile, not the
/// originating-client one, so the origin refuses it rather than admitting
/// the proxy as the caller it is vouching for.
#[tokio::test(flavor = "multi_thread")]
async fn the_ingress_cannot_forward_its_own_leaf_as_the_client() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let response = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.ingress))
        .send()
        .await
        .expect("response");
    assert_eq!(
        response.status(),
        403,
        "ingress leaf accepted as the client"
    );
    assert_eq!(
        response
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("trust_unknown"),
    );
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), 0, "handler ran");
}

/// The mirror image: an originating client's own leaf offered as the
/// *connection* identity on the trusted-ingress listener. That certificate
/// chains to the originating root, which is not the listener's client trust,
/// so the handshake itself never completes.
#[tokio::test(flavor = "multi_thread")]
async fn an_originating_client_cannot_connect_as_the_ingress() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.alice), origin.addr);
    let error = http
        .get(url(origin.addr, "/whoami"))
        .send()
        .await
        .expect_err("handshake must fail");
    assert!(
        !error.is_status(),
        "the refusal must be the handshake, not a status: {error}"
    );
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), 0, "handler ran");
}

/// A peer from the ingress's own root that nobody bound cannot forward
/// evidence *even when the forwarded chain is perfectly good*. Admission is
/// checked before the chain is looked at, so a valid assertion from an
/// unbound proxy is refused as `peer_not_bound`, never accepted because the
/// client it names happens to be legitimate.
#[tokio::test(flavor = "multi_thread")]
async fn an_unbound_proxy_cannot_launder_a_valid_assertion() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.stranger), origin.addr);
    let response = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .send()
        .await
        .expect("response");
    assert_eq!(response.status(), 403);
    assert_eq!(
        response
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("peer_not_bound"),
    );
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), 0, "handler ran");
}

/// When the assertion *is* accepted, the two identities stay distinguishable
/// on the request: the originating peer is labelled as an ingress assertion,
/// its `ingress()` is the proxy's own leaf, and the connection's peer is the
/// proxy — not the client. Nothing collapses one into the other.
#[tokio::test(flavor = "multi_thread")]
async fn an_accepted_assertion_keeps_both_identities_distinct() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let body = seen(
        http.get(url(origin.addr, "/whoami"))
            .header("client-cert", client_cert(&pki.alice))
            .header("client-cert-chain", chain(&pki))
            .send()
            .await
            .expect("response"),
    )
    .await;
    assert_eq!(body.peer.as_deref(), Some(pki.ingress.thumbprint.as_str()));
    assert_eq!(
        body.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str())
    );
    assert_eq!(
        body.originating_source.as_deref(),
        Some("TrustedIngressAssertion")
    );
    assert_eq!(
        body.originating_ingress.as_deref(),
        Some(pki.ingress.thumbprint.as_str())
    );
    assert_ne!(body.peer, body.originating, "one identity, two roles");
    assert!(
        !body.client_cert_header_present,
        "fields reached the handler"
    );
}

/// The same client forwarded twice in one request — once as the singleton
/// `Client-Cert` and once again inside `Client-Cert-Chain` — is one identity,
/// not two, and must not become an ambiguous or duplicated peer.
#[tokio::test(flavor = "multi_thread")]
async fn a_client_forwarded_twice_is_still_one_identity() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let chain = format!("{}, {}", client_cert(&pki.alice), chain(&pki));
    let response = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .header("client-cert-chain", chain)
        .send()
        .await
        .expect("response");
    if response.status() == 200 {
        let body = seen(response).await;
        assert_eq!(
            body.originating.as_deref(),
            Some(pki.alice.thumbprint.as_str())
        );
        let thumbprints = body
            .originating_selectors
            .iter()
            .filter(|s| s.contains("LeafThumbprint"))
            .count();
        assert_eq!(thumbprints, 1, "{:?}", body.originating_selectors);
    } else {
        assert_eq!(response.status(), 403, "bounded refusal or one identity");
        assert_eq!(origin.handled.0.load(Ordering::SeqCst), 0, "handler ran");
    }
}
