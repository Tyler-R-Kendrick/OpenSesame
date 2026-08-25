#![cfg(feature = "concurrency-test")]

use opensesame_proof::{InMemoryReplayCache, ReplayCache};
use shuttle::sync::Arc;

const DEFAULT_ITERATIONS: usize = 1_000;

#[test]
fn same_jti_is_never_accepted_twice() {
    let iterations = std::env::var("SHUTTLE_ITERATIONS").map_or(DEFAULT_ITERATIONS, |raw| {
        raw.parse().expect("SHUTTLE_ITERATIONS must be a usize")
    });
    shuttle::check_random(
        || {
            let cache = Arc::new(InMemoryReplayCache::with_limits(300, 16));
            let a = shuttle::thread::spawn({
                let cache = Arc::clone(&cache);
                move || cache.check_and_record_at("jti-1", 1_000)
            });
            let b = shuttle::thread::spawn({
                let cache = Arc::clone(&cache);
                move || cache.check_and_record_at("jti-1", 1_000)
            });
            let ra = a.join().unwrap();
            let rb = b.join().unwrap();
            let accepted = usize::from(ra.is_ok()) + usize::from(rb.is_ok());
            assert_eq!(
                accepted, 1,
                "exactly one concurrent insert of the same jti may succeed"
            );
        },
        iterations,
    );
}
