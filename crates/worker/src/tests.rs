//! Worker transport and authorization tests.
//!
//! The mTLS cases run against a real [`SecureListener`] with a disposable CA
//! from `opensesame_transport_security::testkit`: nothing is mocked at the
//! transport boundary, so "no certificate is refused" is a handshake fact and
//! not an assertion about a source string.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode};
use opensesame_domain::transport::{
    operations, BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding,
    ServiceBindingSet, TrustProfileRef,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{
    reqwest_builder, ClientProfile, ServerNamePolicy, TrustBundle,
};

use crate::configured_providers;
use crate::routes::{self, require_worker_token, WorkerAuth, WorkerState};
use crate::transport::{self, WorkerTransport, DEFAULT_TRUST_PROFILE};

const SERVER_DNS: &str = "worker.test";
const CLIENT_DNS: &str = "host.test";

#[test]
fn workload_configuration_rejects_personal_only_providers() {
    assert!(configured_providers(&["aws-secrets-manager".into()]).is_ok());
    assert!(configured_providers(&["1password".into()]).is_err());
    assert!(configured_providers(&["does-not-exist".into()]).is_err());
}

#[test]
fn operator_compare_is_length_hiding() {
    let src = include_str!("routes.rs");
    assert!(src.contains("fn constant_time_eq"));
    assert!(src.contains("constant_time_eq(&presented, token)"));
    assert!(!src.contains("presented == token"));
}

#[test]
fn worker_token_fail_closed() {
    assert_eq!(
        require_worker_token("", &HeaderMap::new()),
        Err(StatusCode::SERVICE_UNAVAILABLE)
    );
    assert_eq!(
        require_worker_token("secret-token", &HeaderMap::new()),
        Err(StatusCode::UNAUTHORIZED)
    );
    let mut wrong = HeaderMap::new();
    wrong.insert("x-opensesame-operator", "nope".parse().unwrap());
    assert_eq!(
        require_worker_token("secret-token", &wrong),
        Err(StatusCode::UNAUTHORIZED)
    );
    let mut right = HeaderMap::new();
    right.insert("x-opensesame-operator", "secret-token".parse().unwrap());
    assert!(require_worker_token("secret-token", &right).is_ok());
}

#[test]
fn transport_profile_is_an_explicit_word() {
    let pick = |value: Option<&str>| {
        let owned = value.map(str::to_owned);
        WorkerTransport::parse(&move |name: &str| {
            (name == transport::TRANSPORT_VAR)
                .then(|| owned.clone())
                .flatten()
        })
    };
    assert_eq!(pick(None).unwrap(), WorkerTransport::ExistingLocal);
    assert_eq!(
        pick(Some("existing_local")).unwrap(),
        WorkerTransport::ExistingLocal
    );
    assert_eq!(
        pick(Some("mtls_required")).unwrap(),
        WorkerTransport::MtlsRequired
    );
    // Not a silent default: an unknown word refuses rather than downgrading.
    assert!(pick(Some("auto")).is_err());
    assert!(pick(Some("mtls")).is_err());
}

/// SVC-WORKER: the networked profile reads no token. Both variables are
/// invisible to it, and `WorkerAuth::Mtls` has nowhere to put one.
#[test]
fn mtls_profile_never_reads_a_worker_or_operator_token() {
    let main_src = include_str!("lib.rs");
    let mtls = main_src
        .split("async fn serve_mtls")
        .nth(1)
        .expect("serve_mtls")
        .split("fn configured_providers")
        .next()
        .expect("end of serve_mtls");
    assert!(!mtls.contains("OPENSESAME_WORKER_TOKEN"));
    assert!(!mtls.contains("OPENSESAME_OPERATOR_TOKEN"));
    let routes_src = include_str!("routes.rs");
    let variant = routes_src
        .split("Mtls {")
        .nth(1)
        .expect("Mtls variant")
        .split('}')
        .next()
        .expect("variant body");
    assert!(!variant.contains("token"));
}

struct Pki {
    dir: tempfile::TempDir,
    ca: DisposableCa,
    server: IssuedLeaf,
}

fn pki() -> Pki {
    let ca = DisposableCa::new("worker-test-ca");
    let server = ca.issue_server(SERVER_DNS);
    Pki {
        dir: tempfile::tempdir().expect("tempdir"),
        ca,
        server,
    }
}

fn binding(peer: PeerIdentitySelector, purpose: BindingPurpose, ops: &[&str]) -> ServiceBinding {
    ServiceBinding {
        id: "b1".into(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: TrustProfileRef::new(DEFAULT_TRUST_PROFILE).unwrap(),
        peer,
        service_principal: "svc:host".into(),
        purpose,
        allowed_operations: ops.iter().map(|o| (*o).to_string()).collect(),
        allowed_audiences: vec!["worker".into()],
        not_after: None,
        denied_thumbprints: vec![],
    }
}

/// Write the deployment-plane files and return a lookup over them.
fn env_for(
    pki: &Pki,
    bindings: &ServiceBindingSet,
) -> (PathBuf, impl Fn(&str) -> Option<String> + Clone) {
    let (cert, key) = pki.server.write_to(pki.dir.path());
    let trust = pki.dir.path().join("ca.pem");
    std::fs::write(&trust, pki.ca.ca_pem()).unwrap();
    let bindings_path = pki.dir.path().join("bindings.json");
    std::fs::write(&bindings_path, serde_json::to_string(bindings).unwrap()).unwrap();
    let p = |path: &std::path::Path| path.display().to_string();
    let map: Vec<(String, String)> = [
        ("OPENSESAME_WORKER_TLS_IDENTITY_SOURCE", "pem".to_owned()),
        ("OPENSESAME_WORKER_TLS_CERT_FILE", p(&cert)),
        ("OPENSESAME_WORKER_TLS_KEY_FILE", p(&key)),
        ("OPENSESAME_WORKER_TLS_TRUST_FILE", p(&trust)),
        (
            "OPENSESAME_WORKER_TLS_TRUST_KIND",
            "private_root".to_owned(),
        ),
        (transport::BINDINGS_VAR, p(&bindings_path)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let bindings_path2 = bindings_path.clone();
    (bindings_path2, move |name: &str| {
        map.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    })
}

async fn serve(pki: &Pki, bindings: ServiceBindingSet) -> SocketAddr {
    let (_path, lookup) = env_for(pki, &bindings);
    let profile = transport::load("127.0.0.1:0", &lookup).expect("secure profile");
    let state = WorkerState::new(
        configured_providers(&["aws-secrets-manager".into()]).unwrap(),
        WorkerAuth::Mtls {
            bindings: Arc::clone(&profile.bindings),
            generations: Arc::clone(&profile.generations),
        },
    );
    let listener = transport::bind(&profile).await.expect("bind");
    let addr = listener.local_addr();
    let app = routes::router(state);
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
async fn bound_certificate_is_admitted_and_unbound_one_is_not() {
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
            BindingPurpose::WorkerClient,
            &[
                operations::WORKER_PROVIDERS_LIST,
                operations::WORKER_HEALTH_READY,
            ],
        )],
    };
    let addr = serve(&pki, set).await;

    let ok = client(&pki, addr, Some(&bound))
        .get(url(addr, "/v1/providers"))
        .send()
        .await
        .expect("request");
    assert_eq!(ok.status(), StatusCode::OK);

    // AT-AUTHORITY-UNBOUND: a valid certificate under the same root that no
    // binding names is authenticated but not authorized.
    let denied = client(&pki, addr, Some(&stranger))
        .get(url(addr, "/v1/providers"))
        .send()
        .await
        .expect("request");
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        denied
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("peer_not_bound")
    );
}

#[tokio::test]
async fn a_caller_without_a_certificate_never_reaches_a_handler() {
    let pki = pki();
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(
            PeerIdentitySelector::DnsName(CLIENT_DNS.into()),
            BindingPurpose::WorkerClient,
            &[operations::WORKER_PROVIDERS_LIST],
        )],
    };
    let addr = serve(&pki, set).await;
    // The listener is `mtls_required`: rustls refuses the handshake, so even
    // `/health/live` is unreachable without a certificate.
    assert!(client(&pki, addr, None)
        .get(url(addr, "/health/live"))
        .send()
        .await
        .is_err());
}

