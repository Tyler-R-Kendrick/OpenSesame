//! SYNTHETIC oracle: the in-process fake Workload API (`fake` module) drives
//! the real source through selection, replacement, withdrawal, malformed
//! updates, outage bounds, reconnects, rotation and stop. Nothing here talks
//! to SPIRE; `spire_reference.rs` does.

use std::time::Duration;

use opensesame_domain::TransportError;
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use opensesame_spiffe_source::sink::recording::{RecordingSink, SinkEvent};
use opensesame_spiffe_source::{
    ReconnectPolicy, SourcePhase, SourceStatus, SpiffeSource, SpiffeSourceConfig,
    SpiffeSourceHandle,
};

const TD: &str = "example.test";
const GW: &str = "spiffe://example.test/opensesame/gateway";
const WK: &str = "spiffe://example.test/opensesame/worker";
const WAIT: Duration = Duration::from_secs(10);

fn config(api: &FakeWorkloadApi, max_stale: Duration) -> SpiffeSourceConfig {
    SpiffeSourceConfig::deployment_plane(GW, api.socket_path())
        .unwrap()
        .with_max_stale(max_stale)
        .with_reconnect(ReconnectPolicy {
            initial: Duration::from_millis(20),
            max: Duration::from_millis(100),
            jitter_permille: 100,
        })
        .unwrap()
}

fn snapshot(
    td: &FakeTrustDomain,
    svids: &[&IssuedSvid],
) -> opensesame_spiffe_source::fake::pb::X509svidResponse {
    FakeWorkloadApi::snapshot(
        svids
            .iter()
            .map(|s| s.to_proto(&td.bundle_der(), ""))
            .collect(),
        &[],
    )
}

fn activated(events: &[SinkEvent]) -> Vec<(u64, String, String)> {
    events
        .iter()
        .filter_map(|e| match e {
            SinkEvent::Activated {
                number,
                spiffe_id,
                thumbprint,
                ..
            } => Some((*number, spiffe_id.clone(), thumbprint.clone())),
            SinkEvent::Withdrawn(_) => None,
        })
        .collect()
}

async fn streaming(handle: &SpiffeSourceHandle, generation: u64) -> SourceStatus {
    handle
        .wait_for(WAIT, |s| {
            s.phase == SourcePhase::Streaming && s.generation == Some(generation)
        })
        .await
        .unwrap_or_else(|s| panic!("expected streaming generation {generation}, got {s:?}"))
}

