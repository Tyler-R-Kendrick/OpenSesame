//! Profile and configuration refusals: AT-TLS-PURPOSE, CRL revocation at
//! the handshake, and AT-TLS-BADCONFIG (a required profile with bad
//! material never binds).

mod common;
#[path = "common/reject.rs"]
mod reject;

use std::sync::Arc;

use chrono::Utc;
use common::*;
use opensesame_domain::transport::{
    PeerIdentitySelector, TransportError, TransportPolicy, TrustProfileKind,
};
use opensesame_transport_security::testkit::{DisposableCa, LeafSpec, SanEntry};
use opensesame_transport_security::{
    client_config, ClientProfile, SecureListener, ServerProfile, TrustBundle,
};
use reject::*;

#[tokio::test]
async fn purpose_mismatch_is_refused_per_profile() {
    let stack = stack().await;
    // A serverAuth-only leaf presented as a client.
    let server_only = stack.client_ca.issue_server("notaclient.internal");
    expect_refused(
        &stack,
        raw_client(&stack, &server_only).unwrap(),
        "serverAuth-only leaf as client",
    )
    .await;
    // A clientAuth-only leaf cannot be a listener identity.
    let client_only = stack
        .server_ca
        .issue_client(PeerIdentitySelector::DnsName("localhost".into()))
        .identity();
    let mut profile = ServerProfile::new(TransportPolicy::ServerTls, Arc::new(client_only), "x");
    profile.listener_id = "x".into();
    assert!(profile
        .validate()
        .unwrap_err()
        .to_string()
        .contains("serverAuth"));
    // A serverAuth-only leaf cannot be a client identity in a ClientProfile.
    let mut cp = profile_for(&stack);
    cp.identity = Some(Arc::new(
        stack.client_ca.issue_server("s.internal").identity(),
    ));
    assert!(client_config(&cp)
        .unwrap_err()
        .to_string()
        .contains("clientAuth"));
    // A leaf with no EKU at all is any-purpose and accepted.
    let mut any = LeafSpec::client(vec![SanEntry::Dns("any.internal".into())]);
    any.omit_eku = true;
    let any = stack.client_ca.issue_with(&any);
    assert_eq!(
        raw_get(
            raw_client(&stack, &any).unwrap(),
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

fn profile_for(stack: &Stack) -> ClientProfile {
    profile(stack, None)
}

#[tokio::test]
async fn crl_revoked_client_is_refused_at_the_handshake() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let revoked = client_ca.issue_client(PeerIdentitySelector::DnsName("revoked.internal".into()));
    let fine = client_ca.issue_client(PeerIdentitySelector::DnsName("fine.internal".into()));
    let bundle = private_root(CLIENTS, &client_ca)
        .with_crls(&client_ca.crl_pem(&[&revoked]))
        .unwrap();
    let candidate = opensesame_transport_security::GenerationCandidate {
        identity: Some(Arc::new(server_ca.issue_server("localhost").identity())),
        peer_trust: [(profile_ref(CLIENTS), bundle)].into(),
        own_trust: None,
        identity_required: true,
    };
    let gens = opensesame_transport_security::TransportGenerations::new(
        candidate.into_generation(1, Utc::now()).unwrap(),
    );
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens, hits.clone()),
    )
    .await;
    let stack = Stack {
        server_ca,
        client_ca,
        served,
        hits,
    };
    expect_refused(
        &stack,
        raw_client(&stack, &revoked).unwrap(),
        "CRL-revoked leaf",
    )
    .await;
    assert_eq!(
        raw_get(
            raw_client(&stack, &fine).unwrap(),
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

#[tokio::test]
async fn bad_configuration_never_binds_a_listener() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server = server_ca.issue_server("localhost").identity();
    let gens = generations(server, &client_ca);
    let addr: std::net::SocketAddr = "127.0.0.1:0".parse().unwrap();
    // mtls_required without a client bundle.
    let err = SecureListener::bind(addr, gens.clone(), |g| {
        Ok(ServerProfile::new(
            TransportPolicy::MtlsRequired,
            g.identity.clone().unwrap(),
            "l",
        ))
    })
    .await
    .unwrap_err();
    assert!(err.to_string().contains("client trust"), "{err}");
    // A web-PKI bundle as client trust.
    let web = TrustBundle::from_pem(
        profile_ref("web"),
        TrustProfileKind::WebPkiDns,
        &client_ca.root_pem(),
    )
    .unwrap();
    let err = SecureListener::bind(addr, gens.clone(), move |g| {
        let mut p = ServerProfile::new(
            TransportPolicy::MtlsRequired,
            g.identity.clone().unwrap(),
            "l",
        );
        p.client_trust = Some(web.clone());
        Ok(p)
    })
    .await
    .unwrap_err();
    assert!(err.to_string().contains("web PKI"), "{err}");
    // existing_local is not a TLS policy; server_tls with client trust is confused.
    let err = SecureListener::bind(addr, gens.clone(), |g| {
        Ok(ServerProfile::new(
            TransportPolicy::ExistingLocal,
            g.identity.clone().unwrap(),
            "l",
        ))
    })
    .await
    .unwrap_err();
    assert_eq!(err.code(), "malformed_configuration");
    let err = SecureListener::bind(addr, gens.clone(), |g| {
        let mut p =
            ServerProfile::new(TransportPolicy::ServerTls, g.identity.clone().unwrap(), "l");
        p.client_trust = Some(g.trust(&profile_ref(CLIENTS))?.clone());
        Ok(p)
    })
    .await
    .unwrap_err();
    assert!(err.to_string().contains("server_tls"), "{err}");
    // A generation with no identity cannot serve.
    let empty = opensesame_transport_security::TransportGenerations::new(
        opensesame_transport_security::GenerationCandidate::default()
            .into_generation(1, Utc::now())
            .unwrap(),
    );
    assert_eq!(
        SecureListener::bind(addr, empty, profile_fn(TransportPolicy::MtlsRequired))
            .await
            .unwrap_err(),
        TransportError::IdentityMissing
    );
    // Malformed trust PEM and an anchor that is not a CA.
    assert_eq!(
        TrustBundle::from_pem(profile_ref("t"), TrustProfileKind::PrivateRoot, b"nope")
            .unwrap_err()
            .code(),
        "malformed_configuration"
    );
    let leaf = client_ca.issue_client(PeerIdentitySelector::DnsName("l.internal".into()));
    assert!(TrustBundle::from_pem(
        profile_ref("t"),
        TrustProfileKind::PrivateRoot,
        &leaf.leaf_pem
    )
    .unwrap_err()
    .to_string()
    .contains("not a CA"));
    assert!(private_root("t", &client_ca)
        .with_crls(b"-----BEGIN X509 CRL-----\nAAAA\n-----END X509 CRL-----\n")
        .is_err());
}
