//! IOP-INGRESS — the one thing the reference-proxy suite could not observe.
//!
//! SW-INGRESS already ran the pinned Caddy 2.11.4 against the origin and
//! proved, at the origin's own handlers: forged fields on both listener
//! policies, an unauthorized ingress certificate, a direct request that
//! bypasses the proxy, and that a pooled upstream connection performs exactly
//! one handshake (`crates/ingress-evidence/tests/reference_proxy.rs`,
//! `tests/layer.rs`). Those are cited, not repeated.
//!
//! Its two-originating-client test, though, drives the origin *directly* with
//! hand-written fields; and its Caddy test uses one client. So the case the
//! directive names — **two different originating clients multiplexed over one
//! pooled ingress connection** — has never been through a real proxy. That is
//! what this file does, and every assertion is made from what the origin's
//! handler saw, not from the proxy's log.
//!
//! The Caddyfile is the shipped `ops/ingress/Caddyfile`, adapted with
//! environment values, so a drift in the reference configuration fails here
//! too. Certificates come from the system `openssl`, not from the `rcgen`
//! testkit the verifier was developed against.

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{bail, Result};
use axum::extract::State;
use axum::http::Extensions;
use axum::routing::get;
use axum::Router;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_ingress_evidence::{
    originating_peer_layer, BindingSetAdmission, IngressLimits, OriginatingPeerExtension,
};
use opensesame_mtls_interop::pki::{Leaf, LeafSpec, Pki};
use opensesame_mtls_interop::proc::{free_port, run_bounded, Child};
use opensesame_mtls_interop::{
    fixture_binary, fixture_version, fixtures_enabled, record, repo_root,
};
use opensesame_transport_security::{
    Generation, PeerExtension, SecureListener, ServerProfile, TlsIdentity, TransportGenerations,
    TrustBundle,
};

const INGRESS_NAME: &str = "ingress.test";
const ORIGIN_NAME: &str = "origin.test";
const PROFILE: &str = "iop-ingress-profile";

/// What the origin's handler actually saw, per request, in order.
type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;

async fn whoami(State(seen): State<Seen>, extensions: Extensions) -> String {
    let connection = extensions
        .get::<PeerExtension>()
        .map(|PeerExtension(peer)| peer.leaf_thumbprint_sha256().to_string())
        .unwrap_or_default();
    let originating = extensions
        .get::<OriginatingPeerExtension>()
        .map(|OriginatingPeerExtension(peer)| peer.leaf_thumbprint_sha256().to_string());
    seen.lock()
        .expect("seen")
        .push((connection.clone(), originating.clone()));
    format!("{connection}|{}", originating.unwrap_or_default())
}

fn profile_ref() -> TrustProfileRef {
    TrustProfileRef {
        name: PROFILE.to_string(),
    }
}

