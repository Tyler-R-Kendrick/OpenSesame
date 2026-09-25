//! `JetStream` delivery semantics: what the stream keeps, how often a
//! consumer redelivers, how a publish is made idempotent, and what happens
//! to one delivered message.
//!
//! - **Publish is idempotent.** Every event goes out with `Nats-Msg-Id` set
//!   to its `CloudEvents` `id`, so an outbox drain that published and then
//!   failed to mark the row is deduplicated by the stream inside
//!   [`StreamLimits::duplicate_window`] instead of delivering twice.
//!   `Nats-Expected-Stream` makes a subject captured by some other stream a
//!   publish error rather than a silent misroute.
//! - **The stream is bounded.** Postgres / `SQLite` outboxes stay the source
//!   of truth (ADR 0010), so the bus keeps a bounded window, discarding the
//!   oldest first; a consumer that falls behind it is caught up by the
//!   outbox tick, never by an unbounded log.
//! - **Redelivery is bounded.** A consumer acks after its handler succeeds
//!   ([`crate::TaskBus::process`], server-confirmed), naks with a delay that
//!   doubles per delivery when it fails (about ten minutes across the default
//!   eight deliveries), and terminates a payload that is not a `BusEvent` at
//!   all — a poison message is never redelivered forever. An event that
//!   spends its last delivery is logged and counted as exhausted; the outbox
//!   it came from stays the record (ADR 0010).
//! - **Provisioning fills gaps, never overrides.** A stream or durable an
//!   older release left unbounded gets the default limits; anything an
//!   operator set (replicas, storage, larger limits) is kept.

use crate::nats::NatsJetStreamConfig;
use crate::process::{Disposition, EventHandler, ProcessReport};
use crate::BusEvent;
use async_nats::jetstream::{
    self,
    consumer::{self, pull, FromConsumer},
    message::PublishMessage,
    stream, AckKind,
};
use bytes::Bytes;
use futures::StreamExt;
use std::time::Duration;

/// Retention of the event stream. The defaults bound a wake/drain bus, not a
/// ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamLimits {
    /// Oldest message kept.
    pub max_age: Duration,
    /// Total bytes kept before the oldest are discarded.
    pub max_bytes: i64,
    /// Largest single event accepted (a metadata envelope, never a secret).
    pub max_message_size: i32,
    /// Window in which a repeated `Nats-Msg-Id` is dropped as a duplicate.
    pub duplicate_window: Duration,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_bytes: 1024 * 1024 * 1024,
            max_message_size: 1024 * 1024,
            duplicate_window: Duration::from_secs(120),
        }
    }
}

/// How a durable consumer redelivers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redelivery {
    /// How long a fetched, unacknowledged message waits before redelivery.
    pub ack_wait: Duration,
    /// Deliveries before the server stops trying (a `MAX_DELIVERIES`
    /// advisory is published instead).
    pub max_deliver: i64,
    /// Delay requested when a handler first fails (`-NAK` with delay); it
    /// doubles with each further delivery, up to `max_nak_delay`.
    pub nak_delay: Duration,
    /// Longest delay a failed delivery asks for.
    pub max_nak_delay: Duration,
}

impl Default for Redelivery {
    fn default() -> Self {
        Self {
            ack_wait: Duration::from_secs(30),
            max_deliver: 8,
            nak_delay: Duration::from_secs(5),
            max_nak_delay: Duration::from_secs(5 * 60),
        }
    }
}

/// Stream configuration the provisioning action creates or converges to.
#[must_use]
pub fn stream_config(name: &str, subjects: String, limits: &StreamLimits) -> stream::Config {
    stream::Config {
        name: name.to_owned(),
        subjects: vec![subjects],
        storage: stream::StorageType::File,
        retention: stream::RetentionPolicy::Limits,
        discard: stream::DiscardPolicy::Old,
        max_age: limits.max_age,
        max_bytes: limits.max_bytes,
        max_message_size: limits.max_message_size,
        duplicate_window: limits.duplicate_window,
        ..Default::default()
    }
}

/// What provisioning changes on an existing stream: only the limits an older
/// release left unbounded. Replicas, storage, subjects and any limit an
/// operator set are kept. `None` when nothing needs changing.
#[must_use]
pub fn converge_stream(existing: &stream::Config, limits: &StreamLimits) -> Option<stream::Config> {
    let mut next = existing.clone();
    if next.max_age.is_zero() {
        next.max_age = limits.max_age;
    }
    if next.max_bytes <= 0 {
        next.max_bytes = limits.max_bytes;
    }
    if next.max_message_size <= 0 {
        next.max_message_size = limits.max_message_size;
    }
    if next.duplicate_window.is_zero() {
        next.duplicate_window = limits.duplicate_window;
    }
    (next != *existing).then_some(next)
}

/// What provisioning changes on an existing durable: a bound on redelivery
/// when an older release left it unlimited, and nothing else. `None` when
/// the durable is already bounded (by us or by an operator).
#[must_use]
pub fn converge_consumer(
    existing: &consumer::Config,
    redelivery: &Redelivery,
) -> Option<pull::Config> {
    if existing.max_deliver > 0 {
        return None;
    }
    let mut next = pull::Config::try_from_consumer_config(existing.clone()).ok()?;
    next.max_deliver = redelivery.max_deliver;
    Some(next)
}

