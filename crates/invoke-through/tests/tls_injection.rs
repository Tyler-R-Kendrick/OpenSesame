//! AT-TLS-SERVERNAME / AT-CONNECTOR-EGRESS on the invoke-through path: an
//! injected TLS scope refuses the wrong server before any request byte (and
//! therefore before the bearer) is sent, presents exactly the injected client
//! identity, returns a redirect as data, and dials nothing but its pinned
//! authority.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TransportError, TransportPolicy, TrustProfileKind,
    TrustProfileRef,
};
use opensesame_invoke_through::{
    AuthStyle, EgressRule, InvokeError, InvokeRequest, Invoker, TlsClientSpec,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{
    client_config, ClientProfile, Generation, GenerationCandidate, PeerExtension, SecureListener,
    ServerNamePolicy, ServerProfile, TlsIdentity, TransportGenerations, TrustBundle,
};
use rustls::pki_types::ServerName;
use secrecy::SecretString;

const HOST: &str = "connector.example";
const CANARY: &str = "CANARY-BEARER-never-on-the-wrong-peer";

fn bundle(name: &str, ca: &DisposableCa) -> TrustBundle {
    TrustBundle::from_pem(
        TrustProfileRef::new(name).unwrap(),
        TrustProfileKind::PrivateRoot,
        &ca.root_pem(),
    )
    .unwrap()
}

#[derive(Clone, Default)]
struct Seen {
    hits: Arc<AtomicU64>,
    /// `(client leaf thumbprint, authorization header)` per hit.
    peers: Arc<Mutex<Vec<(Option<String>, Option<String>)>>>,
}

async fn ok(State(seen): State<Seen>, req: Request) -> Response {
    seen.hits.fetch_add(1, Ordering::SeqCst);
    let peer = req
        .extensions()
        .get::<PeerExtension>()
        .map(|p| p.0.leaf_thumbprint_sha256().to_owned());
    let auth = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    seen.peers.lock().unwrap().push((peer, auth));
    "ok".into_response()
}

async fn redirect(State(seen): State<Seen>) -> Response {
    seen.hits.fetch_add(1, Ordering::SeqCst);
    (
        axum::http::StatusCode::FOUND,
        [("location", "https://evil.example/steal")],
        "see elsewhere",
    )
        .into_response()
}

struct Served {
    addr: SocketAddr,
    seen: Seen,
    _task: tokio::task::JoinHandle<Result<(), TransportError>>,
}

async fn serve(server: TlsIdentity, policy: TransportPolicy, client_ca: &DisposableCa) -> Served {
    let clients = TrustProfileRef::new("clients").unwrap();
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(server)),
        peer_trust: [(clients.clone(), bundle("clients", client_ca))].into(),
        own_trust: None,
        identity_required: true,
    };
    let generations = TransportGenerations::new(
        candidate
            .into_generation(1, chrono::Utc::now())
            .expect("generation"),
    );
    let profile = move |generation: &Generation| {
        let identity = generation
            .identity
            .clone()
            .ok_or(TransportError::IdentityMissing)?;
        let mut profile = ServerProfile::new(policy, identity, "test-tls");
        if policy.authenticates_client() {
            profile.client_trust = Some(generation.trust(&clients)?.clone());
        }
        Ok(profile)
    };
    let listener = SecureListener::bind("127.0.0.1:0".parse().unwrap(), generations, profile)
        .await
        .expect("bind");
    let addr = listener.local_addr();
    let seen = Seen::default();
    let app = Router::new()
        .route("/ok", get(ok))
        .route("/redirect", get(redirect))
        .with_state(seen.clone());
    let task = tokio::spawn(listener.serve(app));
    Served {
        addr,
        seen,
        _task: task,
    }
}

fn rules(hosts: &'static [&'static str]) -> Vec<EgressRule> {
    vec![EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts,
        auth: AuthStyle::Bearer,
    }]
}

fn spec(
    trust: TrustBundle,
    identity: Option<&IssuedLeaf>,
    server_name: Option<&str>,
    pinned: SocketAddr,
) -> TlsClientSpec {
    let profile = ClientProfile {
        server_trust: trust,
        server_name: ServerNamePolicy::Dns(HOST.into()),
        identity: identity.map(|leaf| Arc::new(leaf.identity())),
        min_version: TlsVersion::Tls13,
    };
    TlsClientSpec {
        config: Arc::new(client_config(&profile).expect("client config")),
        server_name: server_name.map(|n| ServerName::try_from(n.to_owned()).unwrap()),
        pinned: Some((HOST.into(), vec![pinned])),
    }
}

fn request(url: String) -> InvokeRequest {
    InvokeRequest {
        provider_id: "github".into(),
        method: "GET".into(),
        url,
        headers: vec![],
        body: None,
        subject: None,
        actor: None,
    }
}

async fn call(invoker: &Invoker, url: String) -> Result<u16, InvokeError> {
    let prepared = invoker.preflight(request(url))?;
    invoker
        .execute(&SecretString::from(CANARY), prepared)
        .await
        .map(|r| r.status)
}

