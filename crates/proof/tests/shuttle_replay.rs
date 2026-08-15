#![cfg(feature = "concurrency-test")]

use opensesame_proof::{InMemoryReplayCache, ReplayCache};

#[shuttle::test]
fn same_jti_is_never_accepted_twice() {
    let cache = InMemoryReplayCache::with_limits(300, 16);
    let a = shuttle::thread::spawn({
        let cache = &cache;
        move || cache.check_and_record_at("jti-1", 1_000)
    });
    let b = shuttle::thread::spawn({
        let cache = &cache;
        move || cache.check_and_record_at("jti-1", 1_000)
    });
    let ra = a.join().unwrap();
    let rb = b.join().unwrap();
    let ok = usize::from(ra.is_ok()) + usize::from(rb.is_ok());
    assert_eq!(ok, 1, "exactly one concurrent insert of the same jti may succeed");
}
