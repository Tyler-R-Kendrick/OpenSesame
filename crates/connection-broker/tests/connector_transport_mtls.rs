//! AT-CONNECTOR-POOLS / AT-TLS-TENANT / AT-ROTATE-VALID / AT-TLS-SERVERNAME /
//! AT-CONNECTOR-EGRESS on the real wire.
//!
//! One `mtls_required` listener from `opensesame-transport-security`'s testkit
//! records, per request, which client certificate authenticated the connection
//! and which bearer arrived on it. Two tenants with two different client
//! identities then interleave requests at that one upstream, and the recording
//! is the proof: each request is seen with **its own** certificate and **its
//! own** token, never the other tenant's — which is exactly what a shared
//! pooled client would break, because a client certificate authenticates the
//! connection, not the request object.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use opensesame_connection_broker::transport::execute::{
    ConnectionCredential, ConnectorContext, ConnectorInvocation, ConnectorTransportExecutor,
};
use opensesame_connection_broker::transport::memory::MemoryTransportResolver;
use opensesame_connection_broker::transport::pool::ConnectorClientPool;
use opensesame_connection_broker::transport::{
    ConnectionTransport, ConnectorExecutionTarget, ConnectorResolvers, ServerNameSelector,
};
use opensesame_domain::transport::{
    IdentitySourceRef, PeerIdentitySelector, TransportError, TransportPolicy, TrustProfileKind,
    TrustProfileRef,
};
use opensesame_invoke_through::{AuthStyle, EgressRule};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    Generation, GenerationCandidate, PeerExtension, SecureListener, ServerProfile,
    TransportGenerations, TrustBundle,
};
use secrecy::SecretString;

const HOST: &str = "connector.example";

/// Every tenant's bearer is distinct, so a token arriving on the wrong
/// certificate is visible rather than merely suspected.
struct TenantCredential(&'static str);

#[async_trait]
impl ConnectionCredential for TenantCredential {
    async fn open_bearer(&self, _ctx: &ConnectorContext) -> Result<SecretString, TransportError> {
        Ok(SecretString::from(self.0.to_owned()))
    }
}

#[derive(Clone, Default)]
struct Seen {
    hits: Arc<AtomicU64>,
    /// `(client leaf thumbprint, authorization header)` in arrival order.
    pairs: Arc<Mutex<Vec<(Option<String>, Option<String>)>>>,
}

async fn record(State(seen): State<Seen>, req: Request) -> Response {
    seen.hits.fetch_add(1, Ordering::SeqCst);
    let peer = req
        .extensions()
        .get::<PeerExtension>()
        .map(|peer| peer.0.leaf_thumbprint_sha256().to_owned());
    let auth = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    seen.pairs.lock().unwrap().push((peer, auth));
    "ok".into_response()
}

struct Upstream {
    port: u16,
    seen: Seen,
    _task: tokio::task::JoinHandle<Result<(), TransportError>>,
}

async fn serve_mtls(ca: &DisposableCa) -> Upstream {
    let clients = TrustProfileRef::new("clients").unwrap();
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(ca.issue_server(HOST).identity())),
        peer_trust: [(
            clients.clone(),
            TrustBundle::from_pem(clients.clone(), TrustProfileKind::PrivateRoot, &ca.root_pem())
                .unwrap(),
        )]
        .into(),
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
        let mut profile =
            ServerProfile::new(TransportPolicy::MtlsRequired, identity, "upstream-tls");
        profile.client_trust = Some(generation.trust(&clients)?.clone());
        Ok(profile)
    };
    let listener = SecureListener::bind("127.0.0.1:0".parse().unwrap(), generations, profile)
        .await
        .expect("bind");
    let port = listener.local_addr().port();
    let seen = Seen::default();
    let app = Router::new()
        .route("/v1/ping", get(record))
        .with_state(seen.clone());
    let task = tokio::spawn(listener.serve(app));
    Upstream {
        port,
        seen,
        _task: task,
    }
}

fn rules(port: u16) -> Vec<EgressRule> {
    // The fence is exact-host; the test listener is on 127.0.0.1 and the
    // certificate names `connector.example`, so the executor's loopback test
    // mode is what lets a real handshake happen at all. The rule itself is as
    // strict as production.
    let _ = port;
    vec![EgressRule {
        provider_id: "acme",
        scheme: "https",
        hosts: &[HOST, "127.0.0.1"],
        auth: AuthStyle::Bearer,
    }]
}

