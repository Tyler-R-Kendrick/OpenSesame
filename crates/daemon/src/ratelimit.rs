//! In-memory token buckets for the daemon's budgeted routes — discovery,
//! promotion, invoke-through, mint and fill (ADR 0048: discovery is a
//! disclosure surface, so even an authorized caller gets a budget).
//!
//! One bucket per caller key: the attested UID on the Unix socket, a single
//! shared constant for operator-token callers on TCP (the token is one
//! identity), and the whois login/node on the tailnet listener. Process-local
//! by design — the daemon is a single-process local agent, so a map plus a
//! mutex is the whole state.

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default budget: one discovery every five seconds per caller.
pub const DEFAULT_CAPACITY: f64 = 1.0;
pub const DEFAULT_REFILL_PER_SEC: f64 = 0.2;

/// Bound on tracked callers so a flood of distinct keys cannot grow the map
/// without limit.
const MAX_BUCKETS: usize = 4096;

/// Who a bucket belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RateKey {
    /// UDS caller, keyed by kernel-attested UID.
    Uid(u32),
    /// Any operator-token caller on TCP shares this one bucket.
    TcpOperator,
    /// Tailnet caller, keyed by whois login or node name.
    #[cfg(all(unix, feature = "tailscale"))]
    Tailnet(String),
    /// A browser extension, keyed by its exact extension origin
    /// (`chrome-extension://…`), on the fill routes (ADR 0150 §6.4).
    Extension(String),
    /// Every plugin-pairing exchange shares one bucket, whatever origin it
    /// claims (ADR 0150 §7): a caller outside a browser can claim any.
    PluginPairing,
    /// Every fill-pairing request from a caller that has not proved a token
    /// shares this bucket (ADR 0150 §6.4). Its `Origin` is a claim any local
    /// process can make, so it must not spend the budget of the paired
    /// extension that origin names.
    UnpairedFill,
    /// Every tailnet pairing exchange shares one bucket, whatever origin it
    /// claims (ADR 0169 §3).
    TailnetPairing,
    /// One tailnet bearer's changes, keyed by its pairing id (ADR 0169 §4).
    TailnetChange(String),
}

/// 429 with a `Retry-After` the caller can actually wait on.
pub fn rate_limited(retry_after: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({"error": "rate_limited", "retry_after": retry_after})),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct TokenBucket {
    capacity: f64,
    refill_per_sec: f64,
    buckets: Mutex<HashMap<RateKey, Bucket>>,
}

impl TokenBucket {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            capacity,
            refill_per_sec,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Consume one token for `key`. `Err(retry_after_secs)` when the bucket is
    /// empty — the caller gets a 429 with that many seconds to wait.
    pub fn check(&self, key: RateKey) -> Result<(), u64> {
        let mut buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        if buckets.len() >= MAX_BUCKETS {
            buckets.retain(|_, b| now.duration_since(b.last) < Duration::from_secs(3600));
        }
        // Idle buckets are gone; if a flood of distinct keys inside the hour
        // still fills the map, the least recently used one goes, so the bound
        // holds whatever the callers send.
        while buckets.len() >= MAX_BUCKETS && !buckets.contains_key(&key) {
            let Some(oldest) = buckets
                .iter()
                .min_by_key(|(_, bucket)| bucket.last)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            buckets.remove(&oldest);
        }
        let bucket = buckets.entry(key).or_insert(Bucket {
            tokens: self.capacity,
            last: now,
        });
        let elapsed = now.duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = (1.0 - bucket.tokens) / self.refill_per_sec;
            let retry_after = Duration::try_from_secs_f64(wait.ceil().max(1.0))
                .map_or(u64::MAX, |duration| duration.as_secs());
            Err(retry_after)
        }
    }
}

impl Default for TokenBucket {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY, DEFAULT_REFILL_PER_SEC)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_call_passes_second_is_limited() {
        let bucket = TokenBucket::default();
        assert!(bucket.check(RateKey::Uid(1000)).is_ok());
        let retry = bucket
            .check(RateKey::Uid(1000))
            .expect_err("second call within the window must be limited");
        assert!((1..=5).contains(&retry), "retry_after {retry}");
    }

    #[test]
    fn keys_are_isolated() {
        let bucket = TokenBucket::default();
        assert!(bucket.check(RateKey::Uid(1000)).is_ok());
        // A different UID still has a full bucket.
        assert!(bucket.check(RateKey::Uid(1001)).is_ok());
        // And the TCP-constant bucket is separate again.
        assert!(bucket.check(RateKey::TcpOperator).is_ok());
        assert!(bucket.check(RateKey::TcpOperator).is_err());
    }

    #[test]
    fn a_flood_of_distinct_keys_cannot_grow_the_map_past_its_bound() {
        let bucket = TokenBucket::default();
        for n in 0..(MAX_BUCKETS * 3) {
            let _ = bucket.check(RateKey::Extension(format!("chrome-extension://{n}")));
        }
        let held = bucket.buckets.lock().unwrap().len();
        assert!(held <= MAX_BUCKETS, "{held} buckets tracked");
    }

    #[test]
    fn tokens_refill() {
        let bucket = TokenBucket::new(1.0, 1000.0); // 1 token per millisecond
        assert!(bucket.check(RateKey::TcpOperator).is_ok());
        assert!(bucket.check(RateKey::TcpOperator).is_err());
        std::thread::sleep(Duration::from_millis(2));
        assert!(bucket.check(RateKey::TcpOperator).is_ok());
    }
}
