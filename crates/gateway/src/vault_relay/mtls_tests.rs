//! Relay `mtls_required` admission against a real [`SecureListener`].

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use opensesame_domain::transport::{
    operations, BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding,
    ServiceBindingSet, TrustProfileRef,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{
    reqwest_builder, ClientProfile, ServerNamePolicy, TrustBundle,
};
use serde_json::json;

use super::test_support::{key, snapshot};
use super::transport::{self, DEFAULT_TRUST_PROFILE, RELAY_TLS_PREFIX};
use super::{router_with, RelayMtls, Store};

const SERVER_DNS: &str = "relay.test";
const CLIENT_DNS: &str = "sync.test";

struct Pki {
    dir: tempfile::TempDir,
    ca: DisposableCa,
    server: IssuedLeaf,
}

fn pki() -> Pki {
    let ca = DisposableCa::new("relay-test-ca");
    let server = ca.issue_server(SERVER_DNS);
    Pki {
        dir: tempfile::tempdir().expect("tempdir"),
        ca,
        server,
    }
}

fn binding(peer: PeerIdentitySelector, ops: &[&str]) -> ServiceBinding {
    ServiceBinding {
        id: "relay-1".into(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: TrustProfileRef::new(DEFAULT_TRUST_PROFILE).unwrap(),
        peer,
        service_principal: "svc:relay".into(),
        purpose: BindingPurpose::VaultRelay,
        allowed_operations: ops.iter().map(|o| (*o).to_string()).collect(),
        allowed_audiences: vec!["relay".into()],
        not_after: None,
        denied_thumbprints: vec![],
    }
}

fn env_for(
    pki: &Pki,
    bindings: &ServiceBindingSet,
) -> (PathBuf, impl Fn(&str) -> Option<String> + Clone) {
    let (cert, key_path) = pki.server.write_to(pki.dir.path());
    let trust = pki.dir.path().join("ca.pem");
    std::fs::write(&trust, pki.ca.ca_pem()).unwrap();
    let bindings_path = pki.dir.path().join("bindings.json");
    std::fs::write(&bindings_path, serde_json::to_string(bindings).unwrap()).unwrap();
    let p = |path: &std::path::Path| path.display().to_string();
    let map: Vec<(String, String)> = [
        (
            transport::TRANSPORT_VAR.to_owned(),
            "mtls_required".to_owned(),
        ),
        (
            "OPENSESAME_SERVICE_BINDINGS_FILE".to_owned(),
            p(&bindings_path),
        ),
        (
            format!("{RELAY_TLS_PREFIX}_IDENTITY_SOURCE"),
            "pem".to_owned(),
        ),
        (format!("{RELAY_TLS_PREFIX}_CERT_FILE"), p(&cert)),
        (format!("{RELAY_TLS_PREFIX}_KEY_FILE"), p(&key_path)),
        (format!("{RELAY_TLS_PREFIX}_TRUST_FILE"), p(&trust)),
        (
            format!("{RELAY_TLS_PREFIX}_TRUST_KIND"),
            "private_root".to_owned(),
        ),
    ]
    .into_iter()
    .collect();
    let bindings_path2 = bindings_path.clone();
    (bindings_path2, move |name: &str| {
        map.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    })
}

async fn serve(pki: &Pki, bindings: ServiceBindingSet) -> SocketAddr {
    let (_path, lookup) = env_for(pki, &bindings);
    let profile = transport::load_secure("127.0.0.1:0", &lookup).expect("secure profile");
    let mtls = RelayMtls {
        generations: Arc::clone(&profile.generations),
    };
    let app = router_with(
        Arc::new(Mutex::new(Store::default())),
        (*profile.bindings).clone(),
        Some(mtls),
    )
    .layer(axum::middleware::from_fn_with_state(
        Arc::clone(&profile.generations),
        opensesame_transport_security::enforce_current_generation,
    ));
    let listener = transport::bind_secure(&profile).await.expect("bind");
    let addr = listener.local_addr();
    tokio::spawn(listener.serve(app));
    addr
}

fn client(pki: &Pki, addr: SocketAddr, leaf: Option<&IssuedLeaf>) -> reqwest::Client {
    let trust = TrustBundle::from_pem(
        TrustProfileRef::new("server").unwrap(),
        opensesame_domain::transport::TrustProfileKind::PrivateRoot,
        &pki.ca.ca_pem(),
    )
    .unwrap();
    let profile = ClientProfile {
        server_trust: trust,
        server_name: ServerNamePolicy::Dns(SERVER_DNS.into()),
        identity: leaf.map(|l| Arc::new(l.identity())),
        min_version: opensesame_domain::transport::TlsVersion::Tls13,
    };
    let base = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .resolve_to_addrs(SERVER_DNS, &[addr]);
    reqwest_builder(&profile, base).unwrap().build().unwrap()
}

fn url(addr: SocketAddr, path: &str) -> String {
    format!("https://{SERVER_DNS}:{}{path}", addr.port())
}

#[tokio::test]
async fn uncertified_peer_is_refused_and_certificated_peer_syncs() {
    let pki = pki();
    let bound = pki
        .ca
        .issue_client(PeerIdentitySelector::DnsName(CLIENT_DNS.into()));
    let stranger = pki
        .ca
        .issue_client(PeerIdentitySelector::DnsName("stranger.test".into()));
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(
            PeerIdentitySelector::DnsName(CLIENT_DNS.into()),
            &[
                operations::VAULT_RELAY_SNAPSHOT_READ,
                operations::VAULT_RELAY_SNAPSHOT_WRITE,
            ],
        )],
    };
    let addr = serve(&pki, set).await;
    let slot_key = key();
    let body = json!({ "expected_generation": 0, "snapshot": snapshot("prj_sync") });

    let denied = client(&pki, addr, Some(&stranger))
        .put(url(addr, "/v1/vault-relay/ada/personal/snapshot"))
        .header("x-opensesame-slot-key", &slot_key)
        .header("x-opensesame-principal", "ada")
        .header("x-opensesame-owner-kind", "user")
        .json(&body)
        .send()
        .await
        .expect("request");
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let no_cert = client(&pki, addr, None)
        .put(url(addr, "/v1/vault-relay/ada/personal/snapshot"))
        .header("x-opensesame-slot-key", &slot_key)
        .json(&body)
        .send()
        .await;
    assert!(no_cert.is_err() || no_cert.unwrap().status() == StatusCode::FORBIDDEN);

    let ok = client(&pki, addr, Some(&bound))
        .put(url(addr, "/v1/vault-relay/ada/personal/snapshot"))
        .header("x-opensesame-slot-key", &slot_key)
        .header("x-opensesame-principal", "ada")
        .header("x-opensesame-owner-kind", "user")
        .json(&body)
        .send()
        .await
        .expect("put");
    assert_eq!(ok.status(), StatusCode::OK);

    let read = client(&pki, addr, Some(&bound))
        .get(url(addr, "/v1/vault-relay/ada/personal/snapshot"))
        .header("x-opensesame-slot-key", &slot_key)
        .send()
        .await
        .expect("get");
    assert_eq!(read.status(), StatusCode::OK);
    let payload = read.json::<serde_json::Value>().await.expect("json");
    assert_eq!(payload["generation"], 1);
}