fn record_for(identity: &str) -> ConnectionTransport {
    ConnectionTransport {
        policy: TransportPolicy::MtlsRequired,
        identity: Some(IdentitySourceRef::new(identity).unwrap()),
        trust: Some(TrustProfileRef::new("upstream-root").unwrap()),
        server_name: Some(ServerNameSelector::Dns(HOST.into())),
        execution_target: ConnectorExecutionTarget::Host,
    }
}

fn ctx(org: &str) -> ConnectorContext {
    ConnectorContext {
        organization_id: org.into(),
        connection_id: format!("conn-{org}"),
        provider_id: "acme".into(),
    }
}

fn ping(port: u16) -> ConnectorInvocation {
    ConnectorInvocation {
        method: "GET".into(),
        // 127.0.0.1 is dialed; `connector.example` is what the certificate
        // must prove (the DNS server-name policy holds whatever is dialed).
        url: format!("https://127.0.0.1:{port}/v1/ping"),
        headers: vec![("accept".into(), "application/json".into())],
        body: None,
    }
}

struct Fixture {
    executor: ConnectorTransportExecutor,
    resolver: Arc<MemoryTransportResolver>,
    upstream: Upstream,
    a_thumbprint: String,
    b_thumbprint: String,
}

async fn fixture() -> Fixture {
    let ca = DisposableCa::new("upstream");
    let upstream = serve_mtls(&ca).await;
    let resolver = Arc::new(MemoryTransportResolver::new());
    let trust = Arc::new(
        TrustBundle::from_pem(
            TrustProfileRef::new("upstream-root").unwrap(),
            TrustProfileKind::PrivateRoot,
            &ca.root_pem(),
        )
        .unwrap(),
    );
    let mut thumbprints = Vec::new();
    for (org, name, dns) in [
        ("org-a", "acme-client", "a.clients.example"),
        ("org-b", "beta-client", "b.clients.example"),
    ] {
        let leaf = ca.issue_client(PeerIdentitySelector::DnsName(dns.into()));
        let identity = Arc::new(leaf.identity());
        thumbprints.push(identity.leaf_thumbprint_sha256());
        resolver.register_identity(org, name, identity);
        resolver.register_trust(org, "upstream-root", Arc::clone(&trust));
    }
    let executor = ConnectorTransportExecutor::new(
        ConnectorResolvers {
            identities: Arc::clone(&resolver) as Arc<_>,
            trust: Arc::clone(&resolver) as Arc<_>,
        },
        Arc::new(ConnectorClientPool::with_capacity(16)),
        rules(upstream.port),
    )
    .allow_loopback_for_tests();
    Fixture {
        executor,
        resolver,
        a_thumbprint: thumbprints[0].clone(),
        b_thumbprint: thumbprints[1].clone(),
        upstream,
    }
}

#[tokio::test]
async fn interleaved_tenants_are_each_seen_with_their_own_certificate_and_token() {
    let f = fixture().await;
    let port = f.upstream.port;
    let a = TenantCredential("token-for-org-a");
    let b = TenantCredential("token-for-org-b");

    // A, B, A, B — interleaved on purpose, so a pool keyed less strictly than
    // ADR 0130 requires would hand the second tenant the first one's already
    // authenticated connection.
    for (ctx, transport, credential) in [
        (ctx("org-a"), record_for("acme-client"), &a),
        (ctx("org-b"), record_for("beta-client"), &b),
        (ctx("org-a"), record_for("acme-client"), &a),
        (ctx("org-b"), record_for("beta-client"), &b),
    ] {
        let response = f
            .executor
            .invoke(&ctx, &transport, credential, ping(port))
            .await
            .expect("the upstream accepts each tenant's own identity");
        assert_eq!(response.status, 200);
    }

    let pairs = f.upstream.seen.pairs.lock().unwrap().clone();
    assert_eq!(pairs.len(), 4);
    let expected = [
        (&f.a_thumbprint, "Bearer token-for-org-a"),
        (&f.b_thumbprint, "Bearer token-for-org-b"),
        (&f.a_thumbprint, "Bearer token-for-org-a"),
        (&f.b_thumbprint, "Bearer token-for-org-b"),
    ];
    for (index, ((peer, auth), (thumbprint, bearer))) in
        pairs.iter().zip(expected.iter()).enumerate()
    {
        assert_eq!(
            peer.as_deref(),
            Some(thumbprint.as_str()),
            "request {index}: the upstream saw the wrong client certificate"
        );
        assert_eq!(
            auth.as_deref(),
            Some(*bearer),
            "request {index}: the upstream saw the wrong tenant's token"
        );
    }
    // Two tenants, two live scopes — never one shared client.
    assert_eq!(f.executor.pool().len(), 2);
}

