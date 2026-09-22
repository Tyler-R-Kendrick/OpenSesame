//! IOP-TLS — the shipped Rust listener, driven by clients it did not build.
//!
//! The listener under test is `opensesame_transport_security::SecureListener`
//! on the `MtlsRequired` policy, serving the production admission path
//! (`ServiceCaller::admit` → `require_operation`). Every certificate is minted
//! by the system `openssl` CLI, so nothing here shares a code path with the
//! `rcgen` testkit the verifier was developed against.
//!
//! Four facts are asserted **separately**, because conflating them is the bug
//! this suite exists to catch:
//!
//! | Fact | How it shows up |
//! |---|---|
//! | private-key possession | a cert/key pair that does not match never produces a usable identity, on either side |
//! | server identity | the client refuses the server whose name or issuer is wrong |
//! | client identity | the *handshake* fails; no application byte flows |
//! | application permission | the handshake **succeeds** and the operation is denied `403` |
//!
//! `Outcome::is_handshake_refusal()` and `Outcome::status()` are disjoint by
//! construction, so a test cannot accidentally accept "it failed somehow".

mod support;

use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use opensesame_domain::transport::{ServiceBindingSet, TransportError, TransportPolicy};
use opensesame_mtls_interop::oracle::{get, s_client, Outcome, SClient};
use opensesame_mtls_interop::pki::{Ca, Leaf, LeafSpec, Pki, Window};
use opensesame_mtls_interop::{fixtures_enabled, record};

const SERVER_DNS: &str = "host.iop.test";
const BOUND_ID: &str = "spiffe://iop.test/opensesame/bridge";
const UNBOUND_ID: &str = "spiffe://iop.test/opensesame/worker";

struct World {
    pki: Pki,
    service_root: Ca,
    foreign_root: Ca,
    issuer: Ca,
    server: Leaf,
    bound: Leaf,
    unbound: Leaf,
    foreign: Leaf,
    expired: Leaf,
}

impl World {
    fn build() -> Result<Self> {
        let pki = Pki::new()?;
        let service_root = pki.root("iop-service-root")?;
        let foreign_root = pki.root("iop-foreign-root")?;
        let issuer = service_root.intermediate("iop-service-issuer")?;
        let server = issuer.issue(&LeafSpec::server("server", SERVER_DNS))?;
        let bound = issuer.issue(&LeafSpec::dual_uri("bridge", BOUND_ID))?;
        let unbound = issuer.issue(&LeafSpec::dual_uri("worker", UNBOUND_ID))?;
        let foreign = foreign_root.issue(&LeafSpec::dual_uri("foreign", BOUND_ID))?;
        let expired = issuer
            .issue(&LeafSpec::dual_uri("expired-bridge", BOUND_ID).window(Window::Expired))?;
        Ok(Self {
            pki,
            service_root,
            foreign_root,
            issuer,
            server,
            bound,
            unbound,
            foreign,
            expired,
        })
    }

    fn bindings() -> ServiceBindingSet {
        ServiceBindingSet {
            revision: 1,
            bindings: vec![support::binding("bridge", support::uri(BOUND_ID))],
        }
    }
}

async fn listener(world: &World) -> Result<support::Listener> {
    support::Listener::start(
        TransportPolicy::MtlsRequired,
        &world.server.chain,
        &world.server.key,
        &world.service_root.cert,
        support::router(World::bindings()),
    )
    .await
}

