use crate::{BusEvent, TaskBus};
use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Default)]
pub struct InMemoryTaskBus {
    q: Mutex<VecDeque<BusEvent>>,
}

#[async_trait]
impl TaskBus for InMemoryTaskBus {
    async fn publish(&self, event: BusEvent) -> anyhow::Result<()> {
        self.q.lock().unwrap().push_back(event);
        Ok(())
    }

    async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>> {
        let mut q = self.q.lock().unwrap();
        let mut out = Vec::new();
        for _ in 0..max {
            if let Some(e) = q.pop_front() {
                out.push(e);
            } else {
                break;
            }
        }
        Ok(out)
    }
}

/// A bus that refuses every operation with the reason its secure profile
/// could not be established. Installed instead of a fallback so the Host
/// boots, reports the fault and never publishes in the clear.
pub struct UnavailableTaskBus {
    reason: String,
}

impl UnavailableTaskBus {
    #[must_use]
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

#[async_trait]
impl TaskBus for UnavailableTaskBus {
    async fn publish(&self, _event: BusEvent) -> anyhow::Result<()> {
        anyhow::bail!("taskbus_unavailable: {}", self.reason)
    }

    async fn drain(&self, _max: usize) -> anyhow::Result<Vec<BusEvent>> {
        anyhow::bail!("taskbus_unavailable: {}", self.reason)
    }
}
