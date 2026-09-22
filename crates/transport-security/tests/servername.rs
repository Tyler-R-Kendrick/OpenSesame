//! AT-TLS-SERVERNAME and the SPIFFE server profile (AT-TLS-PURPOSE for
//! dual-EKU SVIDs, AT-SPIFFE-SAN / AT-SPIFFE-FEDERATION from the client
//! side): a wrong DNS identity, wrong trust domain, wrong path, extra URI
//! SAN, zero URI SAN, or a bundle of another domain is denied before any
//! application byte is sent.

mod common;

use std::sync::Arc;

use common::*;
use opensesame_domain::transport::{TlsVersion, TransportPolicy, TrustProfileKind};
use opensesame_transport_security::testkit::{DisposableCa, LeafSpec, SanEntry};
use opensesame_transport_security::{
    client_config, dial_name, ClientProfile, ServerNamePolicy, TrustBundle,
};

const SVID: &str = "spiffe://example.org/host/gateway";

async fn serve_spiffe(
    server_ca: &DisposableCa,
    client_ca: &DisposableCa,
    spec: LeafSpec,
) -> (Served, Hits) {
    let server_identity = server_ca.issue_with(&spec).identity();
    let gens = generations(server_identity, client_ca);
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::ServerTls),
        router(gens, hits.clone()),
    )
    .await;
    (served, hits)
}

fn dns_profile(server_ca: &DisposableCa, name: &str) -> ClientProfile {
    ClientProfile {
        server_trust: private_root("servers", server_ca),
        server_name: ServerNamePolicy::Dns(name.into()),
        identity: None,
        min_version: TlsVersion::Tls13,
    }
}

fn spiffe_profile(bundle_ca: &DisposableCa, expected: &str) -> ClientProfile {
    ClientProfile {
        server_trust: spiffe_bundle("mesh", bundle_ca),
        server_name: ServerNamePolicy::SpiffeId(expected.into()),
        identity: None,
        min_version: TlsVersion::Tls13,
    }
}

async fn get(
    profile: &ClientProfile,
    served: &Served,
    dialed: &str,
) -> Result<(u16, String), String> {
    let config = Arc::new(client_config(profile).map_err(|e| e.to_string())?);
    let name = dial_name(&profile.server_name, dialed).map_err(|e| e.to_string())?;
    raw_get(config, served.addr, name, "/health").await
}

#[tokio::test]
async fn dns_mismatch_is_denied_before_any_request_is_sent() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let (served, hits) = serve_spiffe(&server_ca, &client_ca, LeafSpec::server("localhost")).await;
    assert_eq!(
        get(&dns_profile(&server_ca, "localhost"), &served, "127.0.0.1")
            .await
            .unwrap()
            .0,
        200
    );
    let err = get(
        &dns_profile(&server_ca, "other.internal"),
        &served,
        "127.0.0.1",
    )
    .await
    .unwrap_err();
    assert!(err.starts_with("tls:"), "{err}");
    // The wrong-name request never reached a handler: only the good one did.
    assert_eq!(hits.protected(), 0);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(served.counters.handshakes_ok(), 1);
    // Wrong root for the right name.
    let other = DisposableCa::new("other-root");
    let err = get(&dns_profile(&other, "localhost"), &served, "127.0.0.1")
        .await
        .unwrap_err();
    assert!(err.starts_with("tls:"), "{err}");
    // A wildcard or IP is not a reference identity here.
    assert!(client_config(&dns_profile(&server_ca, "*.internal")).is_err());
    assert!(client_config(&dns_profile(&server_ca, "127.0.0.1")).is_err());
}

#[tokio::test]
async fn spiffe_dual_eku_leaf_is_accepted_under_the_spiffe_profile() {
    let server_ca = DisposableCa::new("mesh-root");
    let client_ca = DisposableCa::new("clients");
    let (served, _) = serve_spiffe(&server_ca, &client_ca, LeafSpec::spiffe(SVID)).await;
    let (status, body) = get(&spiffe_profile(&server_ca, SVID), &served, "127.0.0.1")
        .await
        .unwrap();
    assert_eq!((status, body.as_str()), (200, "ok"));
    // Dialed by name works the same: the name is SNI only.
    assert_eq!(
        get(&spiffe_profile(&server_ca, SVID), &served, "localhost")
            .await
            .unwrap()
            .0,
        200
    );
    // The same SVID is *not* a DNS identity: the DNS profile refuses it.
    let err = get(&dns_profile(&server_ca, "localhost"), &served, "127.0.0.1")
        .await
        .unwrap_err();
    assert!(err.starts_with("tls:"), "{err}");
}

