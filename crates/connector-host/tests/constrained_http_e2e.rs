//! L2 constrained HTTP end to end (ADR 0150 §6.7): the host admits a
//! placeholder through its ledger and the invoke-through broker sends the
//! request to a real TLS upstream standing in for `api.github.com`.
//!
//! What the upstream sees is the proof. The credential arrives exactly once,
//! in the one header the provider's rule names; the placeholder never
//! arrives at all, because its header is stripped rather than rewritten; and
//! an upstream that echoes what it was sent hands nothing back, because the
//! broker scrubs the response before the summary is built.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Request, State};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use opensesame_connector_host::{
    opensesame_param_digest, HostError, HostRuntime, InvokeRequest, RefusalCode, SurrogateSite,
    SurrogateSpec,
};
use opensesame_domain::transport::{
    TlsVersion, TransportError, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_invoke_through::{Invoker, TlsClientSpec, EGRESS_RULES};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, Generation, GenerationCandidate, SecureListener,
    ServerNamePolicy, ServerProfile, TransportGenerations, TrustBundle,
};
use secrecy::SecretString;
use serde_json::{json, Value};

const HOST: &str = "api.github.com";
const CALLER: &str = "demo-conn";
const CONNECTION: &str = "conn://acme/github";
const MATERIAL: &str = "CANARY-e2e-material-9f2c41";

/// One request as the upstream received it.
#[derive(Clone, Debug)]
struct Hit {
    authorization: Vec<String>,
    /// The target, every header name and value, and the body, run together:
    /// anything the client sent is somewhere in here.
    everything: String,
}

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Hit>>>);

impl Seen {
    fn hits(&self) -> Vec<Hit> {
        self.0.lock().expect("lock").clone()
    }
}

/// Records the request, then echoes its `Authorization` back in the body and
/// in `etag` (an allowlisted response header): the reflection a debug route
/// or an error quoting the rejected token would produce.
async fn reflect(State(seen): State<Seen>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let body = axum::body::to_bytes(body, 1 << 20)
        .await
        .unwrap_or_default();
    let authorization: Vec<String> = parts
        .headers
        .get_all("authorization")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_owned)
        .collect();
    let mut everything = parts.uri.to_string();
    for (name, value) in &parts.headers {
        everything.push_str(name.as_str());
        everything.push_str(value.to_str().unwrap_or_default());
    }
    everything.push_str(&String::from_utf8_lossy(&body));
    seen.0.lock().expect("lock").push(Hit {
        authorization: authorization.clone(),
        everything,
    });
    let echoed = authorization.join(",");
    Response::builder()
        .status(200)
        .header("content-type", "text/plain")
        .header("etag", echoed.as_str())
        .body(format!("you sent: {echoed}").into())
        .expect("response")
}

struct Upstream {
    addr: SocketAddr,
    seen: Seen,
    ca: DisposableCa,
    _task: tokio::task::JoinHandle<Result<(), TransportError>>,
}

/// A TLS listener holding a certificate for `api.github.com`, issued by a
/// disposable CA only the test's invoker trusts.
async fn upstream() -> Upstream {
    let ca = DisposableCa::new("upstream");
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(ca.issue_server(HOST).identity())),
        peer_trust: std::collections::BTreeMap::new(),
        own_trust: None,
        identity_required: true,
    };
    let generations = TransportGenerations::new(
        candidate
            .into_generation(1, chrono::Utc::now())
            .expect("generation"),
    );
    let profile = |generation: &Generation| {
        let identity = generation
            .identity
            .clone()
            .ok_or(TransportError::IdentityMissing)?;
        Ok(ServerProfile::new(
            TransportPolicy::ServerTls,
            identity,
            "l2-upstream",
        ))
    };
    let listener = SecureListener::bind("127.0.0.1:0".parse().unwrap(), generations, profile)
        .await
        .expect("bind");
    let addr = listener.local_addr();
    let seen = Seen::default();
    let app = Router::new()
        .fallback(any(reflect))
        .with_state(seen.clone());
    Upstream {
        addr,
        seen,
        ca,
        _task: tokio::spawn(listener.serve(app)),
    }
}

