use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BusEvent {
    pub id: String,
    pub specversion: String,
    pub source: String,
    pub r#type: String,
    pub time: String,
    pub data: Value,
}

#[async_trait]
pub trait TaskBus: Send + Sync {
    async fn publish(&self, event: BusEvent) -> anyhow::Result<()>;
    async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>>;
}

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
