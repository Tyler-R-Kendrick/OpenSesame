//! Failed sign-in accounting, per normalized email.
//!
//! Each password attempt costs an Argon2id verification, and the password
//! grant is unauthenticated, so an address that keeps failing is refused for
//! the rest of its window before any hash is computed. Unknown addresses are
//! counted exactly like known ones: the limiter must not become a way to tell
//! them apart. A success clears the address's count.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Most addresses tracked at once. When full, expired windows are dropped
/// first and then the oldest window, so memory stays bounded under a flood of
/// made-up addresses.
const CAPACITY: usize = 10_000;

pub struct FailureLimiter {
    max_failures: u32,
    window: Duration,
    windows: Mutex<HashMap<String, (Instant, u32)>>,
}

impl FailureLimiter {
    #[must_use]
    pub fn new(max_failures: u32, window: Duration) -> Self {
        Self {
            max_failures,
            window,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Whether `key` has used up its failures for the current window.
    #[must_use]
    pub fn blocked(&self, key: &str) -> bool {
        let windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        windows.get(key).is_some_and(|(start, count)| {
            start.elapsed() < self.window && *count >= self.max_failures
        })
    }

    pub fn record_failure(&self, key: &str) {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if windows.len() >= CAPACITY && !windows.contains_key(key) {
            self.make_room(&mut windows);
        }
        let entry = windows.entry(key.to_owned()).or_insert((Instant::now(), 0));
        if entry.0.elapsed() >= self.window {
            *entry = (Instant::now(), 0);
        }
        entry.1 = entry.1.saturating_add(1);
    }

    /// Drop expired windows, then the oldest one if the map is still full.
    fn make_room(&self, windows: &mut HashMap<String, (Instant, u32)>) {
        windows.retain(|_, (start, _)| start.elapsed() < self.window);
        if windows.len() < CAPACITY {
            return;
        }
        let oldest = windows
            .iter()
            .min_by_key(|(_, (start, _))| *start)
            .map(|(key, _)| key.clone());
        if let Some(oldest) = oldest {
            windows.remove(&oldest);
        }
    }

    pub fn clear(&self, key: &str) {
        self.windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_refused_after_its_failures_and_cleared_by_success() {
        let limiter = FailureLimiter::new(3, Duration::from_secs(60));
        for _ in 0..2 {
            limiter.record_failure("a@example.com");
        }
        assert!(!limiter.blocked("a@example.com"));
        limiter.record_failure("a@example.com");
        assert!(limiter.blocked("a@example.com"));
        assert!(!limiter.blocked("b@example.com"));
        limiter.clear("a@example.com");
        assert!(!limiter.blocked("a@example.com"));
    }

    #[test]
    fn a_window_expires() {
        let limiter = FailureLimiter::new(1, Duration::from_millis(0));
        limiter.record_failure("a@example.com");
        assert!(!limiter.blocked("a@example.com"));
    }

    #[test]
    fn memory_stays_bounded() {
        let limiter = FailureLimiter::new(1, Duration::from_secs(60));
        for i in 0..CAPACITY + 50 {
            limiter.record_failure(&format!("{i}@example.com"));
        }
        assert!(limiter.windows.lock().unwrap().len() <= CAPACITY);
    }
}