/// The production rule set and fence, with the one host it names pinned to
/// the listener. The URL stays `https://api.github.com/…` on the default
/// port: nothing about the fence is relaxed for the test.
fn invoker(upstream: &Upstream) -> Invoker {
    let trust = TrustBundle::from_pem(
        TrustProfileRef::new("upstream").unwrap(),
        TrustProfileKind::PrivateRoot,
        &upstream.ca.root_pem(),
    )
    .unwrap();
    let profile = ClientProfile {
        server_trust: trust,
        server_name: ServerNamePolicy::Dns(HOST.into()),
        identity: None,
        min_version: TlsVersion::Tls13,
    };
    let spec = TlsClientSpec {
        config: Arc::new(client_config(&profile).expect("client config")),
        server_name: None,
        pinned: Some((HOST.into(), vec![upstream.addr])),
    };
    Invoker::with_tls(EGRESS_RULES.to_vec(), &spec)
}

fn host() -> (HostRuntime, String) {
    let mut host = HostRuntime::default();
    let surrogate = host
        .register_connection(
            SurrogateSpec {
                provider_id: "github".into(),
                connection_ref: CONNECTION.into(),
                run_id: "run-e2e".into(),
                caller: CALLER.into(),
                site: SurrogateSite::Authorization,
                methods: vec!["GET".into(), "POST".into()],
                path_prefixes: vec!["/".into()],
                expires_at_unix: u64::MAX,
            },
            SecretString::from(MATERIAL),
        )
        .expect("registered");
    (host, surrogate.as_str().to_string())
}

fn request(params: Value) -> InvokeRequest {
    InvokeRequest {
        operation: "http.authorized".into(),
        resource: "repo:acme/x".into(),
        audience: "https://api.github.com".into(),
        parameters_digest: opensesame_param_digest(&params),
        parameters: params,
        authorized_operation: "http.authorized".into(),
        invoke_level: Some(2),
        connection_ref: String::new(),
    }
}

fn repo_read(placeholder: &str) -> Value {
    json!({
        "url": "https://api.github.com/repos/acme/x",
        "connection_ref": CONNECTION,
        "headers": [
            ["accept", "application/vnd.github+json"],
            ["authorization", format!("Bearer {placeholder}")],
        ],
    })
}

#[tokio::test]
async fn the_upstream_sees_the_credential_once_and_never_the_placeholder() {
    let upstream = upstream().await;
    let (host, ph) = host();
    let result = host
        .invoke_constrained_http(CALLER, &request(repo_read(&ph)), &invoker(&upstream))
        .await
        .expect("sent");
    assert!(result.ok, "{:?}", result.safe_summary);
    let hits = upstream.seen.hits();
    assert_eq!(hits.len(), 1, "exactly one request left the host");
    assert_eq!(hits[0].authorization, vec![format!("Bearer {MATERIAL}")]);
    assert!(
        !hits[0].everything.contains(&ph),
        "the placeholder is stripped, never forwarded or rewritten"
    );
    assert!(result
        .external_request_digest
        .is_some_and(|digest| digest.starts_with("sha256:")));
}

#[tokio::test]
async fn a_reflected_credential_never_reaches_the_safe_summary() {
    let upstream = upstream().await;
    let (host, ph) = host();
    let result = host
        .invoke_constrained_http(CALLER, &request(repo_read(&ph)), &invoker(&upstream))
        .await
        .expect("sent");
    let summary = result.safe_summary.to_string();
    assert!(!summary.contains(MATERIAL), "{summary}");
    assert!(!summary.contains(&ph), "{summary}");
    assert_eq!(result.safe_summary["receipt"]["credential_reflected"], true);
    let body = result.safe_summary["body"].as_str().expect("body");
    assert!(body.contains("[redacted:credential]"), "{body}");
}

#[tokio::test]
async fn a_refused_request_never_reaches_the_upstream() {
    // The gist oracle again, against a live upstream: a valid header beside
    // the placeholder in the body. Refused at admission, so not one byte —
    // and not the credential — leaves the host.
    let upstream = upstream().await;
    let (host, ph) = host();
    let gist = json!({
        "url": "https://api.github.com/gists",
        "method": "POST",
        "connection_ref": CONNECTION,
        "headers": [["authorization", format!("Bearer {ph}")]],
        "body": format!("{{\"files\":{{\"a\":{{\"content\":\"{ph}\"}}}}}}"),
    });
    let err = host
        .invoke_constrained_http(CALLER, &request(gist), &invoker(&upstream))
        .await
        .unwrap_err();
    assert_eq!(err, HostError::SurrogateRefused(RefusalCode::Misplaced));
    assert!(upstream.seen.hits().is_empty());
}
