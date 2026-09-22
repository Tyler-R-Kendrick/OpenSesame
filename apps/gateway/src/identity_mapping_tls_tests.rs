//! SVC-MAPPING: the Host → Identity mapping client under `mtls`.
//!
//! The Identity side is a real [`SecureListener`] on the `mtls_required`
//! policy with a disposable CA, so "no identity is refused" and "a different
//! root is refused" are handshake facts, not assertions about configuration.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{
    ClientProfile, GenerationCandidate, SecureListener, ServerNamePolicy, ServerProfile,
    TransportGenerations, TrustBundle,
};

use crate::identity_mapping::IdentityMappingClient;

// A name that really resolves to the loopback listener: the client keeps
// its own DNS fence (`lookup_host`, ≤16 addresses), so a fictional name
// would fail before TLS and prove nothing about the handshake.
const IDENTITY_DNS: &str = "localhost";
const HOST_DNS: &str = "host.test";

struct Stub {
    addr: SocketAddr,
    ca: DisposableCa,
    authorization_seen: Arc<AtomicUsize>,
}

fn bundle(pem: &[u8], name: &str) -> TrustBundle {
    TrustBundle::from_pem(
        TrustProfileRef::new(name).unwrap(),
        TrustProfileKind::PrivateRoot,
        pem,
    )
    .unwrap()
}

/// An Identity stand-in that requires a client certificate and answers the
/// one mapping route.
async fn identity_stub() -> Stub {
    let ca = DisposableCa::new("identity-test-ca");
    let server = ca.issue_server(IDENTITY_DNS);
    let seen = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&seen);
    let router = Router::new().route(
        "/v1/principals/mapping/resolve",
        get(move |headers: axum::http::HeaderMap| {
            let observed = Arc::clone(&observed);
            async move {
                if headers.contains_key(axum::http::header::AUTHORIZATION) {
                    observed.fetch_add(1, Ordering::SeqCst);
                }
                axum::Json(serde_json::json!({
                    "principalId": format!("prn_{}", uuid::Uuid::new_v4().simple()),
                    "provisional": false,
                    "assurance": "verified",
                    "issuer": "https://issuer.example",
                    "subject": "subject-1"
                }))
            }
        }),
    );
    let mut candidate = GenerationCandidate {
        identity: Some(Arc::new(server.identity())),
        identity_required: true,
        ..GenerationCandidate::default()
    };
    let profile = TrustProfileRef::new("client_ca").unwrap();
    candidate
        .peer_trust
        .insert(profile.clone(), bundle(&ca.ca_pem(), "client_ca"));
    let generations =
        TransportGenerations::new(candidate.into_generation(1, chrono::Utc::now()).unwrap());
    let listener = SecureListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        Arc::clone(&generations),
        move |generation| {
            let identity = generation.identity.clone().unwrap();
            let mut server = ServerProfile::new(
                TransportPolicy::MtlsRequired,
                identity,
                "identity-mapping-tls",
            );
            server.client_trust = Some(generation.trust(&profile)?.clone());
            Ok(server)
        },
    )
    .await
    .expect("bind");
    let addr = listener.local_addr();
    tokio::spawn(listener.serve(router));
    Stub {
        addr,
        ca,
        authorization_seen: seen,
    }
}

fn client_profile(trust_pem: &[u8], leaf: Option<&IssuedLeaf>, server_name: &str) -> ClientProfile {
    ClientProfile {
        server_trust: bundle(trust_pem, "identity-server"),
        server_name: ServerNamePolicy::Dns(server_name.to_owned()),
        identity: leaf.map(|l| Arc::new(l.identity())),
        min_version: TlsVersion::Tls13,
    }
}

fn base(addr: SocketAddr) -> String {
    format!("https://{IDENTITY_DNS}:{}", addr.port())
}

