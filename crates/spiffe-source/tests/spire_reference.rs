//! REAL SPIRE reference run (ignored unless `OPENSESAME_MTLS_FIXTURES=1`):
//! `spire-server` + `spire-agent` v1.12.6 on loopback in a tempdir, join-token
//! node attestation, `unix` workload attestor, one entry for
//! `spiffe://example.test/opensesame/gateway` under the current uid (plus a
//! decoy `.../worker` entry so exact selection is exercised against a real
//! agent). Proves the source fetches the configured SVID through the real
//! Workload API, then deletes the entry and proves withdrawal.
//!
//! Run: `OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-spiffe-source -- --ignored --nocapture`

#[path = "support/spire.rs"]
mod spire;

use std::time::Duration;

use opensesame_domain::TransportError;
use opensesame_spiffe_source::sink::recording::{RecordingSink, SinkEvent};
use opensesame_spiffe_source::{SourcePhase, SpiffeSource, SpiffeSourceConfig};

const GW: &str = "spiffe://example.test/opensesame/gateway";
const WK: &str = "spiffe://example.test/opensesame/worker";

fn fixtures_enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").is_ok_and(|v| v == "1")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real SPIRE; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn real_spire_issues_the_configured_svid_and_withdraws_it_when_the_entry_is_deleted() {
    if !fixtures_enabled() {
        eprintln!("OPENSESAME_MTLS_FIXTURES != 1: skipping real SPIRE run");
        return;
    }
    let spire = tokio::task::spawn_blocking(spire::Spire::start)
        .await
        .unwrap()
        .expect("spire up");
    let worker_entry = spire.create_entry(WK).expect("worker entry");
    let gateway_entry = spire.create_entry(GW).expect("gateway entry");
    eprintln!(
        "spire {}: entries worker={worker_entry} gateway={gateway_entry}",
        spire::SPIRE_VERSION
    );

    let cfg = SpiffeSourceConfig::deployment_plane(GW, &spire.agent_socket)
        .unwrap()
        .with_max_stale(Duration::from_secs(30));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(cfg, sink.clone());
    let status = handle
        .wait_for(Duration::from_secs(90), |s| {
            s.phase == SourcePhase::Streaming && s.generation.is_some()
        })
        .await
        .unwrap_or_else(|s| panic!("no SVID from real SPIRE: {s:?}\n{}", spire.logs()));
    let activated: Vec<_> = sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            SinkEvent::Activated {
                spiffe_id,
                trust_domains,
                ..
            } => Some((spiffe_id, trust_domains)),
            SinkEvent::Withdrawn(_) => None,
        })
        .collect();
    assert_eq!(activated.len(), 1, "{activated:?}");
    assert_eq!(
        activated[0].0, GW,
        "exact configured identity, not the first returned"
    );
    assert_eq!(activated[0].1, vec![spire::TRUST_DOMAIN.to_owned()]);
    assert!(status.not_after.unwrap() > chrono::Utc::now());
    eprintln!(
        "real SPIRE: activated generation {:?} for {GW}, not_after {:?}",
        status.generation, status.not_after
    );

    // Independent oracle: the agent CLI, as this uid, is issued both entries.
    let ids = spire.agent_fetch_ids().expect("agent api fetch");
    assert!(
        ids.iter().any(|i| i == GW) && ids.iter().any(|i| i == WK),
        "{ids:?}"
    );

    spire
        .delete_entry(&gateway_entry)
        .expect("delete gateway entry");
    let status = handle
        .wait_for(Duration::from_secs(90), |s| {
            s.phase == SourcePhase::Withdrawn
        })
        .await
        .unwrap_or_else(|s| panic!("no withdrawal after entry delete: {s:?}\n{}", spire.logs()));
    assert_eq!(status.last_error.as_deref(), Some("svid_not_issued"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );
    eprintln!(
        "real SPIRE: withdrawn after entry delete ({:?})",
        status.withdrawals
    );

    let ids = spire.agent_fetch_ids().expect("agent api fetch");
    assert!(
        !ids.iter().any(|i| i == GW),
        "agent still issues gateway: {ids:?}"
    );
    handle.stop().await;
    drop(spire);
}
