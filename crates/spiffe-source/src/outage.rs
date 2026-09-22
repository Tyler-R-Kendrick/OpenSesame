//! Bounded retention during a Workload API outage, and jittered reconnect
//! backoff. Pure: no clocks, no sockets, no tasks.
//!
//! Existing valid material may only survive a transient source outage within
//! the explicitly configured bounds: the generation's own `not_after`, or a
//! shorter `max_stale` counted from the moment the stream broke. Nothing here
//! can extend a lifetime.

use std::time::Duration;

use chrono::{DateTime, Utc};

/// Exponential backoff with bounded jitter for reconnecting to the Workload
/// API. Every delay lies in `[base - jitter, base + jitter]` where `base` is
/// `initial * 2^attempt` capped at `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPolicy {
    /// First delay.
    pub initial: Duration,
    /// Longest base delay; jitter may add up to `jitter_permille / 1000` of it.
    pub max: Duration,
    /// Jitter as a fraction of the base delay, in permille (0..=1000).
    pub jitter_permille: u32,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            initial: Duration::from_millis(250),
            max: Duration::from_secs(15),
            jitter_permille: 250,
        }
    }
}

impl ReconnectPolicy {
    /// Reject impossible policies (zero delays, jitter over 100%).
    ///
    /// # Errors
    /// Returns a non-secret description of the first invalid field.
    pub fn validate(&self) -> Result<(), String> {
        if self.initial.is_zero() {
            return Err("reconnect.initial must be > 0".into());
        }
        if self.max < self.initial {
            return Err("reconnect.max must be >= reconnect.initial".into());
        }
        if self.jitter_permille > 1000 {
            return Err("reconnect.jitter_permille must be <= 1000".into());
        }
        Ok(())
    }
}

/// Backoff state for one connection loop. Deterministic given its seed so the
/// schedule is testable; the seed itself is not security-relevant.
#[derive(Debug, Clone)]
pub struct Backoff {
    policy: ReconnectPolicy,
    attempt: u32,
    state: u64,
}

impl Backoff {
    /// Start at attempt zero with the given jitter seed.
    #[must_use]
    pub const fn new(policy: ReconnectPolicy, seed: u64) -> Self {
        Self {
            policy,
            attempt: 0,
            state: seed | 1,
        }
    }

    /// Delay before the next attempt; advances the attempt counter.
    pub fn next_delay(&mut self) -> Duration {
        let shift = self.attempt.min(31);
        let base = self
            .policy
            .initial
            .checked_mul(1u32 << shift)
            .unwrap_or(self.policy.max)
            .min(self.policy.max);
        self.attempt = self.attempt.saturating_add(1);
        let jitter_span = base.as_nanos() * u128::from(self.policy.jitter_permille) / 1000;
        if jitter_span == 0 {
            return base;
        }
        // xorshift64*: cheap, deterministic, good enough to spread reconnects.
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        let r = self.state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        let offset = u128::from(r) % (jitter_span * 2 + 1);
        let nanos = base.as_nanos() + offset - jitter_span;
        Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
    }

    /// Attempts made since the last reset.
    #[must_use]
    pub const fn attempts(&self) -> u32 {
        self.attempt
    }

    /// A stream delivered a message: the next failure starts over.
    pub const fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// When a generation must be withdrawn during an outage: the earlier of its
/// own `not_after` and `outage_since + max_stale`.
#[must_use]
pub fn stale_deadline(
    not_after: DateTime<Utc>,
    outage_since: DateTime<Utc>,
    max_stale: Duration,
) -> DateTime<Utc> {
    let by_staleness = chrono::Duration::from_std(max_stale)
        .ok()
        .and_then(|d| outage_since.checked_add_signed(d))
        .unwrap_or(not_after);
    not_after.min(by_staleness)
}

/// The moment the current generation stops being usable, given whether the
/// source is currently in an outage.
#[must_use]
pub fn retention_deadline(
    not_after: DateTime<Utc>,
    outage: Option<(DateTime<Utc>, Duration)>,
) -> DateTime<Utc> {
    match outage {
        Some((since, max_stale)) => stale_deadline(not_after, since, max_stale),
        None => not_after,
    }
}

#[cfg(test)]
#[path = "outage_tests.rs"]
mod tests;
