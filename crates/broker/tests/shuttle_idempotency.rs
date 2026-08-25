//! Schedule exploration of the broker idempotency control flow.
//!
//! SQLite/sqlx cannot run under Shuttle, so this models the same
//! find-intent → find-receipt → insert decision as `Broker::invoke`.

#![cfg(feature = "concurrency-test")]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

struct FakeStore {
    intents: Mutex<HashSet<String>>,
    receipts: Mutex<HashMap<String, u64>>,
    side_effects: AtomicUsize,
}

impl FakeStore {
    fn new() -> Self {
        Self {
            intents: Mutex::new(HashSet::new()),
            receipts: Mutex::new(HashMap::new()),
            side_effects: AtomicUsize::new(0),
        }
    }

    fn existing_result(&self, key: &str) -> Result<u64, &'static str> {
        self.receipts
            .lock()
            .unwrap()
            .get(key)
            .copied()
            .ok_or("idempotency conflict: prior intent has no receipt yet")
    }

    fn invoke(&self, key: &str) -> Result<u64, &'static str> {
        {
            let intents = self.intents.lock().unwrap();
            if intents.contains(key) {
                drop(intents);
                return self.existing_result(key);
            }
        }
        self.intents.lock().unwrap().insert(key.to_string());
        let id = 1;
        self.side_effects.fetch_add(1, Ordering::SeqCst);
        self.receipts.lock().unwrap().insert(key.to_string(), id);
        Ok(id)
    }
}

#[shuttle::test]
fn concurrent_same_key_never_double_executes() {
    let store = FakeStore::new();
    let a = shuttle::thread::spawn({
        let store = &store;
        move || store.invoke("idem-1")
    });
    let b = shuttle::thread::spawn({
        let store = &store;
        move || store.invoke("idem-1")
    });
    let ra = a.join().unwrap();
    let rb = b.join().unwrap();
    let effects = store.side_effects.load(Ordering::SeqCst);
    match (ra, rb) {
        (Ok(x), Ok(y)) => {
            assert_eq!(x, y);
            assert_eq!(effects, 1);
        }
        (Ok(_), Err(_)) | (Err(_), Ok(_)) => {
            assert!(effects <= 1);
        }
        (Err(_), Err(_)) => panic!("both callers failed"),
    }
}
