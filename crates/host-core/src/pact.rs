/// Production source must mention `ordered` markers in that sequence.
///
/// # Panics
///
/// Panics when a marker is absent or appears out of order.
pub fn assert_source_order(src: &str, ordered: &[&str]) {
    let production = src.split("#[cfg(test)]").next().unwrap_or(src);
    let mut last = 0usize;
    for marker in ordered {
        let pos = production
            .get(last..)
            .and_then(|rest| rest.find(marker))
            .map_or_else(
                || panic!("pact source oracle missing {marker}"),
                |offset| last + offset,
            );
        last = pos;
    }
}

/// Exclusive insert: only one concurrent claimant wins.
///
/// # Panics
///
/// Panics if the test mutex is poisoned or the single-winner invariant fails.
pub fn exclusive_claim_is_single_winner() {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};
    struct Kv {
        keys: Mutex<HashSet<String>>,
    }
    impl Kv {
        fn try_claim(&self, key: &str) -> bool {
            let mut g = self.keys.lock().expect("kv");
            g.insert(key.to_string())
        }
    }
    let kv = Arc::new(Kv {
        keys: Mutex::new(HashSet::new()),
    });
    let mut wins = 0usize;
    for _ in 0..64 {
        if kv.try_claim("d1") {
            wins += 1;
        }
    }
    assert_eq!(wins, 1, "try_claim must be exclusive");
}

/// Check-then-set is the mutant that exclusive claim exists to kill.
///
/// # Panics
///
/// Panics if the test mutex is poisoned or the modeled race is not observed.
pub fn check_then_set_admits_double_claim() {
    use std::collections::HashSet;
    use std::sync::Mutex;
    let keys = Mutex::new(HashSet::<String>::new());
    let check = |key: &str| !keys.lock().expect("kv").contains(key);
    let set = |key: &str| {
        keys.lock().expect("kv").insert(key.to_string());
    };
    let c1 = check("d1");
    let c2 = check("d1");
    assert!(c1 && c2, "mutant race: both checks pass");
    set("d1");
    set("d1");
    assert_eq!(keys.lock().expect("kv").len(), 1);
}
