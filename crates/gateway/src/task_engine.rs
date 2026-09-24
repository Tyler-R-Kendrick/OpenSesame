//! Shared in-memory task access engine for Host API routes.
//!
//! The store synchronizes itself, so the engine is shared behind a plain `Arc`:
//! wrapping it in a `Mutex` would forbid holding it across the `.await` in the
//! frozen-intent invoke path.
use opensesame_task_access::{InMemoryTaskStore, TaskAccessEngine};
use std::sync::Arc;

pub type SharedTaskEngine = Arc<TaskAccessEngine<InMemoryTaskStore>>;

pub fn new_task_engine() -> SharedTaskEngine {
    Arc::new(TaskAccessEngine::new(InMemoryTaskStore::new()))
}
