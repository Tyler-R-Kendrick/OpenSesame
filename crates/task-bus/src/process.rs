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
/// drain, handle, and publish a failed event back so it is seen again.
///
/// # Errors
///
/// When the drain fails, or a failed event cannot be put back.
pub async fn requeue_on_failure<B: TaskBus + ?Sized>(
    bus: &B,
    max: usize,
    handler: &dyn EventHandler,
) -> anyhow::Result<ProcessReport> {
    let mut report = ProcessReport::default();
    for event in bus.drain(max).await? {
        if handler.handle(&event).await.is_err() {
            bus.publish(event).await?;
            report.record(Disposition::Retry);
        } else {
            report.record(Disposition::Acked);
        }
    }
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
