//! Delivery semantics on the real server (`local-dev.conf`, plaintext
//! loopback, where the Host provisions on connect): idempotent publish,
//! handle-then-ack with nak redelivery, poison messages terminated, and
//! provisioning that converges a stream an older release created.

use super::live_harness::{enabled, free_port, Server};
use super::*;
use crate::process::{EventHandler, ProcessReport};
use crate::{Redelivery, StreamLimits};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn local_server() -> Server {
    let port = free_port();
    Server::start_with_args(
        "local-dev.conf",
        &[("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}"))],
        &[
            "-a".into(),
            "127.0.0.1".into(),
            "-p".into(),
            port.to_string(),
        ],
    )
}

fn url(server: &Server) -> String {
    format!("nats://127.0.0.1:{}", server.port)
}

fn host_config(server: &Server) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        nats_url: url(server),
        fetch_expires: Duration::from_millis(400),
        redelivery: Redelivery {
            nak_delay: Duration::from_millis(200),
            ..Redelivery::default()
        },
        ..NatsJetStreamConfig::default()
    }
}

fn event(id: &str) -> BusEvent {
    BusEvent::cloud_event(id, "opensesame/test", "work.item", "now", json!({"n": id}))
}

/// Fails the first `failures` calls, then succeeds.
struct Flaky {
    failures: usize,
    calls: AtomicUsize,
}

#[async_trait]
impl EventHandler for Flaky {
    async fn handle(&self, _event: &BusEvent) -> anyhow::Result<()> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        anyhow::ensure!(n >= self.failures, "transient");
        Ok(())
    }
}

async fn process_until(
    bus: &NatsJetStreamTaskBus,
    handler: &Flaky,
    done: impl Fn(&ProcessReport) -> bool,
) -> ProcessReport {
    let mut total = ProcessReport::default();
    for _ in 0..20 {
        let pass = bus.process(10, handler).await.expect("process");
        total.handled += pass.handled;
        total.retried += pass.retried;
        total.rejected += pass.rejected;
        if done(&total) {
            break;
        }
    }
    total
}

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn a_republished_event_is_stored_once() {
    if !enabled() {
        return;
    }
    let server = local_server();
    let bus = NatsJetStreamTaskBus::connect(host_config(&server))
        .await
        .expect("connect");
    // The outbox drain published, then failed to mark the row, then
    // published the same row again.
    bus.publish(event("outbox-1")).await.expect("first");
    bus.publish(event("outbox-1")).await.expect("retry");
    bus.publish(event("outbox-2")).await.expect("second row");
    let drained = bus.drain(10).await.expect("drain");
    let ids: Vec<_> = drained.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["outbox-1", "outbox-2"], "deduplicated by Nats-Msg-Id");
}

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn a_failed_handler_is_redelivered_not_lost() {
    if !enabled() {
        return;
    }
    let server = local_server();
    let bus = NatsJetStreamTaskBus::connect(host_config(&server))
        .await
        .expect("connect");
    bus.publish(event("job-1")).await.expect("publish");
    let handler = Flaky {
        failures: 2,
        calls: AtomicUsize::new(0),
    };
    let total = process_until(&bus, &handler, |r| r.handled == 1).await;
    assert_eq!(total.retried, 2, "two naks before success: {total:?}");
    assert_eq!(total.handled, 1);
    let info = bus.consumer_info().await.expect("info");
    assert_eq!(info.num_ack_pending, 0);
    assert_eq!(info.num_pending, 0);
}

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn a_poison_message_is_terminated_and_does_not_block_the_consumer() {
    if !enabled() {
        return;
    }
    let server = local_server();
    let bus = NatsJetStreamTaskBus::connect(host_config(&server))
        .await
        .expect("connect");
    let raw = async_nats::connect(url(&server)).await.expect("raw client");
    let js = jetstream::new(raw);
    js.publish("opensesame.events.work.item", "not json".into())
        .await
        .expect("publish")
        .await
        .expect("ack");
    bus.publish(event("after-poison")).await.expect("publish");

    let drained = bus
        .drain(10)
        .await
        .expect("a poison message is not an error");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].id, "after-poison");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let info = bus.consumer_info().await.expect("info");
    assert_eq!(
        info.num_ack_pending, 0,
        "terminated, not awaiting redelivery"
    );
    assert_eq!(info.num_redelivered, 0);
}

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn provisioning_converges_a_stream_an_older_release_created() {
    if !enabled() {
        return;
    }
    let server = local_server();
    let raw = async_nats::connect(url(&server)).await.expect("raw client");
    let js = jetstream::new(raw);
    // What `get_or_create_stream` with default limits used to leave behind.
    js.create_stream(async_nats::jetstream::stream::Config {
        name: DEFAULT_STREAM_NAME.into(),
        subjects: vec!["opensesame.events.>".into()],
        ..Default::default()
    })
    .await
    .expect("legacy stream")
    .create_consumer(async_nats::jetstream::consumer::pull::Config {
        durable_name: Some(DEFAULT_CONSUMER_NAME.into()),
        ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
        ..Default::default()
    })
    .await
    .expect("legacy durable (unlimited redelivery)");

    let bus = NatsJetStreamTaskBus::connect(host_config(&server))
        .await
        .expect("connect");
    let limits = StreamLimits::default();
    let mut stream = js.get_stream(DEFAULT_STREAM_NAME).await.expect("stream");
    let config = stream.info().await.expect("info").config.clone();
    assert_eq!(config.max_age, limits.max_age);
    assert_eq!(config.max_bytes, limits.max_bytes);
    assert_eq!(config.duplicate_window, limits.duplicate_window);
    let consumer = bus.consumer_info().await.expect("consumer");
    assert_eq!(
        consumer.config.max_deliver,
        Redelivery::default().max_deliver
    );
}
