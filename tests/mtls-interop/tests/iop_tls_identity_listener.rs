//! IOP-TLS, the second pair: **the shipped Node listener, dialled by a Rust
//! client.**
//!
//! The server is `packages/control-plane/src/transport/listener.ts` running under
//! `tsx` in its own process — the same `createTransportListener`,
//! `loadTransportMaterial` and `admitService` a deployment boots. The client
//! is the production outbound path,
//! `opensesame_transport_security::reqwest_builder`, which is what the Host's
//! mapping client and every connector use.
//!
//! This is the direction the implementing swarms could not cover: SW-IDENTITY
//! drove its listener from Node's own `tls` module, and SW-SERVICE drove its
//! Rust mapping client against a Rust `SecureListener` standing in for
//! Identity. Neither pairing crosses the runtime boundary that a real
//! Host→Identity call crosses.
//!
//! As everywhere in this crate, a handshake refusal (`reqwest` returns an
//! error, no status exists) and an authorization denial (`403` with a stable
//! code) are asserted as different things.

mod support;

#[path = "support/identity.rs"]
mod identity;

use std::sync::Arc;

use anyhow::Result;
use opensesame_domain::transport::{TlsVersion, TrustProfileKind, TrustProfileRef};
use opensesame_mtls_interop::pki::{Leaf, LeafSpec, Pki};
use opensesame_mtls_interop::{fixtures_enabled, record};
use opensesame_transport_security::{
    reqwest_builder, ClientProfile, ServerNamePolicy, TlsIdentity, TrustBundle,
};

const SERVER_DNS: &str = "identity.iop.test";
const BOUND_ID: &str = "spiffe://iop.test/opensesame/bridge";
const UNBOUND_ID: &str = "spiffe://iop.test/opensesame/worker";

fn identity_of(leaf: &Leaf) -> Result<Arc<TlsIdentity>> {
    Ok(Arc::new(TlsIdentity::from_pem(
        &std::fs::read(&leaf.chain)?,
        &secrecy::SecretBox::new(Box::new(std::fs::read(&leaf.key)?)),
    )?))
}

/// The production outbound client, with `identity.iop.test` pinned to the
/// loopback port the harness bound. Nothing about verification is relaxed:
/// the name the certificate must carry is still `identity.iop.test`.
fn client(anchors: &std::path::Path, leaf: Option<&Leaf>, port: u16) -> Result<reqwest::Client> {
    let trust = TrustBundle::from_pem(
        TrustProfileRef {
            name: "iop-identity-root".to_string(),
        },
        TrustProfileKind::PrivateRoot,
        &std::fs::read(anchors)?,
    )?;
    let profile = ClientProfile {
        server_trust: trust,
        server_name: ServerNamePolicy::Dns(SERVER_DNS.to_string()),
        identity: match leaf {
            Some(leaf) => Some(identity_of(leaf)?),
            None => None,
        },
        min_version: TlsVersion::Tls13,
    };
    Ok(reqwest_builder(&profile, reqwest::Client::builder())?
        .no_proxy()
        .resolve(SERVER_DNS, (std::net::Ipv4Addr::LOCALHOST, port).into())
        .timeout(std::time::Duration::from_secs(20))
        .build()?)
}