/// Durable pull consumer configuration the provisioning action creates.
#[must_use]
pub fn consumer_config(durable: &str, filter: String, redelivery: &Redelivery) -> pull::Config {
    pull::Config {
        durable_name: Some(durable.to_owned()),
        filter_subject: filter,
        ack_policy: jetstream::consumer::AckPolicy::Explicit,
        ack_wait: redelivery.ack_wait,
        max_deliver: redelivery.max_deliver,
        ..Default::default()
    }
}

/// The idempotent publish for one event.
///
/// # Errors
///
/// When the event cannot be serialized.
pub fn publish_message(event: &BusEvent, stream_name: &str) -> anyhow::Result<PublishMessage> {
    Ok(PublishMessage::build()
        .payload(Bytes::from(serde_json::to_vec(event)?))
        .message_id(&event.id)
        .expected_stream(stream_name))
}

/// Delay before delivery `delivered + 1` of a failed message: `nak_delay`
/// doubled per earlier delivery, capped at `max_nak_delay`.
#[must_use]
pub fn retry_delay(redelivery: &Redelivery, delivered: i64) -> Duration {
    let doublings = u32::try_from(delivered.saturating_sub(1).clamp(0, 16)).unwrap_or(16);
    redelivery
        .nak_delay
        .saturating_mul(1 << doublings)
        .min(redelivery.max_nak_delay)
}

/// The acknowledgement a disposition sends for a message on its
/// `delivered`th delivery.
#[must_use]
pub fn ack_kind(disposition: Disposition, redelivery: &Redelivery, delivered: i64) -> AckKind {
    match disposition {
        Disposition::Acked => AckKind::Ack,
        Disposition::Retry => AckKind::Nak(Some(retry_delay(redelivery, delivered))),
        Disposition::Rejected => AckKind::Term,
    }
}

/// Fetch up to `max` deliveries, run `handler` on each, and settle each by
/// its result: ack, nak with delay, or terminate an undecodable payload.
pub(crate) async fn settle_batch(
    consumer: &jetstream::consumer::Consumer<pull::Config>,
    max: usize,
    config: &NatsJetStreamConfig,
    handler: &dyn EventHandler,
) -> anyhow::Result<ProcessReport> {
    let mut report = ProcessReport::default();
    if max == 0 {
        return Ok(report);
    }
    let mut batch = consumer
        .fetch()
        .max_messages(max)
        .expires(config.fetch_expires)
        .messages()
        .await?;
    while let Some(msg) = batch.next().await {
        let msg = msg.map_err(|e| anyhow::anyhow!("{e}"))?;
        let Some(event) = decode_or_terminate(&msg, &config.redelivery).await? else {
            report.record(Disposition::Rejected);
            continue;
        };
        let (disposition, exhausted) =
            settle_one(&msg, &event, &config.redelivery, handler).await?;
        report.exhausted += usize::from(exhausted);
        report.record(disposition);
    }
    Ok(report)
}

