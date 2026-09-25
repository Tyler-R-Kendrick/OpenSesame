//! Handle-then-acknowledge consumption for [`crate::TaskBus::process`].
//!
//! [`crate::TaskBus::drain`] hands events over already acknowledged: right
//! for a *wake* (the outbox is re-read anyway), wrong for *work*, where a
//! crash between the ack and the handler loses the event. `process` runs the
//! handler first and settles each delivery by what it returned.

use crate::{BusEvent, TaskBus};
use async_trait::async_trait;

/// One consumer's work for a single event.
#[async_trait]
pub trait EventHandler: Send + Sync {
    /// `Ok` acknowledges the event; `Err` asks for it again later.
    ///
    /// # Errors
    ///
    /// Any failure the handler wants retried. Handlers must be idempotent:
    /// delivery is at least once.
    async fn handle(&self, event: &BusEvent) -> anyhow::Result<()>;
}

/// What happened to one delivered message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Handled; acknowledged.
    Acked,
    /// The handler failed; delivered again later.
    Retry,
    /// Not a `BusEvent`; terminated so it is never redelivered.
    Rejected,
}

/// Counts from one [`crate::TaskBus::process`] pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProcessReport {
    pub handled: usize,
    pub retried: usize,
    pub rejected: usize,
    /// Of `retried`, failures on their last allowed delivery: the bus will
    /// not deliver them again, so only their outbox can.
    pub exhausted: usize,
}

impl ProcessReport {
    /// Record one disposition.
    pub fn record(&mut self, disposition: Disposition) {
        match disposition {
            Disposition::Acked => self.handled += 1,
            Disposition::Retry => self.retried += 1,
            Disposition::Rejected => self.rejected += 1,
        }
    }

    /// Messages this pass received, whatever became of them.
    #[must_use]
    pub fn received(&self) -> usize {
        self.handled + self.retried + self.rejected
    }
}

/// The default `process` for a bus without per-message acknowledgement:
/// drain, handle, and publish a failed event back so it is seen again. It
/// has no delay and no delivery bound, so it suits the in-memory bus of
/// development and tests, not a production transport.
///
/// # Errors
///
/// When the drain fails, or a failed event cannot be put back. Every other
/// drained event is still handled first: one failed re-publish never drops
/// the rest of the batch.
pub async fn requeue_on_failure<B: TaskBus + ?Sized>(
    bus: &B,
    max: usize,
    handler: &dyn EventHandler,
) -> anyhow::Result<ProcessReport> {
    let mut report = ProcessReport::default();
    let mut lost = Vec::new();
    for event in bus.drain(max).await? {
        if handler.handle(&event).await.is_ok() {
            report.record(Disposition::Acked);
            continue;
        }
        let id = event.id.clone();
        if let Err(error) = bus.publish(event).await {
            tracing::error!(event_id = %id, %error, "failed TaskBus event could not be put back");
            lost.push(id);
        }
        report.record(Disposition::Retry);
    }
    anyhow::ensure!(
        lost.is_empty(),
        "{} failed event(s) could not be put back: {}",
        lost.len(),
        lost.join(", ")
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::InMemoryTaskBus;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    fn event(id: &str) -> BusEvent {
        BusEvent::cloud_event(id, "s", "work.item", "now", json!({}))
    }

    #[tokio::test]
    async fn a_failed_event_is_seen_again_not_lost() {
        let bus = InMemoryTaskBus::default();
        bus.publish(event("a")).await.unwrap();
        let handler = Flaky {
            failures: 1,
            calls: AtomicUsize::new(0),
        };
        let first = bus.process(10, &handler).await.unwrap();
        assert_eq!((first.handled, first.retried), (0, 1));
        let second = bus.process(10, &handler).await.unwrap();
        assert_eq!((second.handled, second.retried), (1, 0));
        assert_eq!(bus.process(10, &handler).await.unwrap().received(), 0);
    }

    /// Drains what it was given; refuses every publish.
    struct NoRepublish(std::sync::Mutex<Vec<BusEvent>>);

    #[async_trait]
    impl TaskBus for NoRepublish {
        async fn publish(&self, _event: BusEvent) -> anyhow::Result<()> {
            anyhow::bail!("publish refused")
        }
        async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>> {
            let mut held = self.0.lock().unwrap();
            let n = max.min(held.len());
            Ok(held.drain(..n).collect())
        }
    }

    /// Fails exactly the event with this id.
    struct FailsOn(&'static str, AtomicUsize);

    #[async_trait]
    impl EventHandler for FailsOn {
        async fn handle(&self, event: &BusEvent) -> anyhow::Result<()> {
            self.1.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(event.id != self.0, "fails");
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_failed_put_back_still_handles_the_rest_of_the_batch() {
        let bus = NoRepublish(std::sync::Mutex::new(vec![
            event("a"),
            event("b"),
            event("c"),
        ]));
        let handler = FailsOn("a", AtomicUsize::new(0));
        let error = bus.process(10, &handler).await.unwrap_err();
        assert_eq!(
            handler.1.load(Ordering::SeqCst),
            3,
            "b and c were still handled"
        );
        assert!(error.to_string().contains('a'), "{error}");
    }

    #[tokio::test]
    async fn unavailable_bus_fails_process_too() {
        let bus = crate::UnavailableTaskBus::new("down");
        let handler = Flaky {
            failures: 0,
            calls: AtomicUsize::new(0),
        };
        assert!(bus.process(1, &handler).await.is_err());
    }
}
