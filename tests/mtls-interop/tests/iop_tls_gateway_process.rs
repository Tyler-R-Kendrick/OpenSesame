//! IOP-TLS at the **real Host entry point**: `opensesame host run`, the `opensesame`
//! process, configured the way an operator would configure it.
//!
//! `crates/gateway/src/transport/boot.rs` is reachable only from `main`, so the
//! two facts that matter most about it cannot be shown by a unit test:
//!
//! 1. a configured `mtls_required` listener really authenticates the peer,
//!    while the supported plain `existing_local` listener keeps serving —
//!    two listeners, one router, different admission;
//! 2. a configured `mtls_required` deployment whose material is broken
//!    **refuses to serve at all**. It does not downgrade to the plain
//!    listener, which is the EXPLICIT-ENFORCEMENT invariant; the assertion
//!    below checks the plain port too, because "the process died" and "the
//!    process is answering on plaintext" are different outcomes.
//!
//! The certificates come from the system `openssl`, and the client is
//! `openssl s_client` — neither of them shares a line of code with the Host.

mod support;

#[path = "support/gateway.rs"]
mod gateway;

use std::time::Duration;

use anyhow::Result;
use opensesame_mtls_interop::oracle::{get, s_client, SClient};
use opensesame_mtls_interop::pki::{LeafSpec, Pki};
use opensesame_mtls_interop::{fixtures_enabled, record};

const SERVER_DNS: &str = "host.iop.test";
const BOUND_ID: &str = "spiffe://iop.test/opensesame/bridge";

/// Both listeners of one real Host process, checked by a third-party client.
#[test]
#[ignore = "spawns `opensesame host run`; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn the_host_process_authenticates_on_the_secure_listener_and_still_serves_the_plain_one(
) -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let pki = Pki::new()?;
    let root = pki.root("iop-host-root")?;
    let foreign_root = pki.root("iop-host-foreign-root")?;
    let issuer = root.intermediate("iop-host-issuer")?;
    let server = issuer.issue(&LeafSpec::server("host", SERVER_DNS))?;
    let bridge = issuer.issue(&LeafSpec::dual_uri("bridge", BOUND_ID))?;
    let foreign = foreign_root.issue(&LeafSpec::dual_uri("foreign", BOUND_ID))?;
    let bindings = pki.dir().join("host-bindings.json");
    std::fs::write(&bindings, br#"{"revision":1,"bindings":[]}"#)?;

    let mut host = gateway::Gateway::spawn(&gateway::GatewaySpec {
        policy: "mtls_required",
        cert: &server.chain,
        key: &server.key,
        client_trust: &root.cert,
        bindings: &bindings,
        log_dir: pki.dir(),
    })?;
    host.wait_ready(Duration::from_secs(120))?;

    // The plain listener is a supported profile, not a fallback: it answers
    // without any TLS at all.
    let plain = std::process::Command::new("/usr/bin/curl")
        .args([
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--max-time",
            "15",
            &format!("http://127.0.0.1:{}/health/live", host.ports.plain),
        ])
        .output()?;
    assert_eq!(
        String::from_utf8_lossy(&plain.stdout).trim(),
        "200",
        "the plain listener must keep serving: {}",
        host.log()
    );

    // The secure listener refuses an anonymous client in the handshake.
    let anonymous = s_client(&SClient {
        port: host.ports.tls,
        servername: SERVER_DNS,
        ca_file: &root.cert,
        client_chain: None,
        client_key: None,
        client_intermediates: None,
        request: &get("/health/live", SERVER_DNS),
    })?;
    assert!(
        anonymous.is_handshake_refusal(),
        "the Host's mtls_required listener must refuse an anonymous client: {anonymous:?}"
    );
    assert!(
        anonymous
            .diagnostic()
            .to_lowercase()
            .contains("certificate"),
        "{}",
        anonymous.diagnostic()
    );

    // A leaf from an unrelated root is refused even though its SPIFFE id is
    // the one an operator would bind.
    let wrong_root = s_client(&SClient {
        port: host.ports.tls,
        servername: SERVER_DNS,
        ca_file: &root.cert,
        client_chain: Some(&foreign.chain),
        client_key: Some(&foreign.key),
        client_intermediates: foreign.intermediates.as_deref(),
        request: &get("/health/live", SERVER_DNS),
    })?;
    assert!(
        wrong_root.is_handshake_refusal(),
        "a foreign root must not reach the Host's router: {wrong_root:?}"
    );

    // A verifiable client certificate completes the handshake, and the
    // unauthenticated health route answers — authentication happened at the
    // transport, authorization is a separate question the binding set
    // answers for the *service* routes.
    let verified = s_client(&SClient {
        port: host.ports.tls,
        servername: SERVER_DNS,
        ca_file: &root.cert,
        client_chain: Some(&bridge.chain),
        client_key: Some(&bridge.key),
        client_intermediates: bridge.intermediates.as_deref(),
        request: &get("/health/live", SERVER_DNS),
    })?;
    assert_eq!(
        verified.status(),
        Some(200),
        "a verified peer should reach the router: {verified:?}"
    );

    record(
        "IOP-TLS-HOST-PROCESS",
        "opensesame host run process <- openssl s_client + curl",
        "plain 200 / tls anonymous refused / foreign root refused / verified 200",
    );
    Ok(())
}

/// EXPLICIT-ENFORCEMENT at the process boundary: a configured
/// `mtls_required` listener whose key does not match its certificate must
/// stop the whole Host, not fall back to the plain listener.
#[test]
#[ignore = "spawns `opensesame host run`; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn a_broken_mtls_required_host_refuses_to_serve_at_all() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let pki = Pki::new()?;
    let root = pki.root("iop-broken-root")?;
    let issuer = root.intermediate("iop-broken-issuer")?;
    let server = issuer.issue(&LeafSpec::server("host", SERVER_DNS))?;
    let other = issuer.issue(&LeafSpec::server("other", "other.iop.test"))?;
    // The certificate is genuine; the key belongs to a different leaf.
    let broken = issuer.mismatched_key(&server, &other, "host")?;
    let bindings = pki.dir().join("host-bindings.json");
    std::fs::write(&bindings, br#"{"revision":1,"bindings":[]}"#)?;

    let mut host = gateway::Gateway::spawn(&gateway::GatewaySpec {
        policy: "mtls_required",
        cert: &broken.chain,
        key: &broken.key,
        client_trust: &root.cert,
        bindings: &bindings,
        log_dir: pki.dir(),
    })?;
    let log = host
        .refused_to_start(Duration::from_secs(120))
        .expect("a mismatched key must stop the Host, not be tolerated");
    assert!(
        log.to_lowercase().contains("key")
            || log.contains("key_pair_mismatch")
            || log.to_lowercase().contains("transport"),
        "the refusal should name the transport material:\n{log}"
    );
    assert!(
        !gateway::Gateway::port_open(host.ports.plain),
        "a refused secure profile must NOT leave the plain listener serving"
    );
    assert!(!gateway::Gateway::port_open(host.ports.tls));

    record(
        "IOP-TLS-HOST-NODOWNGRADE",
        "opensesame host run process",
        "mismatched key: process exits, neither listener open",
    );
    Ok(())
}