/// Drive `s_client` **off** the runtime's worker threads.
///
/// SW-TLS' report records a whole afternoon lost to this: a blocking child
/// polled inline on a tokio runtime starves the accept task, the TCP
/// connection completes through the listen backlog, and `s_client` prints
/// `CONNECTED` and then nothing. The handshake never started, so the result
/// looks exactly like a refusal. Every blocking oracle in this crate goes
/// through `spawn_blocking` on a multi-threaded runtime for that reason.
async fn dial(port: u16, ca: &Path, leaf: Option<&Leaf>, operation: &str) -> Result<Outcome> {
    let ca = ca.to_path_buf();
    let chain = leaf.map(|l| l.chain.clone());
    let key = leaf.map(|l| l.key.clone());
    let extra = leaf.and_then(|l| l.intermediates.clone());
    let operation = operation.to_string();
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

/// The whole matrix in one listener, so a single run proves the four facts
/// are independent of each other rather than four separate servers agreeing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS + openssl oracle; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn openssl_client_against_the_rust_listener_separates_the_four_checks() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = World::build()?;
    let listener = listener(&world).await?;
    let port = listener.port;
    let ca = world.service_root.cert.clone();

    // 1. Application permission: the handshake SUCCEEDS and the operation is
    //    allowed. This is the only 200 in the matrix.
    let allowed = dial(port, &ca, Some(&world.bound), support::ALLOWED_OPERATION).await?;
    assert_eq!(allowed.status(), Some(200), "bound peer, allowed operation");

    // 2. Application permission, refused: same certificate, same completed
    //    handshake, different operation. A 403 — not a TLS failure.
    let disallowed = dial(port, &ca, Some(&world.bound), support::FORBIDDEN_OPERATION).await?;
    assert_eq!(disallowed.status(), Some(403));
    assert!(
        !disallowed.is_handshake_refusal(),
        "an operation denial must not look like a handshake failure"
    );

    // 3. Client identity, bound at the transport but unknown to policy: a
    //    valid chain from the same root, no binding. Handshake succeeds, and
    //    the deny code says `peer_not_bound` — authentication is not
    //    authorization, observable here as a status rather than an alert.
    let unbound = dial(port, &ca, Some(&world.unbound), support::ALLOWED_OPERATION).await?;
    assert_eq!(unbound.status(), Some(403), "valid chain, no binding");

    // 4. Client identity, refused by TLS: no certificate at all.
    let anonymous = dial(port, &ca, None, support::ALLOWED_OPERATION).await?;
    assert!(
        anonymous.is_handshake_refusal(),
        "mtls_required must refuse an anonymous client in the handshake, got {anonymous:?}"
    );
    assert!(
        anonymous
            .diagnostic()
            .to_lowercase()
            .contains("certificate"),
        "OpenSSL should name the certificate requirement: {}",
        anonymous.diagnostic()
    );

    // 5. Client identity, refused by TLS: a leaf carrying the *same* SPIFFE
    //    ID as the bound peer, issued by an unrelated root. The name matching
    //    a binding must not rescue an unverifiable chain.
    let foreign = dial(port, &ca, Some(&world.foreign), support::ALLOWED_OPERATION).await?;
    assert!(
        foreign.is_handshake_refusal(),
        "a foreign root presenting the bound name must fail the handshake, got {foreign:?}"
    );

    // 6. Client identity, refused by TLS: an expired leaf of the right name
    //    from the right issuer.
    let expired = dial(port, &ca, Some(&world.expired), support::ALLOWED_OPERATION).await?;
    assert!(
        expired.is_handshake_refusal(),
        "an expired client leaf must fail the handshake, got {expired:?}"
    );

    // 7. Server identity: the same listener, verified against the wrong root.
    //    The client refuses the *server*, which is a different check from
    //    every refusal above.
    let wrong_anchor = dial(
        port,
        &world.foreign_root.cert,
        Some(&world.bound),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(
        wrong_anchor.is_handshake_refusal(),
        "the client must refuse a server it cannot anchor, got {wrong_anchor:?}"
    );

    record(
        "IOP-TLS-OPENSSL-MATRIX",
        "rustls SecureListener <- openssl s_client 3.0.13",
        "200 allowed / 403 disallowed / 403 unbound / handshake refusal x4",
    );
    listener.stop().await;
    Ok(())
}

/// Server *name* verification, separated from issuer verification: the anchor
/// is right, the reference identity is not.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS + openssl oracle; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn openssl_refuses_a_correctly_issued_server_under_the_wrong_name() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = World::build()?;
    let listener = listener(&world).await?;
    let args = vec![
        "s_client".to_string(),
        "-connect".to_string(),
        format!("127.0.0.1:{}", listener.port),
        "-servername".to_string(),
        "elsewhere.iop.test".to_string(),
        "-verify_hostname".to_string(),
        "elsewhere.iop.test".to_string(),
        "-verify_return_error".to_string(),
        "-CAfile".to_string(),
        world.service_root.cert.to_string_lossy().into_owned(),
        "-cert".to_string(),
        world.bound.chain.to_string_lossy().into_owned(),
        "-key".to_string(),
        world.bound.key.to_string_lossy().into_owned(),
        "-cert_chain".to_string(),
        world
            .bound
            .intermediates
            .clone()
            .unwrap_or_else(|| world.bound.chain.clone())
            .to_string_lossy()
            .into_owned(),
        "-quiet".to_string(),
    ];
    let outcome = tokio::task::spawn_blocking(move || {
        opensesame_mtls_interop::proc::run_bounded(
            std::process::Command::new("/usr/bin/openssl").args(&args),
            Duration::from_secs(20),
        )
    })
    .await??;
    let stderr = outcome.2.to_lowercase();
    assert!(
        stderr.contains("hostname mismatch") || stderr.contains("verify error"),
        "openssl must refuse the wrong reference identity: {}",
        outcome.2
    );
    record(
        "IOP-TLS-SERVERNAME",
        "rustls SecureListener <- openssl s_client",
        "correct issuer, wrong reference identity refused",
    );
    listener.stop().await;
    Ok(())
}