async fn withdrawn(handle: &SpiffeSourceHandle) -> SourceStatus {
    handle
        .wait_for(WAIT, |s| s.phase == SourcePhase::Withdrawn)
        .await
        .unwrap_or_else(|s| panic!("expected withdrawn, got {s:?}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_spiffe_select_exact_configured_identity_among_many() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let worker = td.issue_svid(WK, Duration::from_secs(600));
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&worker, &gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    let status = streaming(&handle, 1).await;
    assert_eq!(
        status.custody,
        opensesame_domain::Custody::WorkloadApiDelivered
    );
    assert_eq!(
        activated(&sink.events()),
        vec![(1, GW.to_owned(), gateway.leaf_thumbprint_sha256.clone())]
    );
    handle.stop().await;
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::SourceUnsupported))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_spiffe_withdraw_when_snapshot_drops_the_identity_then_recovers() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    let worker = td.issue_svid(WK, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    streaming(&handle, 1).await;

    api.push_snapshot(snapshot(&td, &[&worker]));
    let status = withdrawn(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("svid_not_issued"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );
    assert_eq!(
        activated(&sink.events()).len(),
        1,
        "the worker SVID was never activated"
    );

    let gateway2 = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&worker, &gateway2]));
    streaming(&handle, 2).await;
    assert_eq!(
        activated(&sink.events())[1].2,
        gateway2.leaf_thumbprint_sha256
    );
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_spiffe_withdraw_when_own_bundle_is_removed() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    streaming(&handle, 1).await;

    api.push_snapshot(FakeWorkloadApi::snapshot(
        vec![gateway.to_proto(&[], "")],
        &[],
    ));
    let status = withdrawn(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("bundle_missing"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::TrustUnknown))
    );
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_spiffe_federation_removed_foreign_bundle_leaves_the_next_generation() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let foreign = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(FakeWorkloadApi::snapshot(
        vec![gateway.to_proto(&td.bundle_der(), "")],
        &[("partner.test", foreign.bundle_der())],
    ));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    streaming(&handle, 1).await;
    assert!(matches!(
        sink.last(),
        Some(SinkEvent::Activated { trust_domains, .. }) if trust_domains == vec![TD.to_owned(), "partner.test".to_owned()]
    ));

    api.push_snapshot(snapshot(&td, &[&gateway]));
    streaming(&handle, 2).await;
    assert!(matches!(
        sink.last(),
        Some(SinkEvent::Activated { number: 2, trust_domains, .. }) if trust_domains == vec![TD.to_owned()]
    ));
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_update_keeps_current_generation_only_until_its_not_after() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(3));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(60)), sink.clone());
    streaming(&handle, 1).await;

    let mut spec =
        opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_secs(600));
    spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
    let bad = td.issue(&spec);
    api.push_snapshot(snapshot(&td, &[&bad]));
    let status = handle
        .wait_for(WAIT, |s| s.last_error.as_deref() == Some("svid_profile"))
        .await
        .unwrap();
    assert_eq!(status.phase, SourcePhase::Streaming);
    assert_eq!(
        status.generation,
        Some(1),
        "previous generation still serves"
    );
    assert_eq!(activated(&sink.events()).len(), 1);

    // ... but only until its own not_after, even though the stream is healthy.
    let status = withdrawn(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("evidence_expired"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::EvidenceExpired))
    );
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sink_refusal_keeps_the_previous_generation() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    streaming(&handle, 1).await;
    sink.reject_activations(Some(TransportError::KeyPairMismatch));
    api.push_snapshot(snapshot(
        &td,
        &[&td.issue_svid(GW, Duration::from_secs(600))],
    ));
    let status = handle
        .wait_for(WAIT, |s| {
            s.last_error.as_deref() == Some("key_pair_mismatch")
        })
        .await
        .unwrap();
    assert_eq!(status.generation, Some(1));
    assert_eq!(activated(&sink.events()).len(), 1);
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_spiffe_outage_stream_error_is_survived_within_bounds_and_reconnects() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(30)), sink.clone());
    streaming(&handle, 1).await;

    api.push_error(opensesame_spiffe_source::fake::Status::unavailable(
        "agent restarting",
    ));
    let status = streaming(&handle, 2).await;
    assert!(status.connections >= 2, "{status:?}");
    assert!(status.outage_since.is_none());
    assert!(
        !sink
            .events()
            .iter()
            .any(|e| matches!(e, SinkEvent::Withdrawn(_))),
        "a transient error inside the bound withdraws nothing: {:?}",
        sink.events()
    );

    api.close_streams();
    streaming(&handle, 3).await;
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_spiffe_outage_socket_gone_withdraws_at_max_stale_then_recovers_on_return() {
    let dir = tempfile::Builder::new()
        .prefix("os-spiffe-")
        .tempdir()
        .unwrap();
    let api = FakeWorkloadApi::start_at(dir.path());
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let cfg = config(&api, Duration::from_millis(400));
    let handle = SpiffeSource::start(cfg, sink.clone());
    streaming(&handle, 1).await;

    api.shutdown().await;
    let status = handle
        .wait_for(WAIT, |s| s.phase == SourcePhase::Outage)
        .await
        .unwrap();
    let retain_until = status.retain_until.expect("bounded retention");
    let outage_since = status.outage_since.expect("outage start");
    assert!(retain_until <= outage_since + chrono::Duration::milliseconds(400));
    assert!(
        retain_until < status.not_after.unwrap(),
        "max_stale is shorter than not_after"
    );

    let status = withdrawn(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("evidence_expired"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::EvidenceExpired))
    );

    // The agent comes back at the same socket: bounded backoff reconnects.
    let again = FakeWorkloadApi::start_at(dir.path());
    again.push_snapshot(snapshot(&td, &[&gateway]));
    let status = streaming(&handle, 2).await;
    assert!(status.connections >= 2);
    handle.stop().await;
    again.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rotation_same_identity_new_key_is_a_new_generation_without_withdrawal() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let v1 = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&v1]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    streaming(&handle, 1).await;
    let v2 = td.issue_svid(GW, Duration::from_secs(600));
    api.push_snapshot(snapshot(&td, &[&v2]));
    streaming(&handle, 2).await;
    let acts = activated(&sink.events());
    assert_eq!(acts.len(), 2);
    assert_eq!(acts[0].1, acts[1].1, "same canonical identity");
    assert_ne!(acts[0].2, acts[1].2, "new key, new leaf");
    assert!(!sink
        .events()
        .iter()
        .any(|e| matches!(e, SinkEvent::Withdrawn(_))));
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_identity_issued_means_no_generation_and_no_fallback() {
    let api = FakeWorkloadApi::start();
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    tokio::time::sleep(Duration::from_millis(400)).await;
    let status = handle.current();
    assert_ne!(status.phase, SourcePhase::Streaming);
    assert_eq!(status.generation, None);
    assert_eq!(status.last_error.as_deref(), Some("workload_api_transport"));
    assert!(sink.events().is_empty(), "{:?}", sink.events());
    assert_eq!(
        status.credential_status(chrono::Utc::now()),
        opensesame_domain::CredentialStatus::Unconfigured
    );
    handle.stop().await;
}