#[tokio::test]
async fn one_tenants_reference_is_unusable_from_another_tenants_connection() {
    // AT-TLS-TENANT: tenant A naming tenant B's identity reference resolves to
    // nothing. No key is used, no connection is made, nothing is pooled.
    let f = fixture().await;
    let before = f.upstream.seen.hits.load(Ordering::SeqCst);
    let error = f
        .executor
        .invoke(
            &ctx("org-a"),
            &record_for("beta-client"),
            &TenantCredential("token-for-org-a"),
            ping(f.upstream.port),
        )
        .await
        .expect_err("another tenant's identity reference does not exist here");
    assert_eq!(error.code(), "identity_missing");
    assert_eq!(f.upstream.seen.hits.load(Ordering::SeqCst), before);
    assert!(f.executor.pool().is_empty());
}

#[tokio::test]
async fn a_revoked_identity_stops_being_presented_and_its_pool_is_dropped() {
    // AT-ROTATE-VALID / the revocation boundary: revoking the identity stops
    // *new* handshakes. The pooled client for the old thumbprint is forgotten
    // explicitly, which is the enforced bound — not a promise that an
    // in-flight request is torn down.
    let f = fixture().await;
    let port = f.upstream.port;
    let credential = TenantCredential("token-for-org-a");
    f.executor
        .invoke(
            &ctx("org-a"),
            &record_for("acme-client"),
            &credential,
            ping(port),
        )
        .await
        .expect("first call");
    assert_eq!(f.executor.pool().len(), 1);

    f.resolver.revoke_identity("acme-client");
    f.executor.pool().forget_connection("org-a", "conn-org-a");
    assert!(f.executor.pool().is_empty());

    let error = f
        .executor
        .invoke(
            &ctx("org-a"),
            &record_for("acme-client"),
            &credential,
            ping(port),
        )
        .await
        .expect_err("a revoked identity is not presented again");
    assert_eq!(error.code(), "evidence_revoked");
    assert!(f.executor.pool().is_empty());
}

#[tokio::test]
async fn a_foreign_root_never_reaches_the_upstream() {
    // AT-TLS-SERVERNAME: the trust profile is the whole of the client's trust.
    // A bundle from a different CA fails the handshake, so the bearer is never
    // written to the socket.
    let f = fixture().await;
    let stranger = DisposableCa::new("stranger");
    f.resolver.register_trust(
        "org-a",
        "stranger-root",
        Arc::new(
            TrustBundle::from_pem(
                TrustProfileRef::new("stranger-root").unwrap(),
                TrustProfileKind::PrivateRoot,
                &stranger.root_pem(),
            )
            .unwrap(),
        ),
    );
    let wrong_trust = ConnectionTransport {
        trust: Some(TrustProfileRef::new("stranger-root").unwrap()),
        ..record_for("acme-client")
    };
    let before = f.upstream.seen.hits.load(Ordering::SeqCst);
    let error = f
        .executor
        .invoke(
            &ctx("org-a"),
            &wrong_trust,
            &TenantCredential("token-for-org-a"),
            ping(f.upstream.port),
        )
        .await
        .expect_err("an unknown root is not a server this connection may talk to");
    assert!(format!("{error}").to_lowercase().contains("transport"));
    assert_eq!(f.upstream.seen.hits.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn the_wrong_server_name_is_refused_before_a_request_byte() {
    // Right root, wrong expected identity: the handshake fails and nothing
    // reaches a handler.
    let f = fixture().await;
    let wrong_name = ConnectionTransport {
        server_name: Some(ServerNameSelector::Dns("other.example".into())),
        ..record_for("acme-client")
    };
    let before = f.upstream.seen.hits.load(Ordering::SeqCst);
    assert!(f
        .executor
        .invoke(
            &ctx("org-a"),
            &wrong_name,
            &TenantCredential("token-for-org-a"),
            ping(f.upstream.port),
        )
        .await
        .is_err());
    assert_eq!(f.upstream.seen.hits.load(Ordering::SeqCst), before);
}