#[tokio::test]
async fn spiffe_mismatches_are_denied() {
    let server_ca = DisposableCa::new("mesh-root");
    let client_ca = DisposableCa::new("clients");
    // Wrong path.
    let (served, _) = serve_spiffe(
        &server_ca,
        &client_ca,
        LeafSpec::spiffe("spiffe://example.org/host/other"),
    )
    .await;
    assert!(get(&spiffe_profile(&server_ca, SVID), &served, "127.0.0.1")
        .await
        .unwrap_err()
        .starts_with("tls:"));
    // Wrong trust domain, same path.
    let (served, _) = serve_spiffe(
        &server_ca,
        &client_ca,
        LeafSpec::spiffe("spiffe://evil.example/host/gateway"),
    )
    .await;
    assert!(get(&spiffe_profile(&server_ca, SVID), &served, "127.0.0.1")
        .await
        .unwrap_err()
        .starts_with("tls:"));
    // Extra URI SAN beside the right one.
    let mut extra = LeafSpec::spiffe(SVID);
    extra
        .sans
        .push(SanEntry::Uri("spiffe://example.org/host/extra".into()));
    let (served, _) = serve_spiffe(&server_ca, &client_ca, extra).await;
    assert!(get(&spiffe_profile(&server_ca, SVID), &served, "127.0.0.1")
        .await
        .unwrap_err()
        .starts_with("tls:"));
    // Zero URI SANs (a plain DNS server leaf).
    let (served, _) = serve_spiffe(&server_ca, &client_ca, LeafSpec::server("localhost")).await;
    assert!(get(&spiffe_profile(&server_ca, SVID), &served, "127.0.0.1")
        .await
        .unwrap_err()
        .starts_with("tls:"));
    // Federation: another domain's bundle for this domain's SVID.
    let (served, _) = serve_spiffe(&server_ca, &client_ca, LeafSpec::spiffe(SVID)).await;
    let foreign = DisposableCa::new("foreign-root");
    assert!(get(&spiffe_profile(&foreign, SVID), &served, "127.0.0.1")
        .await
        .unwrap_err()
        .starts_with("tls:"));
    // Case and trailing-slash differences are not the same ID.
    assert!(get(
        &spiffe_profile(&server_ca, "spiffe://example.org/host/Gateway"),
        &served,
        "127.0.0.1"
    )
    .await
    .unwrap_err()
    .starts_with("tls:"));
    // A clientAuth-only SVID cannot even become a listener identity.
    let mut client_only = LeafSpec::spiffe(SVID);
    client_only.server_auth = false;
    let gens = generations(server_ca.issue_with(&client_only).identity(), &client_ca);
    let err = opensesame_transport_security::SecureListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        gens,
        profile_fn(TransportPolicy::ServerTls),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("serverAuth"), "{err}");
}

#[tokio::test]
async fn profile_and_bundle_kind_must_agree() {
    let ca = DisposableCa::new("root");
    let web = TrustBundle::from_pem(
        profile_ref("web"),
        TrustProfileKind::WebPkiDns,
        &ca.root_pem(),
    )
    .unwrap();
    let mut profile = ClientProfile {
        server_trust: web,
        server_name: ServerNamePolicy::SpiffeId(SVID.into()),
        identity: None,
        min_version: TlsVersion::Tls13,
    };
    assert!(client_config(&profile)
        .unwrap_err()
        .to_string()
        .contains("spiffe_trust_domain"));
    profile.server_trust = spiffe_bundle("mesh", &ca);
    profile.server_name = ServerNamePolicy::Dns("localhost".into());
    assert!(client_config(&profile)
        .unwrap_err()
        .to_string()
        .contains("web_pki_dns or private_root"));
    profile.server_name = ServerNamePolicy::SpiffeId("spiffe://example.org".into());
    assert!(
        client_config(&profile).is_err(),
        "a trust domain alone is not a workload ID"
    );
    profile.server_name = ServerNamePolicy::SpiffeId("https://example.org/x".into());
    assert!(client_config(&profile).is_err());
}