/// Run `handler` on one decoded delivery and settle it. Returns the
/// disposition and whether a failure spent the message's last delivery.
async fn settle_one(
    msg: &jetstream::Message,
    event: &BusEvent,
    redelivery: &Redelivery,
    handler: &dyn EventHandler,
) -> anyhow::Result<(Disposition, bool)> {
    // Every message in the batch was delivered at once, so its ack_wait
    // started then; restart it now so the ones handled last do not expire
    // (and get delivered to someone else) while they wait.
    msg.ack_with(AckKind::Progress)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let delivered = msg.info().map_or(1, |info| info.delivered);
    let (disposition, exhausted) = match handler.handle(event).await {
        Ok(()) => (Disposition::Acked, false),
        Err(error) if delivered >= redelivery.max_deliver => {
            tracing::error!(event_id = %event.id, event_type = %event.r#type, delivered, %error, "TaskBus handler failed on its last delivery; the server stops redelivering it (MAX_DELIVERIES advisory)");
            (Disposition::Retry, true)
        }
        Err(error) => {
            tracing::warn!(event_id = %event.id, event_type = %event.r#type, delivered, %error, "TaskBus handler failed; nak for redelivery");
            (Disposition::Retry, false)
        }
    };
    // A success is acked with server confirmation (`double_ack`): the event
    // counts as handled only once the server has recorded it, so a crash
    // after "handled" cannot redeliver it. A nak or term needs no
    // confirmation — at worst the message is delivered again.
    if disposition == Disposition::Acked {
        msg.double_ack().await
    } else {
        msg.ack_with(ack_kind(disposition, redelivery, delivered))
            .await
    }
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((disposition, exhausted))
}

/// Decode a delivery, or terminate it: a payload that is not a `BusEvent`
/// will never become one, so redelivering it would only block the consumer.
pub(crate) async fn decode_or_terminate(
    msg: &jetstream::Message,
    redelivery: &Redelivery,
) -> anyhow::Result<Option<BusEvent>> {
    match serde_json::from_slice::<BusEvent>(&msg.payload) {
        Ok(event) => Ok(Some(event)),
        Err(error) => {
            tracing::warn!(subject = %msg.subject, %error, "terminating undecodable TaskBus message");
            msg.ack_with(ack_kind(Disposition::Rejected, redelivery, 1))
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stream_is_bounded_and_deduplicating() {
        let limits = StreamLimits::default();
        let cfg = stream_config("S", "opensesame.events.>".into(), &limits);
        assert_eq!(cfg.discard, stream::DiscardPolicy::Old);
        assert_eq!(cfg.retention, stream::RetentionPolicy::Limits);
        assert!(cfg.max_age > Duration::ZERO, "unbounded age");
        assert!(cfg.max_bytes > 0, "unbounded bytes");
        assert!(cfg.max_message_size > 0, "unbounded message");
        assert_eq!(cfg.duplicate_window, Duration::from_secs(120));
    }

    #[test]
    fn consumer_redelivery_is_bounded_and_explicit() {
        let cfg = consumer_config("d", "f.>".into(), &Redelivery::default());
        assert_eq!(cfg.durable_name.as_deref(), Some("d"));
        assert_eq!(cfg.ack_policy, jetstream::consumer::AckPolicy::Explicit);
        assert!(cfg.max_deliver > 0, "unbounded redelivery");
        assert!(cfg.ack_wait > Duration::ZERO);
    }

    #[test]
    fn publish_carries_the_event_id_as_msg_id_and_the_expected_stream() {
        let event = BusEvent::cloud_event("evt-1", "s", "t", "now", json!({}));
        let msg = publish_message(&event, "OPENSESAME_EVENTS").unwrap();
        let debug = format!("{msg:?}");
        assert!(debug.contains("NatsMessageId"), "{debug}");
        assert!(debug.contains("evt-1"), "{debug}");
        assert!(debug.contains("NatsExpectedStream"), "{debug}");
        assert!(debug.contains("OPENSESAME_EVENTS"), "{debug}");
    }

    #[test]
    fn dispositions_map_to_ack_nak_and_term() {
        let r = Redelivery::default();
        assert!(matches!(ack_kind(Disposition::Acked, &r, 1), AckKind::Ack));
        assert!(matches!(
            ack_kind(Disposition::Retry, &r, 1),
            AckKind::Nak(Some(d)) if d == r.nak_delay
        ));
        assert!(matches!(
            ack_kind(Disposition::Rejected, &r, 1),
            AckKind::Term
        ));
    }

    #[test]
    fn retry_delay_doubles_to_a_cap_and_spans_minutes_not_seconds() {
        let r = Redelivery::default();
        assert_eq!(retry_delay(&r, 1), Duration::from_secs(5));
        assert_eq!(retry_delay(&r, 2), Duration::from_secs(10));
        assert_eq!(retry_delay(&r, 4), Duration::from_secs(40));
        assert_eq!(retry_delay(&r, 7), r.max_nak_delay);
        assert_eq!(retry_delay(&r, i64::MAX), r.max_nak_delay);
        assert_eq!(retry_delay(&r, 0), r.nak_delay);
        let budget: Duration = (1..r.max_deliver).map(|d| retry_delay(&r, d)).sum();
        assert!(budget >= Duration::from_secs(8 * 60), "{budget:?}");
    }

    #[test]
    fn converging_a_stream_fills_unbounded_limits_and_keeps_the_rest() {
        let limits = StreamLimits::default();
        let legacy = stream::Config {
            name: "S".into(),
            subjects: vec!["opensesame.events.>".into()],
            max_bytes: -1,
            max_message_size: -1,
            ..Default::default()
        };
        let next = converge_stream(&legacy, &limits).expect("legacy is converged");
        assert_eq!(next.max_age, limits.max_age);
        assert_eq!(next.max_bytes, limits.max_bytes);
        assert_eq!(next.max_message_size, limits.max_message_size);

        let tuned = stream::Config {
            num_replicas: 3,
            storage: stream::StorageType::Memory,
            max_bytes: 8 * limits.max_bytes,
            ..next.clone()
        };
        assert_eq!(
            converge_stream(&tuned, &limits),
            None,
            "operator tuning is kept"
        );
        assert_eq!(converge_stream(&next, &limits), None, "idempotent");
    }

    #[test]
    fn converging_a_durable_bounds_only_unlimited_redelivery() {
        let r = Redelivery::default();
        let legacy = consumer::Config {
            durable_name: Some("d".into()),
            max_deliver: -1,
            max_ack_pending: 5000,
            ..Default::default()
        };
        let next = converge_consumer(&legacy, &r).expect("legacy is bounded");
        assert_eq!(next.max_deliver, r.max_deliver);
        assert_eq!(next.max_ack_pending, 5000, "operator tuning is kept");
        let tuned = consumer::Config {
            max_deliver: 20,
            ..legacy
        };
        assert!(converge_consumer(&tuned, &r).is_none());
    }
}
