//! Shared fixtures for the real-TLS tests: a disposable PKI, an origin that
//! echoes what its handlers saw, and TLS clients built from the testkit.

#![allow(dead_code)]

pub mod caddy;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use axum::extract::{Request, State};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use chrono::Utc;
use http_body_util::{BodyExt as _, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    TlsVersion, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_ingress_evidence::{
    originating_peer_layer, BindingSetAdmission, IngressLimits, OriginatingPeerExtension,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf, LeafSpec, SanEntry};
use opensesame_transport_security::{
    client_config, dial_name, reqwest_builder, ClientProfile, DenyThumbprint, Generation,
    ListenerCounters, ListenerProvenance, PeerExtension, SecureListener, ServerNamePolicy,
    ServerProfile, TransportGenerations, TrustBundle,
};
use rustls_pki_types::pem::PemObject as _;
use rustls_pki_types::CertificateDer;
use serde::{Deserialize, Serialize};

pub const ORIGIN_NAME: &str = "origin.test";
pub const TRUSTED_LISTENER: &str = "host-tls";

pub struct Pki {
    pub ingress_ca: DisposableCa,
    pub origin_ca: DisposableCa,
    pub originating_root: DisposableCa,
    pub originating_int: DisposableCa,
    pub origin_server: IssuedLeaf,
    pub ingress: IssuedLeaf,
    /// Same private root as `ingress`, never bound (AT-INGRESS-WRONGPEER).
    pub stranger: IssuedLeaf,
    pub alice: IssuedLeaf,
    pub bob: IssuedLeaf,
}

impl Pki {
    pub fn new() -> Self {
        let ingress_ca = DisposableCa::new("ingress-ca");
        let origin_ca = DisposableCa::new("origin-ca");
        let originating_root = DisposableCa::new("originating-root");
        let originating_int = originating_root.intermediate("originating-int");
        let client = |name: &str| {
            LeafSpec::client(vec![
                SanEntry::Dns(format!("{name}.example.test")),
                SanEntry::Uri(format!("spiffe://example.test/{name}")),
            ])
        };
        Self {
            origin_server: origin_ca.issue_server(ORIGIN_NAME),
            ingress: ingress_ca
                .issue_client(PeerIdentitySelector::DnsName("ingress.example.test".into())),
            stranger: ingress_ca.issue_client(PeerIdentitySelector::DnsName(
                "stranger.example.test".into(),
            )),
            alice: originating_int.issue_with(&client("alice")),
            bob: originating_int.issue_with(&client("bob")),
            ingress_ca,
            origin_ca,
            originating_root,
            originating_int,
        }
    }

    pub fn ingress_profile() -> TrustProfileRef {
        TrustProfileRef::new("ingress-peers").expect("profile name")
    }

    pub fn originating_profile() -> TrustProfileRef {
        TrustProfileRef::new("originating-clients").expect("profile name")
    }

    pub fn ingress_trust(&self) -> TrustBundle {
        TrustBundle::from_pem(
            Self::ingress_profile(),
            TrustProfileKind::PrivateRoot,
            &self.ingress_ca.ca_pem(),
        )
        .expect("ingress trust")
    }

    /// Root only: the intermediate must arrive in `Client-Cert-Chain`.
    pub fn originating_trust(&self) -> TrustBundle {
        TrustBundle::from_pem(
            Self::originating_profile(),
            TrustProfileKind::PrivateRoot,
            &self.originating_root.ca_pem(),
        )
        .expect("originating trust")
    }

    pub fn bindings(&self) -> Arc<RwLock<ServiceBindingSet>> {
        let set = ServiceBindingSet {
            revision: 1,
            bindings: vec![ServiceBinding {
                id: "ingress-1".into(),
                revision: 1,
                enabled: true,
                revoked: false,
                scope: BindingScope::Deployment,
                trust_profile: Self::ingress_profile(),
                peer: PeerIdentitySelector::LeafThumbprintSha256(self.ingress.thumbprint.clone()),
                service_principal: "svc:reference-ingress".into(),
                purpose: BindingPurpose::TrustedIngress,
                allowed_operations: vec!["ingress.forward".into()],
                allowed_audiences: Vec::new(),
                not_after: None,
                denied_thumbprints: Vec::new(),
            }],
        };
        set.validate().expect("bindings valid");
        Arc::new(RwLock::new(set))
    }
}

pub fn leaf_der(leaf: &IssuedLeaf) -> Vec<u8> {
    CertificateDer::from_pem_slice(&leaf.leaf_pem)
        .expect("leaf pem")
        .to_vec()
}

pub fn byte_sequence(der: &[u8]) -> String {
    format!(
        ":{}:",
        base64::engine::general_purpose::STANDARD.encode(der)
    )
}

pub fn client_cert(leaf: &IssuedLeaf) -> String {
    byte_sequence(&leaf_der(leaf))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Seen {
    pub listener: String,
    pub policy: String,
    pub peer: Option<String>,
    pub originating: Option<String>,
    pub originating_source: Option<String>,
    pub originating_ingress: Option<String>,
    pub originating_selectors: Vec<String>,
    pub client_cert_header_present: bool,
}

#[derive(Clone)]
pub struct Handled(pub Arc<AtomicUsize>);

async fn whoami(State(handled): State<Handled>, req: Request) -> Json<Seen> {
    handled.0.fetch_add(1, Ordering::SeqCst);
    let provenance = req.extensions().get::<ListenerProvenance>();
    let originating = req
        .extensions()
        .get::<OriginatingPeerExtension>()
        .map(|o| &o.0);
    Json(Seen {
        listener: provenance
            .map(|p| p.listener_id().to_owned())
            .unwrap_or_default(),
        policy: provenance
            .map(|p| format!("{:?}", p.policy()))
            .unwrap_or_default(),
        peer: req
            .extensions()
            .get::<PeerExtension>()
            .map(|p| p.0.leaf_thumbprint_sha256().to_owned()),
        originating: originating.map(|o| o.leaf_thumbprint_sha256().to_owned()),
        originating_source: originating.map(|o| format!("{:?}", o.source())),
        originating_ingress: originating
            .and_then(|o| o.ingress().map(|i| i.leaf_thumbprint_sha256().to_owned())),
        originating_selectors: originating
            .map(|o| o.identities().iter().map(|s| format!("{s:?}")).collect())
            .unwrap_or_default(),
        client_cert_header_present: req.headers().contains_key("client-cert")
            || req.headers().contains_key("client-cert-chain"),
    })
}

/// The echo router with the originating-peer layer already applied.
pub fn router(pki: &Pki, handled: Handled) -> Router {
    router_with_trust(pki, handled, pki.originating_trust())
}

pub fn router_with_trust(pki: &Pki, handled: Handled, originating_trust: TrustBundle) -> Router {
    router_with(pki, handled, originating_trust, None)
}

/// The echo router, optionally with a revoked-leaf hook on the layer.
pub fn router_with(
    pki: &Pki,
    handled: Handled,
    originating_trust: TrustBundle,
    deny: Option<DenyThumbprint>,
) -> Router {
    let admission = Arc::new(BindingSetAdmission::new(pki.bindings()));
    let layer = originating_peer_layer(
        admission,
        Arc::new(originating_trust),
        IngressLimits::DEFAULT,
    );
    let layer = match deny {
        Some(deny) => layer.with_deny_thumbprint(deny),
        None => layer,
    };
    Router::new()
        .route("/whoami", get(whoami))
        .with_state(handled)
        .layer(layer)
}

pub struct Origin {
    pub addr: SocketAddr,
    pub counters: Arc<ListenerCounters>,
    pub handled: Handled,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Origin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts a `SecureListener` with `policy`, client trust = the ingress CA.
pub async fn spawn_origin(pki: &Pki, policy: TransportPolicy, listener_id: &str) -> Origin {
    spawn_origin_with(pki, policy, listener_id, pki.originating_trust()).await
}

pub async fn spawn_origin_with(
    pki: &Pki,
    policy: TransportPolicy,
    listener_id: &str,
    originating_trust: TrustBundle,
) -> Origin {
    spawn_origin_denying(pki, policy, listener_id, originating_trust, None).await
}

/// As [`spawn_origin_with`], with the layer's revoked-leaf hook set.
pub async fn spawn_origin_denying(
    pki: &Pki,
    policy: TransportPolicy,
    listener_id: &str,
    originating_trust: TrustBundle,
    deny: Option<DenyThumbprint>,
) -> Origin {
    let mut peer_trust = BTreeMap::new();
    peer_trust.insert(Pki::ingress_profile(), pki.ingress_trust());
    let generations = TransportGenerations::new(Generation {
        number: 1,
        identity: Some(Arc::new(pki.origin_server.identity())),
        peer_trust,
        activated_at: Utc::now(),
        withdrawn: None,
    });
    let listener_id = listener_id.to_owned();
    let listener = SecureListener::bind(
        "127.0.0.1:0".parse().expect("addr"),
        generations,
        move |generation| {
            let identity = generation.identity.clone().expect("identity");
            let mut profile = ServerProfile::new(policy, identity, &listener_id);
            profile.client_trust = Some(generation.trust(&Pki::ingress_profile())?.clone());
            Ok(profile)
        },
    )
    .await
    .expect("bind origin");
    let addr = listener.local_addr();
    let counters = listener.counters();
    let handled = Handled(Arc::new(AtomicUsize::new(0)));
    let app = router_with(pki, handled.clone(), originating_trust, deny);
    let task = tokio::spawn(async move {
        if let Err(error) = listener.serve(app).await {
            eprintln!("origin stopped: {error:?}");
        }
    });
    Origin {
        addr,
        counters,
        handled,
        task,
    }
}

/// Presents `identity` (if any) and trusts the origin CA.
fn client_profile(pki: &Pki, identity: Option<&IssuedLeaf>) -> ClientProfile {
    ClientProfile {
        server_trust: TrustBundle::from_pem(
            TrustProfileRef::new("origin").expect("profile"),
            TrustProfileKind::PrivateRoot,
            &pki.origin_ca.ca_pem(),
        )
        .expect("origin trust"),
        server_name: ServerNamePolicy::Dns(ORIGIN_NAME.into()),
        identity: identity.map(|leaf| Arc::new(leaf.identity())),
        min_version: TlsVersion::Tls13,
    }
}

/// A reqwest client that presents `identity` (if any) and trusts the origin CA.
pub fn client(pki: &Pki, identity: Option<&IssuedLeaf>, addr: SocketAddr) -> reqwest::Client {
    let base = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(1)
        .resolve(ORIGIN_NAME, addr);
    reqwest_builder(&client_profile(pki, identity), base)
        .expect("client profile")
        .build()
        .expect("client")
}

pub type OneConnection = hyper::client::conn::http1::SendRequest<Empty<Bytes>>;

/// Exactly one TLS connection to the origin, held open: every request sent
/// through the returned handle travels over it, one after another. Unlike a
/// pooled client, reuse does not depend on when the connection is handed
/// back, so a second handshake can only mean the origin dropped it.
pub async fn one_connection(
    pki: &Pki,
    identity: Option<&IssuedLeaf>,
    addr: SocketAddr,
) -> OneConnection {
    let profile = client_profile(pki, identity);
    let config = client_config(&profile).expect("client config");
    let name = dial_name(&profile.server_name, ORIGIN_NAME).expect("server name");
    let tcp = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .expect("tls handshake");
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .expect("http/1 handshake");
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("connection stopped: {error:?}");
        }
    });
    sender
}

/// Sends `GET path` with `headers` over `connection` and reads the echo.
pub async fn seen_over(
    connection: &mut OneConnection,
    path: &str,
    headers: &[(&str, &str)],
) -> Seen {
    connection
        .ready()
        .await
        .expect("the one connection is still open");
    let mut request = http::Request::get(path).header(http::header::HOST, ORIGIN_NAME);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = connection
        .send_request(request.body(Empty::new()).expect("request"))
        .await
        .expect("response");
    assert_eq!(response.status(), 200, "handler answered");
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    serde_json::from_slice(&body).expect("seen json")
}

pub fn url(addr: SocketAddr, path: &str) -> String {
    format!("https://{ORIGIN_NAME}:{}{path}", addr.port())
}
