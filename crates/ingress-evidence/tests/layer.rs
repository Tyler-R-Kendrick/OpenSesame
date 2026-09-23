//! The originating-peer layer over real TLS: AT-INGRESS-SPOOF,
//! AT-INGRESS-WRONGPEER, AT-INGRESS-PARSER, AT-INGRESS-CHAINFIELDS,
//! AT-INGRESS-POOL, and the request-local attachment ING-REQUEST.

mod support;

use std::sync::atomic::Ordering;

use opensesame_domain::transport::TransportPolicy;
use opensesame_transport_security::plain_provenance_layer;
use support::{
    byte_sequence, client, client_cert, one_connection, seen_over, spawn_origin, url, Handled, Pki,
    Seen, TRUSTED_LISTENER,
};

async fn seen(response: reqwest::Response) -> Seen {
    assert_eq!(response.status(), 200, "handler answered");
    response.json().await.expect("seen json")
}

#[tokio::test(flavor = "multi_thread")]
async fn bound_ingress_attaches_originating_identity_to_the_request() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let response = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .header(
            "client-cert-chain",
            byte_sequence(&pki.originating_int.ca_der()),
        )
        .send()
        .await
        .expect("request");
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap_or("")),
        Some("no-store"),
        "a response selected by Client-Cert is uncacheable (RFC 9440 §2.4)"
    );
    let seen = seen(response).await;
    assert_eq!(seen.listener, TRUSTED_LISTENER);
    assert_eq!(
        seen.peer.as_deref(),
        Some(pki.ingress.thumbprint.as_str()),
        "the connection peer is the ingress"
    );
    assert_eq!(
        seen.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str())
    );
    assert_eq!(
        seen.originating_source.as_deref(),
        Some("TrustedIngressAssertion")
    );
    assert_eq!(
        seen.originating_ingress.as_deref(),
        Some(pki.ingress.thumbprint.as_str())
    );
    assert!(seen
        .originating_selectors
        .iter()
        .any(|s| s.contains("spiffe://example.test/alice")));
    assert!(
        !seen.client_cert_header_present,
        "the handler never sees the raw fields"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn chain_split_over_fields_matches_one_field_and_no_chain_is_refused() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let intermediate = byte_sequence(&pki.originating_int.ca_der());
    let root = byte_sequence(&pki.originating_root.ca_der());

    let joined = seen(
        http.get(url(origin.addr, "/whoami"))
            .header("client-cert", client_cert(&pki.alice))
            .header("client-cert-chain", format!("{intermediate}, {root}"))
            .send()
            .await
            .expect("joined"),
    )
    .await;
    let split = seen(
        http.get(url(origin.addr, "/whoami"))
            .header("client-cert", client_cert(&pki.alice))
            .header("client-cert-chain", intermediate.clone())
            .header("client-cert-chain", root)
            .send()
            .await
            .expect("split"),
    )
    .await;
    assert_eq!(joined, split, "AT-INGRESS-CHAINFIELDS");
    assert_eq!(
        joined.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str())
    );

    let bare = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .send()
        .await
        .expect("bare");
    assert_eq!(bare.status(), 403);
    assert_eq!(
        bare.headers()
            .get("x-opensesame-transport-error")
            .map(|v| v.to_str().unwrap_or("")),
        Some("trust_unknown"),
        "the trust file holds the root only, so the intermediate must be forwarded"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn forged_fields_on_a_plain_listener_yield_no_identity() {
    let pki = Pki::new();
    let handled = Handled(std::sync::Arc::default());
    let app = support::router(&pki, handled.clone()).layer(plain_provenance_layer("host-plain"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let task = tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client")
        .get(format!("http://{addr}/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .header(
            "client-cert-chain",
            byte_sequence(&pki.originating_int.ca_der()),
        )
        .send()
        .await
        .expect("request");
    let seen = seen(response).await;
    task.abort();
    assert_eq!(seen.listener, "host-plain");
    assert_eq!(seen.peer, None);
    assert_eq!(
        seen.originating, None,
        "AT-INGRESS-SPOOF: a forged field is not an identity"
    );
    assert!(
        !seen.client_cert_header_present,
        "and it is stripped before the handler"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn forged_fields_on_an_mtls_required_listener_yield_no_identity() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::MtlsRequired, "host-mtls").await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let seen = seen(
        http.get(url(origin.addr, "/whoami"))
            .header("client-cert", client_cert(&pki.alice))
            .header(
                "client-cert-chain",
                byte_sequence(&pki.originating_int.ca_der()),
            )
            .send()
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(seen.policy, "MtlsRequired");
    assert_eq!(
        seen.peer.as_deref(),
        Some(pki.ingress.thumbprint.as_str()),
        "direct TLS peer is kept"
    );
    assert_eq!(
        seen.originating, None,
        "AT-INGRESS-SPOOF: DirectTls listeners carry no originating identity"
    );
    assert!(!seen.client_cert_header_present);
}

#[tokio::test(flavor = "multi_thread")]
async fn unbound_peer_from_the_same_root_is_refused_at_the_trusted_listener() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.stranger), origin.addr);
    let response = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .header(
            "client-cert-chain",
            byte_sequence(&pki.originating_int.ca_der()),
        )
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), 403, "AT-INGRESS-WRONGPEER");
    assert_eq!(
        response
            .headers()
            .get("x-opensesame-transport-error")
            .map(|v| v.to_str().unwrap_or("")),
        Some("peer_not_bound")
    );
    assert_eq!(
        origin.handled.0.load(Ordering::SeqCst),
        0,
        "the handler never ran"
    );
    let no_fields = http
        .get(url(origin.addr, "/whoami"))
        .send()
        .await
        .expect("request");
    assert_eq!(
        no_fields.status(),
        403,
        "the listener exists for bound ingresses only"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_fields_from_a_bound_ingress_are_refused_before_the_handler() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let cases: [(&str, Vec<(&str, String)>); 4] = [
        (
            "leaf_repeated",
            vec![
                ("client-cert", client_cert(&pki.alice)),
                ("client-cert", client_cert(&pki.bob)),
            ],
        ),
        (
            "malformed_structured_field",
            vec![("client-cert", ":not base64!:".into())],
        ),
        (
            "not_der_certificate",
            vec![("client-cert", ":AAAA:".into())],
        ),
        (
            "conflicting_leaf",
            vec![
                ("client-cert", client_cert(&pki.alice)),
                ("client-cert-chain", client_cert(&pki.bob)),
            ],
        ),
    ];
    for (code, headers) in cases {
        let mut request = http.get(url(origin.addr, "/whoami"));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.expect("request");
        assert_eq!(response.status(), 403, "{code}");
        assert_eq!(
            response
                .headers()
                .get("x-opensesame-ingress-error")
                .map(|v| v.to_str().unwrap_or("")),
            Some(code),
            "AT-INGRESS-PARSER"
        );
        assert_eq!(
            response
                .headers()
                .get("x-opensesame-transport-error")
                .map(|v| v.to_str().unwrap_or("")),
            Some("forwarded_evidence_unverified")
        );
    }
    assert_eq!(
        origin.handled.0.load(Ordering::SeqCst),
        0,
        "no handler ran for any malformed case"
    );
}

/// AT-INGRESS-POOL over one TLS connection held explicitly (not a pool, whose
/// hand-back of a kept-alive connection races the next request): three
/// requests in sequence, and the listener counts exactly one handshake.
#[tokio::test(flavor = "multi_thread")]
async fn identities_stay_request_local_over_one_kept_alive_connection() {
    let pki = Pki::new();
    let origin = spawn_origin(&pki, TransportPolicy::TrustedIngress, TRUSTED_LISTENER).await;
    let mut connection = one_connection(&pki, Some(&pki.ingress), origin.addr).await;
    let chain = byte_sequence(&pki.originating_int.ca_der());
    let (alice_cert, bob_cert) = (client_cert(&pki.alice), client_cert(&pki.bob));
    let alice = seen_over(
        &mut connection,
        "/whoami",
        &[("client-cert", &alice_cert), ("client-cert-chain", &chain)],
    )
    .await;
    let bob = seen_over(
        &mut connection,
        "/whoami",
        &[("client-cert", &bob_cert), ("client-cert-chain", &chain)],
    )
    .await;
    let nobody = seen_over(&mut connection, "/whoami", &[]).await;
    assert_eq!(
        origin.counters.handshakes_ok(),
        1,
        "all three requests shared one TLS connection"
    );
    assert_eq!(origin.handled.0.load(Ordering::SeqCst), 3);
    assert_eq!(
        alice.originating.as_deref(),
        Some(pki.alice.thumbprint.as_str())
    );
    assert_eq!(
        bob.originating.as_deref(),
        Some(pki.bob.thumbprint.as_str())
    );
    assert_eq!(
        nobody.originating, None,
        "AT-INGRESS-POOL: nothing leaks from the connection"
    );
    assert_eq!(alice.peer, bob.peer, "same ingress peer throughout");
    assert_eq!(nobody.peer, alice.peer);
    assert!(
        !nobody.client_cert_header_present,
        "no raw field reaches the handler on a reused connection"
    );
}
