use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use super::*;

fn registry(global: usize, per_org: usize, pending: usize) -> RunRegistry {
    RunRegistry::new(RunLimits {
        global,
        per_org,
        pending,
    })
}

/// A run that holds its slot until released, counting how many hold one.
#[derive(Clone, Default)]
struct Gate {
    open: Arc<Notify>,
    inside: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    done: Arc<AtomicUsize>,
}

impl Gate {
    fn run(&self) -> impl Future<Output = ()> + Send + 'static {
        let gate = self.clone();
        async move {
            let now = gate.inside.fetch_add(1, Ordering::SeqCst) + 1;
            gate.peak.fetch_max(now, Ordering::SeqCst);
            gate.open.notified().await;
            gate.inside.fetch_sub(1, Ordering::SeqCst);
            gate.done.fetch_add(1, Ordering::SeqCst);
        }
    }

    async fn until(&self, what: &str, ready: impl Fn(&Self) -> bool) {
        for _ in 0..400 {
            if ready(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for {what}");
    }
}

#[tokio::test]
async fn runs_beyond_the_global_bound_queue_and_run_in_turn() {
    let registry = registry(2, 8, 64);
    let gate = Gate::default();
    for n in 0..5 {
        registry
            .spawn(&format!("org:{n}"), format!("k{n}"), gate.run())
            .unwrap();
    }
    gate.until("two runs", |g| g.inside.load(Ordering::SeqCst) == 2)
        .await;
    assert_eq!(registry.running(), 2);
    assert_eq!(registry.pending(), 5, "three are queued, holding nothing");
    for _ in 0..5 {
        gate.open.notify_one();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    registry.idle().await;
    assert_eq!(gate.done.load(Ordering::SeqCst), 5);
    assert_eq!(
        gate.peak.load(Ordering::SeqCst),
        2,
        "never more than the bound"
    );
    assert_eq!(registry.running(), 0);
}

#[tokio::test]
async fn one_organization_cannot_take_every_slot() {
    let registry = registry(4, 1, 64);
    let gate = Gate::default();
    for n in 0..3 {
        registry
            .spawn("org:a", format!("a{n}"), gate.run())
            .unwrap();
    }
    registry.spawn("org:b", "b0".into(), gate.run()).unwrap();
    gate.until("one run per organization", |g| {
        g.inside.load(Ordering::SeqCst) == 2
    })
    .await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        gate.inside.load(Ordering::SeqCst),
        2,
        "org:a runs one at a time and org:b is not held behind its queue"
    );
    assert_eq!(registry.pending(), 4);
    for _ in 0..4 {
        gate.open.notify_one();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    registry.idle().await;
    assert_eq!(gate.done.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn a_target_has_one_task_and_the_queue_is_bounded() {
    let registry = registry(1, 1, 2);
    let gate = Gate::default();
    registry
        .spawn("org:a", "a:site".into(), gate.run())
        .unwrap();
    assert_eq!(
        registry.spawn("org:a", "a:site".into(), gate.run()),
        Err(Refused::InFlight)
    );
    registry
        .spawn("org:a", "a:other".into(), gate.run())
        .unwrap();
    assert_eq!(
        registry.spawn("org:a", "a:third".into(), gate.run()),
        Err(Refused::Full)
    );
    assert!(registry.contains("a:site"));
    for _ in 0..2 {
        gate.open.notify_one();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    registry.idle().await;
    // The key is free again once the run has ended.
    registry.spawn("org:a", "a:site".into(), async {}).unwrap();
    registry.idle().await;
}

#[tokio::test]
async fn an_aborted_or_panicking_run_frees_its_slot() {
    let registry = registry(1, 1, 8);
    let gate = Gate::default();
    registry.spawn("org:a", "a:1".into(), gate.run()).unwrap();
    gate.until("the run", |g| g.inside.load(Ordering::SeqCst) == 1)
        .await;
    registry.abort_all();
    registry.idle().await;
    assert_eq!(registry.running(), 0);

    registry
        .spawn("org:a", "a:2".into(), async { panic!("a run that dies") })
        .unwrap();
    registry.idle().await;
    registry.reap();
    registry.spawn("org:a", "a:3".into(), async {}).unwrap();
    registry.idle().await;
    assert_eq!(registry.running(), 0);
}

#[test]
fn a_bound_that_is_not_a_positive_integer_is_ignored() {
    std::env::set_var("OPENSESAME_TEST_BOUND_A", "0");
    std::env::set_var("OPENSESAME_TEST_BOUND_B", "many");
    std::env::set_var("OPENSESAME_TEST_BOUND_C", " 3 ");
    assert_eq!(env_bound("OPENSESAME_TEST_BOUND_A", 7), 7);
    assert_eq!(env_bound("OPENSESAME_TEST_BOUND_B", 7), 7);
    assert_eq!(env_bound("OPENSESAME_TEST_BOUND_C", 7), 3);
    assert_eq!(env_bound("OPENSESAME_TEST_BOUND_UNSET", 7), 7);
}
