//! Shared in-memory task access engine for Host API routes.
use opensesame_task_access::{InMemoryTaskStore, TaskAccessEngine};
use std::sync::{Arc, Mutex};

pub type SharedTaskEngine = Arc<Mutex<TaskAccessEngine<InMemoryTaskStore>>>;

pub fn new_task_engine() -> SharedTaskEngine {
    Arc::new(Mutex::new(TaskAccessEngine::new(InMemoryTaskStore::new())))
}
