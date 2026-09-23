//! A revoked originating client behind a bound ingress, over real TLS.
//!
//! The per-request guard only ever sees the ingress's own leaf, so the
//! originating layer carries the listener's revoked-leaf hook: a forwarded
//! leaf that verifies but is revoked is refused before the handler runs,
//! and a client nobody revoked is unaffected.

mod support;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use opensesame_domain::transport::TransportPolicy;
use opensesame_transport_security::DenyThumbprint;
use support::{
    byte_sequence, client, client_cert, spawn_origin_denying, url, Pki, Seen, TRUSTED_LISTENER,
};

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_originating_leaf_is_refused_before_the_handler() {
    let pki = Pki::new();
    let revoked = pki.alice.thumbprint.clone();
    let deny: DenyThumbprint = Arc::new(move |thumbprint: &str| thumbprint == revoked);
    let origin = spawn_origin_denying(
        &pki,
        TransportPolicy::TrustedIngress,
        TRUSTED_LISTENER,
        pki.originating_trust(),
        Some(deny),
    )
    .await;
    let http = client(&pki, Some(&pki.ingress), origin.addr);
    let chain = byte_sequence(&pki.originating_int.ca_der());

    let alice = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.alice))
        .header("client-cert-chain", chain.clone())
        .send()
        .await
        .expect("alice");
    assert_eq!(alice.status(), 403);
    assert_eq!(
        alice
            .headers()
            .get("x-opensesame-transport-error")
            .map(|v| v.to_str().unwrap_or("")),
        Some("evidence_revoked"),
    );
    assert_eq!(
        origin.handled.0.load(Ordering::SeqCst),
        0,
        "the handler never saw the revoked client",
    );

    let bob: Seen = http
        .get(url(origin.addr, "/whoami"))
        .header("client-cert", client_cert(&pki.bob))
        .header("client-cert-chain", chain)
        .send()
        .await
        .expect("bob")
        .json()
        .await
        .expect("seen");
    assert_eq!(
        bob.originating.as_deref(),
        Some(pki.bob.thumbprint.as_str())
    );
}
