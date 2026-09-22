//! Independent oracle: `openssl s_client` (OpenSSL 3) against the listener
//! for AT-TLS-VALID, AT-TLS-NOCLIENT, AT-TLS-WRONGKEY and an expired leaf.
//! The test fails, not skips, when the binary is missing — it is present in
//! this environment and the oracle is part of the evidence.

mod common;

use chrono::{Duration, Utc};
use common::*;
use opensesame_domain::transport::{PeerIdentitySelector, TransportPolicy};
use opensesame_transport_security::testkit::{tempdir, DisposableCa, LeafSpec};

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
    std::fs::write(&ca_file, server_ca.root_pem()).unwrap();
    let ca = ca_file.to_str().unwrap();

    // Valid.
    let good = client_ca.issue_client(PeerIdentitySelector::DnsName("cli.internal".into()));
    let good_dir = dir.path().join("good");
    std::fs::create_dir(&good_dir).unwrap();
    let (cert, key) = good.write_to(&good_dir);
    let out = openssl_s_client(
        served.addr,
        &[
            "-CAfile",
            ca,
            "-cert",
            cert.to_str().unwrap(),
            "-key",
            key.to_str().unwrap(),
        ],
    )
    .await;
    assert!(out.contains("Verify return code: 0 (ok)"), "{out}");
    assert!(out.contains("HTTP/1.1 200"), "{out}");
    assert!(out.contains("TLSv1.3"), "{out}");

    // No client certificate: OpenSSL sees the certificate-required alert.
    let out = openssl_s_client(served.addr, &["-CAfile", ca]).await;
    assert!(!out.contains("HTTP/1.1 200"), "{out}");
    assert!(out.to_ascii_lowercase().contains("alert"), "{out}");

    // Wrong key: OpenSSL itself refuses the pair before connecting.
    let other = client_ca.issue_client(PeerIdentitySelector::DnsName("other.internal".into()));
    let wrong_dir = dir.path().join("wrong");
    std::fs::create_dir(&wrong_dir).unwrap();
    let (cert, key) = good.with_other_key(&other).write_to(&wrong_dir);
    let out = openssl_s_client(
        served.addr,
        &[
            "-CAfile",
            ca,
            "-cert",
            cert.to_str().unwrap(),
            "-key",
            key.to_str().unwrap(),
        ],
    )
    .await;
    assert!(!out.contains("HTTP/1.1 200"), "{out}");
    assert!(
        out.to_ascii_lowercase().contains("mismatch") || out.to_ascii_lowercase().contains("alert"),
        "{out}"
    );

    // Expired leaf: the server's alert.
    let now = Utc::now();
    let expired = client_ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now - Duration::hours(1), now - Duration::seconds(1)),
    );
    let exp_dir = dir.path().join("expired");
    std::fs::create_dir(&exp_dir).unwrap();
    let (cert, key) = expired.write_to(&exp_dir);
    let out = openssl_s_client(
        served.addr,
        &[
            "-CAfile",
            ca,
            "-cert",
            cert.to_str().unwrap(),
            "-key",
            key.to_str().unwrap(),
        ],
    )
    .await;
    assert!(!out.contains("HTTP/1.1 200"), "{out}");
    assert!(
        out.to_ascii_lowercase().contains("expired") || out.to_ascii_lowercase().contains("alert"),
        "{out}"
    );

    // Wrong server name: OpenSSL's own verification fails.
    let out = openssl_s_client(
        served.addr,
        &[
            "-CAfile",
            ca,
            "-verify_hostname",
            "other.internal",
            "-verify_return_error",
            "-cert",
            good_dir.join("cert.pem").to_str().unwrap(),
            "-key",
            good_dir.join("key.pem").to_str().unwrap(),
        ],
    )
    .await;
    assert!(!out.contains("HTTP/1.1 200"), "{out}");

    assert_eq!(hits.protected(), 0);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        served.counters.handshakes_ok(),
        1,
        "only the valid client completed"
    );
}