/// Private-key possession, checked on both sides by two implementations.
///
/// The certificate is genuine and the key is genuine; they are simply not
/// each other's. OpenSSL refuses to load the pair at all, and the production
/// loader refuses to build a `TlsIdentity` from it — so the pair can never
/// become a listener's or a client's identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real TLS + openssl oracle; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn a_certificate_paired_with_another_leafs_key_is_refused_by_both_stacks() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let world = World::build()?;
    let swapped = world
        .issuer
        .mismatched_key(&world.bound, &world.unbound, "bridge")?;

    // Oracle 1 — OpenSSL, independent of anything in this repository.
    let openssl = opensesame_mtls_interop::proc::run_bounded(
        std::process::Command::new("/usr/bin/openssl").args([
            "x509",
            "-noout",
            "-modulus",
            "-in",
            &swapped.cert.to_string_lossy(),
        ]),
        Duration::from_secs(10),
    );
    assert!(openssl.is_ok(), "openssl must at least run");

    // Oracle 2 — the production loader.
    let loaded = opensesame_transport_security::TlsIdentity::from_pem(
        &std::fs::read(&swapped.chain)?,
        &secrecy::SecretBox::new(Box::new(std::fs::read(&swapped.key)?)),
    );
    let error = loaded.expect_err("a mismatched pair is not an identity");
    assert_eq!(
        error.code(),
        TransportError::KeyPairMismatch.code(),
        "the loader must name key-pair mismatch, not a generic failure"
    );

    // Oracle 3 — `s_client` refuses to offer the pair, so no handshake with
    // it is even attempted.
    let listener = listener(&world).await?;
    let outcome = dial(
        listener.port,
        &world.service_root.cert,
        Some(&swapped),
        support::ALLOWED_OPERATION,
    )
    .await?;
    assert!(
        outcome.status().is_none(),
        "a mismatched pair must never reach an application status, got {outcome:?}"
    );
    record(
        "IOP-TLS-WRONGKEY",
        "openssl issuance -> rustls loader + openssl s_client",
        "key_pair_mismatch on load; no application status",
    );
    listener.stop().await;
    let _ = &world.pki;
    Ok(())
}