fn ingress_binding(dns: &str) -> ServiceBinding {
    ServiceBinding {
        id: "ingress".to_string(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: profile_ref(),
        peer: PeerIdentitySelector::DnsName(dns.to_string()),
        service_principal: "svc:ingress".to_string(),
        purpose: BindingPurpose::TrustedIngress,
        allowed_operations: vec![
            opensesame_domain::transport::operations::INGRESS_FORWARD.to_string()
        ],
        allowed_audiences: vec!["host".to_string()],
        not_after: None,
        denied_thumbprints: Vec::new(),
    }
}

fn secret(bytes: Vec<u8>) -> opensesame_transport_security::SecretBytes {
    secrecy::SecretBox::new(Box::new(bytes))
}

/// The trusted-ingress origin: the shipped `originating_peer_layer` over the
/// shipped `SecureListener`, serving `/whoami`.
///
/// Extracted so the test body stays inside the complexity budget; nothing
/// about it is test-specific beyond the three roots it is handed.
struct Origin {
    port: u16,
    seen: Seen,
    counters: Arc<opensesame_transport_security::ListenerCounters>,
    stop: tokio::sync::oneshot::Sender<()>,
    serving: tokio::task::JoinHandle<()>,
}

async fn start_origin(
    origin_server: &Leaf,
    origin_root: &std::path::Path,
    client_root: &std::path::Path,
) -> Result<Origin> {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let bindings = Arc::new(RwLock::new(ServiceBindingSet {
        revision: 1,
        bindings: vec![ingress_binding("ingress.clients.test")],
    }));
    let originating_trust = Arc::new(TrustBundle::from_pem(
        TrustProfileRef {
            name: "iop-originating".to_string(),
        },
        TrustProfileKind::PrivateRoot,
        &std::fs::read(client_root)?,
    )?);
    let app: Router = Router::new()
        .route("/whoami", get(whoami))
        .with_state(Arc::clone(&seen))
        .layer(originating_peer_layer(
            Arc::new(BindingSetAdmission::new(bindings)),
            originating_trust,
            IngressLimits::default(),
        ));
    let identity = Arc::new(TlsIdentity::from_pem(
        &std::fs::read(&origin_server.chain)?,
        &secret(std::fs::read(&origin_server.key)?),
    )?);
    let mut peer_trust = BTreeMap::new();
    peer_trust.insert(
        profile_ref(),
        TrustBundle::from_pem(
            profile_ref(),
            TrustProfileKind::PrivateRoot,
            &std::fs::read(origin_root)?,
        )?,
    );
    let generations = TransportGenerations::new(Generation {
        number: 1,
        identity: Some(identity),
        peer_trust,
        activated_at: chrono::Utc::now(),
        withdrawn: None,
    });
    let listener = SecureListener::bind(
        "127.0.0.1:0".parse()?,
        Arc::clone(&generations),
        move |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(opensesame_domain::transport::TransportError::IdentityMissing)?;
            let mut profile =
                ServerProfile::new(TransportPolicy::TrustedIngress, identity, "iop-origin");
            profile.client_trust = Some(generation.trust(&profile_ref())?.clone());
            Ok(profile)
        },
    )
    .await?;
    let port = listener.local_addr().port();
    let counters = listener.counters();
    let (stop, rx) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(async move {
        let _ = listener
            .serve_until(app, async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(Origin {
        port,
        seen,
        counters,
        stop,
        serving,
    })
}

/// Start the **shipped** `ops/ingress/Caddyfile` against this origin.
///
/// Using the reference configuration verbatim means a drift in it fails this
/// test too, which is the point of running the maintained ingress rather than
/// a hand-written one.
fn start_edge(
    caddy: &std::path::Path,
    dir: &std::path::Path,
    edge_server: &Leaf,
    ingress_client: &Leaf,
    trust: (&std::path::Path, &std::path::Path),
    origin_port: u16,
) -> Result<(Child, u16)> {
    let (originating_trust, origin_trust) = trust;
    let ingress_port = free_port()?;
    let health_port = free_port()?;
    let caddyfile = repo_root().join("ops/ingress/Caddyfile");
    let mut edge = Child::spawn(
        "caddy",
        std::process::Command::new(caddy)
            .arg("run")
            .arg("--config")
            .arg(&caddyfile)
            .arg("--adapter")
            .arg("caddyfile")
            .current_dir(dir)
            .env("OPENSESAME_INGRESS_BIND", "127.0.0.1")
            .env("OPENSESAME_INGRESS_PORT", ingress_port.to_string())
            .env("OPENSESAME_INGRESS_HEALTH_PORT", health_port.to_string())
            .env("OPENSESAME_INGRESS_CERT", &edge_server.chain)
            .env("OPENSESAME_INGRESS_KEY", &edge_server.key)
            .env("OPENSESAME_ORIGINATING_TRUST", originating_trust)
            .env("OPENSESAME_ORIGIN_ADDR", format!("127.0.0.1:{origin_port}"))
            .env("OPENSESAME_ORIGIN_TRUST", origin_trust)
            .env("OPENSESAME_ORIGIN_NAME", ORIGIN_NAME)
            .env("OPENSESAME_INGRESS_CLIENT_CERT", &ingress_client.chain)
            .env("OPENSESAME_INGRESS_CLIENT_KEY", &ingress_client.key),
        &dir.join("caddy.log"),
    )?;
    edge.wait_for_port(ingress_port, Duration::from_secs(60))?;
    Ok((edge, ingress_port))
}

/// Two originating clients, one real Caddy, one pooled connection to the
/// origin — and the origin's handler tells them apart.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real Caddy; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn two_originating_clients_on_one_pooled_ingress_connection_stay_distinct() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let caddy = fixture_binary("caddy")?;
    let caddy_version = fixture_version("caddy")?;
    let pki = Pki::new()?;
    // Three independent roots: the edge's server identity, the originating
    // clients' issuer, and the origin's own.
    let edge_root = pki.root("iop-edge-root")?;
    let client_root = pki.root("iop-originating-root")?;
    let origin_root = pki.root("iop-origin-root")?;

    let edge_server = edge_root.issue(&LeafSpec::server("edge", INGRESS_NAME))?;
    let origin_server = origin_root.issue(&LeafSpec::server("origin", ORIGIN_NAME))?;
    // The proxy's own identity toward the origin, under the origin's root so
    // the origin can verify it, bound by name.
    let ingress_client =
        origin_root.issue(&LeafSpec::client_dns("ingress", "ingress.clients.test"))?;
    let alice = client_root.issue(&LeafSpec::client_dns("alice", "alice.people.test"))?;
    let bob = client_root.issue(&LeafSpec::client_dns("bob", "bob.people.test"))?;

    let origin = start_origin(&origin_server, &origin_root.cert, &client_root.cert).await?;
    let origin_port = origin.port;
    let counters = Arc::clone(&origin.counters);
    let seen = Arc::clone(&origin.seen);

    let (edge, ingress_port) = start_edge(
        &caddy,
        pki.dir(),
        &edge_server,
        &ingress_client,
        (&client_root.cert, &origin_root.cert),
        origin_port,
    )?;

    // ---- two originating clients through the one edge -------------------
    let through_edge = |who: &Leaf| -> Result<String> {
        let (code, stdout, stderr) = run_bounded(
            std::process::Command::new("/usr/bin/curl").args([
                "-sS",
                "--noproxy",
                "*",
                "--max-time",
                "20",
                "--resolve",
                &format!("{INGRESS_NAME}:{ingress_port}:127.0.0.1"),
                "--cacert",
                &edge_root.cert.to_string_lossy(),
                "--cert",
                &who.chain.to_string_lossy(),
                "--key",
                &who.key.to_string_lossy(),
                &format!("https://{INGRESS_NAME}:{ingress_port}/whoami"),
            ]),
            Duration::from_secs(30),
        )?;
        if code != Some(0) {
            bail!(
                "curl through the edge failed ({code:?}): {stderr}\n{}",
                edge.log()
            );
        }
        Ok(stdout)
    };

    let first = through_edge(&alice)?;
    let second = through_edge(&bob)?;

    let observed = seen.lock().expect("seen").clone();
    if observed.len() != 2 {
        bail!(
            "the origin handled {} requests, expected 2: {observed:?}\n{}",
            observed.len(),
            edge.log()
        );
    }
    // Both requests arrived on the same authenticated ingress connection.
    assert_eq!(
        observed[0].0, ingress_client.thumbprint,
        "hop 2 is the proxy's own identity, not the client's"
    );
    assert_eq!(observed[1].0, ingress_client.thumbprint);
    // ...and the origin still told the two originating clients apart.
    assert_eq!(
        observed[0].1.as_deref(),
        Some(alice.thumbprint.as_str()),
        "first request should carry Alice: {first}"
    );
    assert_eq!(
        observed[1].1.as_deref(),
        Some(bob.thumbprint.as_str()),
        "second request should carry Bob: {second}"
    );
    assert_ne!(alice.thumbprint, bob.thumbprint);
    // One TLS handshake on hop 2: the identities above are request-local
    // facts on a *shared* connection, which is the whole hazard.
    assert_eq!(
        counters.handshakes_ok(),
        1,
        "both requests must have been multiplexed over one pooled ingress connection"
    );

    record(
        "IOP-INGRESS-POOLED-TWO-CLIENTS",
        &format!("caddy {caddy_version} -> rustls TrustedIngress origin"),
        "two originating clients, one pooled ingress connection, each request attributed correctly at the origin handler",
    );

    let _ = origin.stop.send(());
    let _ = origin.serving.await;
    Ok(())
}
