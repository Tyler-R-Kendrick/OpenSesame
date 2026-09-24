//! IOP-TLS, the other direction of the first pair: **Node's OpenSSL as the
//! client, the shipped Rust `SecureListener` as the server.**
//!
//! `packages/control-plane` is the runtime that will really dial the Host in a
//! deployment, so this is not an academic pairing: it is the Identity plane's
//! TLS stack against the Host plane's. A refusal that both rustls and Node
//! agree on — with certificates neither of them minted — is a property of the
//! certificate rather than of one library's defaults.
//!
//! Node reports `handshake` and `status` as disjoint fields, so the assertion
//! that a certificate was refused *in the handshake* cannot be satisfied by a
//! `403`, and vice versa.

mod support;

use std::path::Path;

use anyhow::Result;
use opensesame_domain::transport::{ServiceBindingSet, TransportPolicy};
use opensesame_mtls_interop::node::{tls_client, vars, NodeResult};
use opensesame_mtls_interop::pki::{Ca, Leaf, LeafSpec, Pki, Window};
use opensesame_mtls_interop::{fixtures_enabled, record};

const SERVER_DNS: &str = "host.iop.test";
const BOUND_ID: &str = "spiffe://iop.test/opensesame/bridge";
const UNBOUND_ID: &str = "spiffe://iop.test/opensesame/worker";

struct World {
    _pki: Pki,
    root: Ca,
    other_root: Ca,
    server: Leaf,
    bound: Leaf,
    unbound: Leaf,
    foreign: Leaf,
    not_yet_valid: Leaf,
}

fn world() -> Result<World> {
    let pki = Pki::new()?;
    let root = pki.root("iop-node-root")?;
    let other_root = pki.root("iop-node-other-root")?;
    let issuer = root.intermediate("iop-node-issuer")?;
    Ok(World {
        server: issuer.issue(&LeafSpec::server("server", SERVER_DNS))?,
        bound: issuer.issue(&LeafSpec::dual_uri("bridge", BOUND_ID))?,
        unbound: issuer.issue(&LeafSpec::dual_uri("worker", UNBOUND_ID))?,
        foreign: other_root.issue(&LeafSpec::dual_uri("foreign", BOUND_ID))?,
        not_yet_valid: issuer
            .issue(&LeafSpec::dual_uri("future", BOUND_ID).window(Window::NotYetValid))?,
        root,
        other_root,
        _pki: pki,
    })
}

fn bindings() -> ServiceBindingSet {
    ServiceBindingSet {
        revision: 1,
        bindings: vec![support::binding("bridge", support::uri(BOUND_ID))],
    }
}

async fn dial(port: u16, ca: &Path, leaf: Option<&Leaf>, operation: &str) -> Result<NodeResult> {
    let mut builder = vars(port, ca, SERVER_DNS, &format!("/probe/{operation}"));
    if let Some(leaf) = leaf {
        builder = builder.identity(&leaf.chain, &leaf.key);
    }
    let map = builder.build();
    tokio::task::spawn_blocking(move || tls_client(&map)).await?
}