#[tokio::test]
async fn wrong_purpose_and_wrong_operation_are_refused() {
    let pki = pki();
    let leaf = pki
        .ca
        .issue_client(PeerIdentitySelector::DnsName(CLIENT_DNS.into()));
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(
            PeerIdentitySelector::DnsName(CLIENT_DNS.into()),
            // Bound for the NATS bridge, not for this worker.
            BindingPurpose::NatsAuthBridge,
            &[operations::WORKER_PROVIDERS_LIST],
        )],
    };
    let addr = serve(&pki, set).await;
    let response = client(&pki, addr, Some(&leaf))
        .get(url(addr, "/v1/providers"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("peer_not_bound")
    );
}

#[tokio::test]
async fn readiness_probes_providers_only_after_admission() {
    let pki = pki();
    let stranger = pki
        .ca
        .issue_client(PeerIdentitySelector::DnsName("stranger.test".into()));
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(
            PeerIdentitySelector::DnsName(CLIENT_DNS.into()),
            BindingPurpose::WorkerClient,
            &[operations::WORKER_HEALTH_READY],
        )],
    };
    let (_path, lookup) = env_for(&pki, &set);
    let profile = transport::load("127.0.0.1:0", &lookup).expect("secure profile");
    let state = WorkerState::new(
        configured_providers(&["aws-secrets-manager".into()]).unwrap(),
        WorkerAuth::Mtls {
            bindings: Arc::clone(&profile.bindings),
            generations: Arc::clone(&profile.generations),
        },
    );
    let probe_cache = Arc::clone(&state.last_probe);
    let listener = transport::bind(&profile).await.expect("bind");
    let addr = listener.local_addr();
    tokio::spawn(listener.serve(routes::router(state)));
    let denied = client(&pki, addr, Some(&stranger))
        .get(url(addr, "/health/ready"))
        .send()
        .await
        .expect("request");
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert!(probe_cache.lock().unwrap().is_none());
}

