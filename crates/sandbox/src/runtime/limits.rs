//! The store limiter, and the epoch ticker that makes deadlines real.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use wasmtime::{Engine, ResourceLimiter};

/// How often the ticker advances the engine epoch. A run's deadline is
/// rounded up to a whole number of ticks, so this is also the granularity
/// of "deadline exceeded".
pub const EPOCH_TICK: Duration = Duration::from_millis(10);

/// Per-run resource limiter.
///
/// Wasmtime's own `StoreLimits` would do the enforcing, but not the
/// reporting: a refused `memory.grow` is indistinguishable from a guest
/// that chose not to grow. Recording the refusal lets a failed
/// instantiation be reported as [`crate::SandboxError::MemoryLimit`] rather
/// than as an opaque runtime error.
#[derive(Debug)]
pub struct GuestLimiter {
    max_memory_bytes: usize,
    max_table_elements: usize,
    memory_refused: bool,
    table_refused: bool,
}

impl GuestLimiter {
    /// A limiter for one run.
    #[must_use]
    pub const fn new(max_memory_bytes: usize, max_table_elements: usize) -> Self {
        Self {
            max_memory_bytes,
            max_table_elements,
            memory_refused: false,
            table_refused: false,
        }
    }

    /// Whether this run was ever refused memory or table growth.
    #[must_use]
    pub const fn hit_a_limit(&self) -> bool {
        self.memory_refused || self.table_refused
    }
}

impl ResourceLimiter for GuestLimiter {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.max_memory_bytes {
            self.memory_refused = true;
            return Ok(false);
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.max_table_elements {
            self.table_refused = true;
            return Ok(false);
        }
        Ok(true)
    }

    fn instances(&self) -> usize {
        1
    }

    fn tables(&self) -> usize {
        1
    }

    fn memories(&self) -> usize {
        1
    }
}

/// Advances the engine epoch on a background thread so an epoch deadline is
/// a wall-clock deadline rather than a counter nobody increments.
///
/// Holds a weak reference: the ticker never keeps an engine alive, and stops
/// itself when the engine is dropped.
#[derive(Debug)]
pub struct EpochTicker {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl EpochTicker {
    /// Start ticking for `engine`.
    #[must_use]
    pub fn spawn(engine: &Engine) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let weak = engine.weak();
        let handle = std::thread::Builder::new()
            .name("sandbox-epoch".into())
            .spawn(move || tick_until_stopped(&flag, &weak))
            .ok();
        Self { stop, handle }
    }
}

/// Tick until asked to stop, or until the engine goes away.
fn tick_until_stopped(stop: &AtomicBool, engine: &wasmtime::EngineWeak) {
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(EPOCH_TICK);
        let Some(engine) = engine.upgrade() else {
            return;
        };
        engine.increment_epoch();
    }
}

impl Drop for EpochTicker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Deadline expressed in epoch ticks, rounded up, never zero.
#[must_use]
pub fn deadline_ticks(deadline: Duration) -> u64 {
    let ticks = deadline.as_millis().div_ceil(EPOCH_TICK.as_millis()).max(1);
    u64::try_from(ticks).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{deadline_ticks, GuestLimiter, EPOCH_TICK};
    use std::time::Duration;
    use wasmtime::ResourceLimiter;

    #[test]
    fn a_deadline_is_always_at_least_one_tick() {
        assert_eq!(deadline_ticks(Duration::ZERO), 1);
        assert_eq!(deadline_ticks(Duration::from_millis(1)), 1);
        assert_eq!(deadline_ticks(EPOCH_TICK), 1);
    }

    #[test]
    fn a_deadline_rounds_up_so_a_run_is_never_cut_short() {
        // 25ms of budget at a 10ms tick must not become 20ms.
        assert_eq!(deadline_ticks(Duration::from_millis(25)), 3);
        assert_eq!(deadline_ticks(Duration::from_secs(5)), 500);
    }

    #[test]
    fn the_limiter_refuses_growth_past_the_cap_and_remembers_it() {
        let mut limiter = GuestLimiter::new(128 * 1024, 16);
        assert!(!limiter.hit_a_limit());
        assert!(limiter
            .memory_growing(0, 64 * 1024, None)
            .expect("under the cap"));
        assert!(!limiter.hit_a_limit());
        assert!(!limiter
            .memory_growing(64 * 1024, 256 * 1024, None)
            .expect("over the cap is a refusal, not an error"));
        assert!(limiter.hit_a_limit());
    }

    #[test]
    fn table_growth_is_capped_too() {
        let mut limiter = GuestLimiter::new(usize::MAX, 4);
        assert!(limiter.table_growing(0, 4, None).expect("at the cap"));
        assert!(!limiter.table_growing(4, 5, None).expect("past the cap"));
        assert!(limiter.hit_a_limit());
    }
}