#[tokio::test]
async fn a_valid_client_identity_resolves_and_sends_no_bearer() {
    let stub = identity_stub().await;
    let leaf = stub
        .ca
        .issue_client(PeerIdentitySelector::DnsName(HOST_DNS.into()));
    let client = IdentityMappingClient::with_mtls(
        &base(stub.addr),
        client_profile(&stub.ca.ca_pem(), Some(&leaf), IDENTITY_DNS),
        true,
    )
    .expect("client");
    let mapped = client
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .expect("resolve")
        .expect("mapped");
    assert!(mapped.principal_id.starts_with("prn_"));
    // No bearer is sent at all under `mtls`; there is no second credential.
    assert_eq!(stub.authorization_seen.load(Ordering::SeqCst), 0);
}

/// The expected server identity is checked against the endpoint before a
/// socket is opened, so a misconfiguration never becomes a connection to the
/// wrong host.
#[tokio::test]
async fn a_wrong_server_name_is_refused_before_any_request() {
    let stub = identity_stub().await;
    let leaf = stub
        .ca
        .issue_client(PeerIdentitySelector::DnsName(HOST_DNS.into()));
    let error = IdentityMappingClient::with_mtls(
        &base(stub.addr),
        client_profile(&stub.ca.ca_pem(), Some(&leaf), "elsewhere.test"),
        true,
    )
    .expect_err("server name mismatch");
    assert!(error.to_string().contains("mapping server name mismatch"));
}

#[tokio::test]
async fn a_client_with_no_identity_is_refused_by_the_receiver() {
    let stub = identity_stub().await;
    let client = IdentityMappingClient::with_mtls(
        &base(stub.addr),
        client_profile(&stub.ca.ca_pem(), None, IDENTITY_DNS),
        true,
    )
    .expect("client");
    assert!(client
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .is_err());
}

#[tokio::test]
async fn a_certificate_from_a_different_root_is_refused() {
    let stub = identity_stub().await;
    let stranger = DisposableCa::new("stranger-ca");
    let leaf = stranger.issue_client(PeerIdentitySelector::DnsName(HOST_DNS.into()));
    let client = IdentityMappingClient::with_mtls(
        &base(stub.addr),
        client_profile(&stub.ca.ca_pem(), Some(&leaf), IDENTITY_DNS),
        true,
    )
    .expect("client");
    assert!(client
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .is_err());

    // And the reverse: our certificate is fine but the server's root is not
    // the one we pinned.
    let ours = stub
        .ca
        .issue_client(PeerIdentitySelector::DnsName(HOST_DNS.into()));
    let client = IdentityMappingClient::with_mtls(
        &base(stub.addr),
        client_profile(&stranger.ca_pem(), Some(&ours), IDENTITY_DNS),
        true,
    )
    .expect("client");
    assert!(client
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .is_err());
}

/// An `mtls` client never speaks plaintext, even on loopback in development.
#[test]
fn an_mtls_client_refuses_an_http_endpoint() {
    let ca = DisposableCa::new("ca");
    let leaf = ca.issue_client(PeerIdentitySelector::DnsName(HOST_DNS.into()));
    assert!(IdentityMappingClient::with_mtls(
        "http://127.0.0.1:8788",
        client_profile(&ca.ca_pem(), Some(&leaf), "127.0.0.1"),
        true,
    )
    .is_err());
}

#[test]
fn resolve_refuses_a_mode_whose_material_is_absent() {
    let empty = |_: &str| None;
    assert!(crate::identity_mapping_tls::resolve(
        crate::transport::config::AuthMode::Unconfigured,
        &empty
    )
    .expect("unconfigured is not an error")
    .is_none());
    assert!(crate::identity_mapping_tls::resolve(
        crate::transport::config::AuthMode::SharedSecret,
        &empty
    )
    .is_err());
    assert!(
        crate::identity_mapping_tls::resolve(crate::transport::config::AuthMode::Mtls, &empty)
            .is_err()
    );
}

#[test]
fn the_egress_fences_are_still_in_the_request_path() {
    let src = include_str!("identity_mapping.rs");
    for fence in [
        ".no_proxy()",
        "redirect::Policy::none()",
        "connect_timeout(Duration::from_secs(2))",
        "timeout(Duration::from_secs(5))",
        "resolve_to_addrs(host, &addresses)",
        "addresses.len() > 16",
        "is_blocked_host",
        "validate_mapping(&body, issuer, subject)",
        "length > 8192",
    ] {
        assert!(src.contains(fence), "lost fence {fence}");
    }
}
