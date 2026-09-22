//! Independent oracle: `openssl s_client` (OpenSSL 3) against the listener
//! for AT-TLS-VALID, AT-TLS-NOCLIENT, AT-TLS-WRONGKEY, an expired leaf and a
//! server-name mismatch. The test fails, not skips, when the binary is
//! missing — it is present in this environment and the oracle is part of the
//! evidence.
//!
//! Every case reads the *specific* OpenSSL diagnostic (`certificate
//! required`, `certificate expired`, `hostname mismatch`), never a bare
//! "something failed": a refusal for the wrong reason must not pass.

mod common;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};
use common::*;
use opensesame_domain::transport::{PeerIdentitySelector, TransportPolicy};
use opensesame_transport_security::testkit::{tempdir, DisposableCa, IssuedLeaf, LeafSpec};

/// Write `leaf` under `dir/name` and return its `-cert`/`-key` paths.
fn materials(dir: &Path, name: &str, leaf: &IssuedLeaf) -> (PathBuf, PathBuf) {
    let sub = dir.join(name);
    std::fs::create_dir(&sub).expect("leaf dir");
    leaf.write_to(&sub)
}

/// `openssl s_client` with a CA file and a client key pair, plus `extra`.
async fn s_client_with(
    addr: SocketAddr,
    ca: &str,
    cert: &Path,
    key: &Path,
    extra: &[&str],
) -> String {
    let mut args = vec![
        "-CAfile",
        ca,
        "-cert",
        cert.to_str().expect("cert path"),
        "-key",
        key.to_str().expect("key path"),
    ];
    args.extend_from_slice(extra);
    openssl_s_client(addr, &args).await
}

/// Assert the exchange was refused and that OpenSSL said exactly why.
fn refused(out: &str, because: &str) {
    assert!(!out.contains("HTTP/1.1 200"), "{out}");
    assert!(out.to_ascii_lowercase().contains(because), "{out}");
}

#[tokio::test]
async fn openssl_agrees_with_the_listener() {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let gens = generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens, hits.clone()),
    )
    .await;
    let dir = tempdir();
    let ca_file = dir.path().join("servers.pem");
    std::fs::write(&ca_file, server_ca.root_pem()).expect("ca file");
    let ca = ca_file.to_str().expect("ca path");

    // Valid: the handshake completes and the router answers.
    let good = client_ca.issue_client(PeerIdentitySelector::DnsName("cli.internal".into()));
    let (cert, key) = materials(dir.path(), "good", &good);
    let out = s_client_with(served.addr, ca, &cert, &key, &[]).await;
    assert!(out.contains("Verify return code: 0 (ok)"), "{out}");
    assert!(out.contains("HTTP/1.1 200"), "{out}");
    assert!(out.contains("TLSv1.3"), "{out}");

    // No client certificate: the listener's `certificate_required` alert.
    let out = openssl_s_client(served.addr, &["-CAfile", ca]).await;
    refused(&out, "certificate required");

    // Wrong key: OpenSSL itself refuses the pair before connecting.
    let other = client_ca.issue_client(PeerIdentitySelector::DnsName("other.internal".into()));
    let (wrong_cert, wrong_key) = materials(dir.path(), "wrong", &good.with_other_key(&other));
    let out = s_client_with(served.addr, ca, &wrong_cert, &wrong_key, &[]).await;
    refused(&out, "mismatch");

    // Expired leaf: the listener's `certificate_expired` alert.
    let now = Utc::now();
    let expired = client_ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now - Duration::hours(1), now - Duration::seconds(1)),
    );
    let (exp_cert, exp_key) = materials(dir.path(), "expired", &expired);
    let out = s_client_with(served.addr, ca, &exp_cert, &exp_key, &[]).await;
    refused(&out, "certificate expired");

    // Wrong server name: OpenSSL's own reference-identity check fails.
    // `-verify_return_error` makes that failure fatal instead of advisory; it
    // can only turn a warning into a refusal, never hide one.
    let out = s_client_with(
        served.addr,
        ca,
        &cert,
        &key,
        &["-verify_hostname", "other.internal", "-verify_return_error"],
    )
    .await;
    refused(&out, "hostname mismatch");

    assert_eq!(hits.protected(), 0);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        served.counters.handshakes_ok(),
        1,
        "only the valid client completed"
    );
}
