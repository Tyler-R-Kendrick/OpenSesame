//! Temporary manual repro harness (deleted before hand-off).
mod common;

use chrono::{Duration, Utc};
use common::*;
use opensesame_domain::transport::{PeerIdentitySelector, TransportPolicy};
use opensesame_transport_security::testkit::{DisposableCa, LeafSpec};

#[tokio::test]
#[ignore]
async fn manual_listener() {
    let dir = std::path::PathBuf::from(
        std::env::var("MANUAL_DIR").unwrap_or_else(|_| "/tmp/manual-tls".into()),
    );
    std::fs::create_dir_all(&dir).unwrap();
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
    std::fs::write(dir.join("ca.pem"), server_ca.root_pem()).unwrap();
    let good = client_ca.issue_client(PeerIdentitySelector::DnsName("cli.internal".into()));
    let good_dir = dir.join("good");
    std::fs::create_dir_all(&good_dir).unwrap();
    good.write_to(&good_dir);
    let now = Utc::now();
    let expired = client_ca.issue_with(
        &LeafSpec::client(vec![]).valid_between(now - Duration::hours(1), now - Duration::seconds(1)),
    );
    let exp_dir = dir.join("expired");
    std::fs::create_dir_all(&exp_dir).unwrap();
    expired.write_to(&exp_dir);
    println!("PORT={}", served.addr.port());
    std::fs::write(dir.join("port"), served.addr.port().to_string()).unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(600)).await;
}
