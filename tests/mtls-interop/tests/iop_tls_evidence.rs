//! IOP-TLS, the evidence half: a listener can *accept* a peer without that
//! peer being authorized, and an accepted TLS session is not peer evidence at
//! all on a `server_tls` listener.
//!
//! This is AT-EVIDENCE-POSITIVE from the outside. The same oracle that walked
//! the `MtlsRequired` matrix in `iop_tls_rust_listener.rs` walks a
//! `server_tls` listener here, and the difference between "the handshake
//! completed" and "the peer is admitted" is the entire result.
//!
//! It also pins the one number both stacks must agree on: the leaf
//! thumbprint. OpenSSL computes it from the DER with its own hasher; the
//! production loader computes it from the DER it parsed. A disagreement there
//! would make every binding in the system unverifiable from outside.

mod support;

use std::path::Path;

use anyhow::Result;
use opensesame_domain::transport::{PeerIdentitySelector, ServiceBindingSet, TransportPolicy};
use opensesame_mtls_interop::oracle::{get, s_client, Outcome, SClient};
use opensesame_mtls_interop::pki::{Leaf, LeafSpec, Pki};
use opensesame_mtls_interop::{fixtures_enabled, record};

const SERVER_DNS: &str = "host.iop.test";
const BOUND_ID: &str = "spiffe://iop.test/opensesame/bridge";

struct World {
    _pki: Pki,
    root: opensesame_mtls_interop::pki::Ca,
    server: Leaf,
    bound: Leaf,
}

fn world() -> Result<World> {
    let pki = Pki::new()?;
    let root = pki.root("iop-evidence-root")?;
    let issuer = root.intermediate("iop-evidence-issuer")?;
    Ok(World {
        server: issuer.issue(&LeafSpec::server("server", SERVER_DNS))?,
        bound: issuer.issue(&LeafSpec::dual_uri("bridge", BOUND_ID))?,
        root,
        _pki: pki,
    })
}

fn bindings() -> ServiceBindingSet {
    ServiceBindingSet {
        revision: 1,
        bindings: vec![support::binding("bridge", support::uri(BOUND_ID))],
    }
}

async fn dial(port: u16, ca: &Path, leaf: Option<&Leaf>) -> Result<Outcome> {
    let ca = ca.to_path_buf();
    let chain = leaf.map(|l| l.chain.clone());
    let key = leaf.map(|l| l.key.clone());
    let extra = leaf.and_then(|l| l.intermediates.clone());
    let operation = support::ALLOWED_OPERATION.to_string();
    tokio::task::spawn_blocking(move || {
        s_client(&SClient {
            port,
            servername: SERVER_DNS,
            ca_file: &ca,
            client_chain: chain.as_deref(),
            client_key: key.as_deref(),
            client_intermediates: extra.as_deref(),
            request: &get(&format!("/probe/{operation}"), SERVER_DNS),
        })
    })
    .await?
}

/// A `server_tls` listener accepts an anonymous client. The same binding set
/// then admits nobody, so the *evidence* is what differs — this is the
/// AT-EVIDENCE-POSITIVE shape: an authenticated observation is not mandatory
/// enforcement.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS + openssl oracle; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn a_server_tls_listener_admits_the_connection_and_still_binds_nobody() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = world()?;
    let listener = support::Listener::start(
        TransportPolicy::ServerTls,
        &world.server.chain,
        &world.server.key,
        &world.root.cert,
        support::router(bindings()),
    )
    .await?;
    let anonymous = dial(listener.port, &world.root.cert, None).await?;
    assert_eq!(
        anonymous.status(),
        Some(403),
        "server_tls completes the handshake and denies at admission"
    );
    // And presenting a certificate on a `server_tls` listener does not make
    // one: the listener never asked, so there is no peer evidence.
    let offered = dial(listener.port, &world.root.cert, Some(&world.bound)).await?;
    assert_eq!(offered.status(), Some(403));
    record(
        "IOP-TLS-EVIDENCE-POSITIVE",
        "rustls SecureListener(server_tls) <- openssl s_client",
        "handshake ok, admission denies with and without a client certificate",
    );
    listener.stop().await;
    Ok(())
}

/// The selector the listener derives from an openssl-minted leaf must be the
/// exact SPIFFE ID, not a substring or a subject field.
#[test]
#[ignore = "real TLS + openssl oracle; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn the_openssl_minted_leaf_presents_exactly_one_uri_selector() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = world()?;
    let identity = opensesame_transport_security::TlsIdentity::from_pem(
        &std::fs::read(&world.bound.chain)?,
        &secrecy::SecretBox::new(Box::new(std::fs::read(&world.bound.key)?)),
    )?;
    let selectors: Vec<&PeerIdentitySelector> = identity.selectors().iter().collect();
    assert!(
        selectors.contains(&&PeerIdentitySelector::SpiffeId(BOUND_ID.to_string())),
        "expected the exact SPIFFE id among {selectors:?}"
    );
    assert_eq!(
        identity.leaf_thumbprint_sha256(),
        world.bound.thumbprint,
        "the loader's thumbprint must equal OpenSSL's own SHA-256 fingerprint"
    );
    record(
        "IOP-TLS-THUMBPRINT",
        "openssl x509 -fingerprint -sha256 vs TlsIdentity",
        "independent digests agree",
    );
    Ok(())
}