/// The same matrix the `openssl` oracle walked, from Node 22's TLS stack.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS across runtimes; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn node_tls_connect_against_the_rust_listener_separates_the_four_checks() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = world()?;
    let listener = support::Listener::start(
        TransportPolicy::MtlsRequired,
        &world.server.chain,
        &world.server.key,
        &world.root.cert,
        support::router(bindings()),
    )
    .await?;
    let port = listener.port;

    let allowed = dial(
        port,
        &world.root.cert,
        Some(&world.bound),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(allowed.handshake_ok(), "bound peer: {allowed:?}");
    assert_eq!(allowed.status(), Some(200), "{allowed:?}");
    assert_eq!(
        allowed
            .json
            .get("protocol")
            .and_then(serde_json::Value::as_str),
        Some("TLSv1.3"),
        "the listener's default must still be TLS 1.3 for a Node peer"
    );

    let disallowed = dial(
        port,
        &world.root.cert,
        Some(&world.bound),
        support::FORBIDDEN_OPERATION,
    )
    .await?;
    assert!(disallowed.handshake_ok(), "{disallowed:?}");
    assert_eq!(disallowed.status(), Some(403), "{disallowed:?}");

    let unbound = dial(
        port,
        &world.root.cert,
        Some(&world.unbound),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(
        unbound.handshake_ok(),
        "a valid unbound chain must still complete the handshake: {unbound:?}"
    );
    assert_eq!(unbound.status(), Some(403), "{unbound:?}");

    let anonymous = dial(port, &world.root.cert, None, support::ALLOWED_OPERATION).await?;
    assert!(
        !anonymous.handshake_ok(),
        "mtls_required must refuse an anonymous Node client: {anonymous:?}"
    );
    assert_eq!(anonymous.status(), None, "{anonymous:?}");

    record(
        "IOP-TLS-NODECLIENT-MATRIX",
        "rustls SecureListener <- node 22 tls.connect",
        "200 allowed / 403 disallowed / 403 unbound / anonymous refused in the handshake",
    );
    listener.stop().await;
    Ok(())
}

/// The adversarial leaves and the server anchor, from Node's stack. Split
/// from the matrix above so each test stays inside the complexity budget and
/// so a failure names which half broke.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS across runtimes; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn node_refuses_an_unverifiable_chain_and_a_server_it_cannot_anchor() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = world()?;
    let listener = support::Listener::start(
        TransportPolicy::MtlsRequired,
        &world.server.chain,
        &world.server.key,
        &world.root.cert,
        support::router(bindings()),
    )
    .await?;
    let port = listener.port;

    let foreign = dial(
        port,
        &world.root.cert,
        Some(&world.foreign),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(
        !foreign.handshake_ok(),
        "a foreign root under the bound name must be refused: {foreign:?}"
    );

    let future = dial(
        port,
        &world.root.cert,
        Some(&world.not_yet_valid),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(
        !future.handshake_ok(),
        "a not-yet-valid client leaf must be refused: {future:?}"
    );

    // Server identity, from Node's side: the right listener, anchored on a
    // root that never issued it.
    let wrong_anchor = dial(
        port,
        &world.other_root.cert,
        Some(&world.bound),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(
        !wrong_anchor.handshake_ok(),
        "Node must refuse a server it cannot anchor: {wrong_anchor:?}"
    );
    // Node's own vocabulary, asserted exactly rather than as "some error":
    // OpenSSL cannot build a path from the presented chain to the anchor it
    // was given.
    assert_eq!(
        wrong_anchor.code(),
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "Node must name the chain-building failure: {wrong_anchor:?}"
    );

    record(
        "IOP-TLS-NODECLIENT-ADVERSARIAL",
        "rustls SecureListener <- node 22 tls.connect",
        "foreign root, not-yet-valid leaf and wrong anchor each refused in the handshake",
    );
    listener.stop().await;
    Ok(())
}

/// Isolating the *name* check from the *issuer* check across runtimes: the
/// same listener, the same anchor, only the reference identity is wrong.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS across runtimes; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn node_refuses_the_wrong_reference_identity_and_accepts_it_when_only_the_name_check_is_off(
) -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = world()?;
    let listener = support::Listener::start(
        TransportPolicy::MtlsRequired,
        &world.server.chain,
        &world.server.key,
        &world.root.cert,
        support::router(bindings()),
    )
    .await?;
    let path = format!("/probe/{}", support::ALLOWED_OPERATION);

    let wrong_name = vars(listener.port, &world.root.cert, "elsewhere.iop.test", &path)
        .identity(&world.bound.chain, &world.bound.key)
        .build();
    let refused = tokio::task::spawn_blocking(move || tls_client(&wrong_name)).await??;
    assert!(
        !refused.handshake_ok(),
        "the reference identity must be checked: {refused:?}"
    );

    // With only the name check relaxed — issuer verification untouched — the
    // very same dial succeeds. That is what proves the refusal above was the
    // name and not something else.
    let name_off = vars(listener.port, &world.root.cert, "elsewhere.iop.test", &path)
        .identity(&world.bound.chain, &world.bound.key)
        .skip_name_check()
        .build();
    let accepted = tokio::task::spawn_blocking(move || tls_client(&name_off)).await??;
    assert_eq!(
        accepted.status(),
        Some(200),
        "issuer verification alone should admit: {accepted:?}"
    );

    record(
        "IOP-TLS-NODE-SERVERNAME",
        "rustls SecureListener <- node 22 tls.connect",
        "name check refuses; issuer-only admits the identical dial",
    );
    listener.stop().await;
    Ok(())
}
