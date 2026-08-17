//! NATS JetStream adapter behind [`TaskBus`].
//!
//! Stream subjects: `opensesame.events.>` — durable consumer `opensesame-worker`.
//! Auth callout subjects (`opensesame.callout.>`) are intentionally unused here.

use crate::{
    BusEvent, TaskBus, DEFAULT_CONSUMER_NAME, DEFAULT_STREAM_NAME, DEFAULT_SUBJECT_PREFIX,
};
use async_nats::jetstream::{self, consumer::pull, stream};
use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct NatsJetStreamConfig {
    pub nats_url: String,
    pub stream_name: String,
    pub subject_prefix: String,
    pub consumer_name: String,
    /// How long a pull fetch waits when the stream is idle.
    pub fetch_expires: Duration,
}

impl Default for NatsJetStreamConfig {
    fn default() -> Self {
        Self {
            nats_url: "nats://127.0.0.1:4222".into(),
            stream_name: DEFAULT_STREAM_NAME.into(),
            subject_prefix: DEFAULT_SUBJECT_PREFIX.into(),
            consumer_name: DEFAULT_CONSUMER_NAME.into(),
            fetch_expires: Duration::from_secs(1),
        }
    }
}

/// JetStream TaskBus: publish CloudEvents; drain via durable pull consumer.
pub struct NatsJetStreamTaskBus {
    js: jetstream::Context,
    subject_prefix: String,
    consumer: async_nats::jetstream::consumer::Consumer<pull::Config>,
    fetch_expires: Duration,
}

impl NatsJetStreamTaskBus {
    pub async fn connect(config: NatsJetStreamConfig) -> anyhow::Result<Self> {
        let client = async_nats::connect(config.nats_url.as_str()).await?;
        let js = jetstream::new(client);

        let subject_filter = format!("{}.>", config.subject_prefix.trim_end_matches('.'));
        let stream = js
            .get_or_create_stream(stream::Config {
                name: config.stream_name.clone(),
                subjects: vec![subject_filter.clone()],
                ..Default::default()
            })
            .await?;

        let consumer = stream
            .get_or_create_consumer(
                &config.consumer_name,
                pull::Config {
                    durable_name: Some(config.consumer_name.clone()),
                    filter_subject: subject_filter,
                    ack_policy: jetstream::consumer::AckPolicy::Explicit,
                    ..Default::default()
                },
            )
            .await?;

        Ok(Self {
            js,
            subject_prefix: config.subject_prefix,
            consumer,
            fetch_expires: config.fetch_expires,
        })
    }
}

#[async_trait]
impl TaskBus for NatsJetStreamTaskBus {
    async fn publish(&self, event: BusEvent) -> anyhow::Result<()> {
        let subject = event.subject(&self.subject_prefix);
        let payload = Bytes::from(serde_json::to_vec(&event)?);
        self.js.publish(subject, payload).await?.await?;
        Ok(())
    }

    async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>> {
        if max == 0 {
            return Ok(Vec::new());
        }
        let mut batch = self
            .consumer
            .fetch()
            .max_messages(max)
            .expires(self.fetch_expires)
            .messages()
            .await?;

        let mut out = Vec::with_capacity(max);
        while let Some(msg) = batch.next().await {
            let msg = msg.map_err(|e| anyhow::anyhow!("{e}"))?;
            let event: BusEvent = serde_json::from_slice(&msg.payload)?;
            msg.ack().await.map_err(|e| anyhow::anyhow!("{e}"))?;
            out.push(event);
            if out.len() >= max {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use crate::TaskBus;
    use serde_json::json;

    /// Requires a JetStream-enabled NATS at `NATS_URL` (default `nats://127.0.0.1:4222`).
    ///
    /// ```bash
    /// cargo +1.88.0 test -p opensesame-task-bus --features jetstream -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "requires NATS JetStream (set NATS_URL)"]
    async fn jetstream_publish_drain_round_trip() {
        let url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
        let suffix = uuid_lite();
        let config = NatsJetStreamConfig {
            nats_url: url,
            stream_name: format!("OPENSESAME_EVENTS_TEST_{suffix}"),
            subject_prefix: format!("opensesame.events.test.{suffix}"),
            consumer_name: format!("opensesame-worker-test-{suffix}"),
            fetch_expires: Duration::from_secs(2),
        };
        let bus = NatsJetStreamTaskBus::connect(config)
            .await
            .expect("connect NATS");
        let event = BusEvent::cloud_event(
            format!("evt-{suffix}"),
            "opensesame/task-bus-test",
            "test.roundtrip",
            "2026-08-17T00:00:00Z",
            json!({"ok": true}),
        );
        bus.publish(event.clone()).await.expect("publish");
        let drained = bus.drain(10).await.expect("drain");
        assert!(
            drained.iter().any(|e| e.id == event.id),
            "expected published event in drain batch, got {drained:?}"
        );
    }

    fn uuid_lite() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{nanos:x}")
    }
}
