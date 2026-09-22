//! AT-TLS-VALID: correct server, valid client chain and key; the call
//! succeeds, the peer is attested, and the evidence is what the router
//! sees. Two independent clients (raw tokio-rustls, reqwest) plus a
//! `ServerTls` listener that yields no peer.

mod common;

use std::sync::Arc;

use common::*;
use opensesame_domain::transport::{PeerIdentitySelector, TlsVersion, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, dial_name, reqwest_builder, ClientProfile, ServerNamePolicy,
};

fn client_profile(
    server_ca: &DisposableCa,
    identity: Option<opensesame_transport_security::TlsIdentity>,
) -> ClientProfile {
    ClientProfile {
        server_trust: private_root("servers", server_ca),
        server_name: ServerNamePolicy::Dns("localhost".into()),
        identity: identity.map(Arc::new),
        min_version: TlsVersion::Tls13,
    }
}

#[tokio::test]
async fn mtls_required_attests_the_client_over_a_real_handshake() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server_identity = server_ca.issue_server("localhost").identity();
    let client = client_ca.issue_client(PeerIdentitySelector::DnsName("worker-1.internal".into()));
    let gens = generations(server_identity, &client_ca);
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens.clone(), hits.clone()),
    )
    .await;

    let config =
        Arc::new(client_config(&client_profile(&server_ca, Some(client.identity()))).unwrap());
    let (status, body) = raw_get(config.clone(), served.addr, localhost(), "/whoami")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["listener"], LISTENER);
    assert_eq!(json["policy"], "MtlsRequired");
    assert_eq!(json["generation"], 1);
    let peer = &json["peer"];
    assert_eq!(peer["leaf_thumbprint_sha256"], client.thumbprint);
    assert_eq!(peer["source"], "direct_tls");
    assert_eq!(peer["tls_version"], "tls13");
    assert_eq!(peer["trust_profile"]["name"], CLIENTS);
    assert_eq!(peer["credential_generation"], 1);
    assert_eq!(peer["trust_generation"], 1);
    assert_eq!(
        peer["identities"][0],
        serde_json::json!({"dns_name": "worker-1.internal"})
    );
    assert_eq!(
        peer["identities"][1],
        serde_json::json!({"leaf_thumbprint_sha256": client.thumbprint})
    );

    let (status, body) = raw_get(config, served.addr, localhost(), "/protected")
        .await
        .unwrap();
    assert_eq!((status, body.as_str()), (200, "protected ok"));
    assert_eq!(hits.protected(), 1);
    assert_eq!(served.counters.handshakes_ok(), 2);
    assert_eq!(served.counters.handshakes_failed(), 0);
}

#[tokio::test]
async fn reqwest_client_built_from_profile_authenticates_and_exposes_tls_info() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server_identity = server_ca.issue_server("localhost").identity();
    let client = client_ca.issue_spiffe("spiffe://example.org/worker/1");
    let gens = generations(server_identity, &client_ca);
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens.clone(), Hits::default()),
    )
    .await;

    let base = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5));
    let http = reqwest_builder(&client_profile(&server_ca, Some(client.identity())), base)
        .unwrap()
        .build()
        .unwrap();
    let response = http
        .get(format!("https://localhost:{}/whoami", served.addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let info = response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .expect("tls_info(true) keeps the peer certificate");
    assert!(info.peer_certificate().is_some());
    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(
        json["peer"]["identities"][0],
        serde_json::json!({"spiffe_id": "spiffe://example.org/worker/1"})
    );
    assert_eq!(json["peer"]["leaf_thumbprint_sha256"], client.thumbprint);
}

#[tokio::test]
async fn server_tls_verifies_no_client_and_yields_no_peer() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server_identity = server_ca.issue_server("localhost").identity();
    let gens = generations(server_identity, &client_ca);
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::ServerTls),
        router(gens.clone(), hits.clone()),
    )
    .await;
    let config = Arc::new(client_config(&client_profile(&server_ca, None)).unwrap());
    let (status, body) = raw_get(config.clone(), served.addr, localhost(), "/whoami")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["policy"], "ServerTls");
    assert!(json["peer"].is_null());
    // The guard passes a peerless request through: requiring a peer is the
    // listener policy's and admission's job, not the guard's.
    let (status, _) = raw_get(config, served.addr, localhost(), "/protected")
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(hits.protected(), 1);
}

#[tokio::test]
async fn tls12_only_by_explicit_minimum_and_attested_as_such() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server_identity = server_ca.issue_server("localhost").identity();
    let client = client_ca.issue_client(PeerIdentitySelector::DnsName("legacy.internal".into()));
    let gens = generations(server_identity, &client_ca);
    let served = serve(
        gens.clone(),
        move |g| {
            let mut p = profile_fn(TransportPolicy::MtlsRequired)(g)?;
            p.min_version = TlsVersion::Tls12;
            Ok(p)
        },
        router(gens.clone(), Hits::default()),
    )
    .await;
    // A TLS 1.3-only client still negotiates 1.3 against a 1.2-minimum server.
    let profile = client_profile(&server_ca, Some(client.identity()));
    let cfg13 = Arc::new(client_config(&profile).unwrap());
    let (_, body) = raw_get(cfg13, served.addr, localhost(), "/whoami")
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["peer"]["tls_version"],
        "tls13"
    );
    // A client restricted to TLS 1.2 by rustls is attested as tls12.
    let only12 = |with_cert: bool| {
        use rustls::pki_types::pem::PemObject;
        use secrecy::ExposeSecret;
        let roots = private_root("servers", &server_ca).roots();
        let builder =
            rustls::ClientConfig::builder_with_provider(opensesame_transport_security::provider())
                .with_protocol_versions(&[&rustls::version::TLS12])
                .unwrap()
                .with_root_certificates(roots);
        if with_cert {
            let chain = rustls::pki_types::CertificateDer::pem_slice_iter(&client.cert_pem)
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let key =
                rustls::pki_types::PrivateKeyDer::from_pem_slice(client.key_pem.expose_secret())
                    .unwrap();
            builder.with_client_auth_cert(chain, key).unwrap()
        } else {
            builder.with_no_client_auth()
        }
    };
    let (_, body) = raw_get(Arc::new(only12(true)), served.addr, localhost(), "/whoami")
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["peer"]["tls_version"],
        "tls12"
    );
    // And a TLS 1.3-minimum server refuses that 1.2-only client.
    let strict = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens.clone(), Hits::default()),
    )
    .await;
    let err = raw_get(Arc::new(only12(true)), strict.addr, localhost(), "/health")
        .await
        .unwrap_err();
    assert!(err.starts_with("tls:"), "{err}");
    let _ = dial_name(&ServerNamePolicy::Dns("localhost".into()), "127.0.0.1").unwrap();
}