/// The production Rust client against the production Node listener.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "boots packages/control-plane under tsx; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn a_rust_client_against_the_identity_node_listener_separates_transport_from_authorization(
) -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let pki = Pki::new()?;
    let root = pki.root("iop-identity-root")?;
    let other_root = pki.root("iop-identity-foreign-root")?;
    let issuer = root.intermediate("iop-identity-issuer")?;
    let server = issuer.issue(&LeafSpec::server("identity", SERVER_DNS))?;
    let bound = issuer.issue(&LeafSpec::dual_uri("bridge", BOUND_ID))?;
    let unbound = issuer.issue(&LeafSpec::dual_uri("worker", UNBOUND_ID))?;
    let foreign = other_root.issue(&LeafSpec::dual_uri("foreign", BOUND_ID))?;

    let bindings = pki.dir().join("identity-bindings.json");
    identity::write_bindings(&bindings, BOUND_ID, &[support::ALLOWED_OPERATION])?;

    let listener = identity::IdentityListener::start(&identity::IdentitySpec {
        policy: "mtls_required",
        cert: &server.chain,
        key: &server.key,
        client_ca: Some(&root.cert),
        bindings: &bindings,
        log_dir: pki.dir(),
    })?;
    let base = format!("https://{SERVER_DNS}:{}", listener.port);
    let url = |operation: &str| format!("{base}/probe/{operation}");

    // 1. Bound peer, allowed operation.
    let allowed = client(&root.cert, Some(&bound), listener.port)?
        .get(url(support::ALLOWED_OPERATION))
        .send()
        .await;
    let allowed = match allowed {
        Ok(response) => response,
        Err(error) => panic!("bound peer should have been admitted: {error}"),
    };
    assert_eq!(allowed.status().as_u16(), 200);
    let body = allowed.text().await?;
    assert!(body.contains("svc:bridge"), "unexpected body: {body}");

    // 2. Same handshake, operation the binding does not list.
    let disallowed = client(&root.cert, Some(&bound), listener.port)?
        .get(url(support::FORBIDDEN_OPERATION))
        .send()
        .await?;
    assert_eq!(disallowed.status().as_u16(), 403);
    assert_eq!(
        disallowed
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("peer_disallowed"),
        "Identity must name the authorization refusal"
    );

    // 3. A valid chain nobody bound: the handshake still completes.
    let unbound_response = client(&root.cert, Some(&unbound), listener.port)?
        .get(url(support::ALLOWED_OPERATION))
        .send()
        .await?;
    assert_eq!(unbound_response.status().as_u16(), 403);
    assert_eq!(
        unbound_response
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("peer_not_bound")
    );

    // 4. No client identity at all: this must fail in the handshake, so
    //    there is no status to read.
    let anonymous = client(&root.cert, None, listener.port)?
        .get(url(support::ALLOWED_OPERATION))
        .send()
        .await;
    assert!(
        anonymous.is_err(),
        "mtls_required Identity must refuse an anonymous Rust client, got {:?}",
        anonymous.map(|r| r.status())
    );

    // 5. A foreign root presenting the bound SPIFFE id.
    let foreign_response = client(&root.cert, Some(&foreign), listener.port)?
        .get(url(support::ALLOWED_OPERATION))
        .send()
        .await;
    assert!(
        foreign_response.is_err(),
        "an unverifiable chain must not reach a handler"
    );

    // 6. Server identity: the same listener anchored on the wrong root.
    let wrong_anchor = client(&other_root.cert, Some(&bound), listener.port)?
        .get(url(support::ALLOWED_OPERATION))
        .send()
        .await;
    assert!(
        wrong_anchor.is_err(),
        "the Rust client must refuse a server it cannot anchor"
    );

    record(
        "IOP-TLS-IDENTITY-LISTENER",
        "node 22 https listener (packages/control-plane) <- rustls reqwest client",
        "200 allowed / 403 peer_disallowed / 403 peer_not_bound / 3 handshake refusals",
    );
    Ok(())
}

/// `server_tls` on the Identity listener: the connection is fine and the
/// evidence is absent, so admission refuses. An accepted TLS session is not
/// an authenticated peer (AT-EVIDENCE-POSITIVE, Identity half).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "boots packages/control-plane under tsx; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn identity_server_tls_completes_the_handshake_and_still_admits_nobody() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let pki = Pki::new()?;
    let root = pki.root("iop-identity-root")?;
    let issuer = root.intermediate("iop-identity-issuer")?;
    let server = issuer.issue(&LeafSpec::server("identity", SERVER_DNS))?;
    let bound = issuer.issue(&LeafSpec::dual_uri("bridge", BOUND_ID))?;
    let bindings = pki.dir().join("identity-bindings.json");
    identity::write_bindings(&bindings, BOUND_ID, &[support::ALLOWED_OPERATION])?;

    let listener = identity::IdentityListener::start(&identity::IdentitySpec {
        policy: "server_tls",
        cert: &server.chain,
        key: &server.key,
        client_ca: None,
        bindings: &bindings,
        log_dir: pki.dir(),
    })?;
    let url = format!(
        "https://{SERVER_DNS}:{}/probe/{}",
        listener.port,
        support::ALLOWED_OPERATION
    );

    let anonymous = client(&root.cert, None, listener.port)?
        .get(&url)
        .send()
        .await?;
    assert_eq!(
        anonymous.status().as_u16(),
        403,
        "server_tls admits the connection and denies the operation"
    );

    // Offering a certificate the listener never asked for must not create
    // evidence either.
    let offered = client(&root.cert, Some(&bound), listener.port)?
        .get(&url)
        .send()
        .await?;
    assert_eq!(offered.status().as_u16(), 403);
    assert_eq!(
        offered
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|v| v.to_str().ok()),
        Some("peer_not_bound"),
        "an unrequested certificate is not peer evidence"
    );

    record(
        "IOP-TLS-IDENTITY-SERVERTLS",
        "node 22 https listener (server_tls) <- rustls reqwest client",
        "handshake ok, admission denies with and without a client certificate",
    );
    Ok(())
}