#[tokio::test]
async fn right_root_wrong_name_is_refused_before_any_request_byte() {
    let servers = DisposableCa::new("servers");
    let clients = DisposableCa::new("clients");
    let served = serve(
        servers.issue_server("other.example").identity(),
        TransportPolicy::ServerTls,
        &clients,
    )
    .await;
    let invoker = Invoker::with_tls(
        rules(&[HOST]),
        &spec(bundle("servers", &servers), None, None, served.addr),
    )
    .allow_http_for_tests();
    let err = call(&invoker, format!("https://{HOST}:{}/ok", served.addr.port()))
        .await
        .expect_err("name mismatch");
    assert!(matches!(err, InvokeError::Transport(_)), "{err}");
    assert!(!format!("{err}").contains(CANARY));
    assert_eq!(served.seen.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn right_name_wrong_root_is_refused_before_any_request_byte() {
    let servers = DisposableCa::new("servers");
    let rogue = DisposableCa::new("rogue");
    let clients = DisposableCa::new("clients");
    let served = serve(
        rogue.issue_server(HOST).identity(),
        TransportPolicy::ServerTls,
        &clients,
    )
    .await;
    let invoker = Invoker::with_tls(
        rules(&[HOST]),
        &spec(bundle("servers", &servers), None, None, served.addr),
    )
    .allow_http_for_tests();
    let err = call(&invoker, format!("https://{HOST}:{}/ok", served.addr.port()))
        .await
        .expect_err("unknown root");
    assert!(matches!(err, InvokeError::Transport(_)), "{err}");
    assert_eq!(served.seen.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn mtls_presents_the_injected_identity_and_returns_a_redirect_as_data() {
    let servers = DisposableCa::new("servers");
    let clients = DisposableCa::new("clients");
    let leaf = clients.issue_client(PeerIdentitySelector::DnsName("agent.example".into()));
    let served = serve(
        servers.issue_server(HOST).identity(),
        TransportPolicy::MtlsRequired,
        &clients,
    )
    .await;
    let invoker = Invoker::with_tls(
        rules(&[HOST]),
        &spec(bundle("servers", &servers), Some(&leaf), None, served.addr),
    )
    .allow_http_for_tests();
    let port = served.addr.port();
    assert_eq!(call(&invoker, format!("https://{HOST}:{port}/ok")).await.unwrap(), 200);
    let status = call(&invoker, format!("https://{HOST}:{port}/redirect"))
        .await
        .expect("a 3xx is a response");
    assert_eq!(status, 302, "redirect returned, never followed");
    let peers = served.seen.peers.lock().unwrap().clone();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].0.as_deref(), Some(leaf.thumbprint.as_str()));
    assert_eq!(peers[0].1.as_deref(), Some(format!("Bearer {CANARY}").as_str()));
    assert_eq!(served.seen.hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_dns_policy_holds_when_dialed_by_address() {
    let servers = DisposableCa::new("servers");
    let clients = DisposableCa::new("clients");
    let served = serve(
        servers.issue_server(HOST).identity(),
        TransportPolicy::ServerTls,
        &clients,
    )
    .await;
    // Dialed as 127.0.0.1 but verified as connector.example: the fixed server
    // name is what rustls checks, and the pinned resolver answers for HOST
    // only, so a literal address is not something the client resolves.
    let mut tls = spec(bundle("servers", &servers), None, Some(HOST), served.addr);
    tls.pinned = None;
    let invoker = Invoker::with_tls(rules(&["127.0.0.1"]), &tls).allow_http_for_tests();
    let status = call(&invoker, format!("https://127.0.0.1:{}/ok", served.addr.port()))
        .await
        .expect("verified under the fixed name");
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_pinned_client_dials_nothing_but_its_authority() {
    let servers = DisposableCa::new("servers");
    let clients = DisposableCa::new("clients");
    let served = serve(
        servers.issue_server(HOST).identity(),
        TransportPolicy::ServerTls,
        &clients,
    )
    .await;
    // The allowlist names a second host and DNS would happily resolve
    // 127.0.0.1 for it, but the client is pinned to HOST.
    let invoker = Invoker::with_tls(
        rules(&[HOST, "localhost"]),
        &spec(bundle("servers", &servers), None, None, served.addr),
    )
    .allow_http_for_tests();
    let err = call(&invoker, format!("https://localhost:{}/ok", served.addr.port()))
        .await
        .expect_err("not the pinned authority");
    assert!(matches!(err, InvokeError::Transport(_)), "{err}");
    assert_eq!(served.seen.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn no_client_identity_is_refused_by_an_mtls_listener() {
    let servers = DisposableCa::new("servers");
    let clients = DisposableCa::new("clients");
    let served = serve(
        servers.issue_server(HOST).identity(),
        TransportPolicy::MtlsRequired,
        &clients,
    )
    .await;
    let invoker = Invoker::with_tls(
        rules(&[HOST]),
        &spec(bundle("servers", &servers), None, None, served.addr),
    )
    .allow_http_for_tests();
    let err = call(&invoker, format!("https://{HOST}:{}/ok", served.addr.port()))
        .await
        .expect_err("no certificate");
    assert!(matches!(err, InvokeError::Transport(_)), "{err}");
    assert_eq!(served.seen.hits.load(Ordering::SeqCst), 0);
}