#[test]
fn a_missing_or_malformed_bindings_file_fails_startup() {
    let pki = pki();
    let set = ServiceBindingSet::empty();
    let (path, lookup) = env_for(&pki, &set);
    assert!(transport::load("127.0.0.1:0", &lookup).is_ok());

    std::fs::write(&path, "{ not json").unwrap();
    assert!(transport::load("127.0.0.1:0", &lookup).is_err());

    std::fs::remove_file(&path).unwrap();
    assert!(transport::load("127.0.0.1:0", &lookup).is_err());
}

#[test]
fn a_missing_identity_or_trust_bundle_fails_startup() {
    let pki = pki();
    let set = ServiceBindingSet::empty();
    let (_path, lookup) = env_for(&pki, &set);
    let without = |drop: &'static str| {
        let inner = lookup.clone();
        move |name: &str| {
            if name == drop {
                None
            } else {
                inner(name)
            }
        }
    };
    assert!(transport::load(
        "127.0.0.1:0",
        &without("OPENSESAME_WORKER_TLS_IDENTITY_SOURCE")
    )
    .is_err());
    assert!(transport::load("127.0.0.1:0", &without("OPENSESAME_WORKER_TLS_TRUST_FILE")).is_err());
    assert!(transport::load("127.0.0.1:0", &without(transport::BINDINGS_VAR)).is_err());
}
