//! Adversarial-review findings against the proxy, one test per attack: a
//! child that fork-storms the credential tool, one that hides its surrogate
//! in the request method, and a run ended while it is still starting.

mod support;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use opensesame_invoke_through::RefusalCode;
use opensesame_surrogate_proxy::RunSpec;
use support::client::{bearer, request, through_proxy};
use support::{grant, harness, harness_with, Harness, HOST, STATIC};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hostile_child_cannot_run_the_credential_tool_more_than_its_slots_at_once() {
    let h = Arc::new(harness_with(Duration::from_millis(120), None).await);
    let run = Arc::new(h.start("run-storm"));
    let mut tasks = Vec::new();
    for _ in 0..24 {
        let run = Arc::clone(&run);
        tasks.push(tokio::spawn(async move {
            through_proxy(
                &run,
                HOST,
                request("GET", HOST, "/user", &[("authorization", &bearer(&run))]),
            )
            .await
        }));
    }
    let mut ok = 0;
    for task in tasks {
        if task.await.unwrap().is_some_and(|seen| seen.status == 200) {
            ok += 1;
        }
    }
    let peak = h.source.peak.load(Ordering::SeqCst);
    assert!(peak <= 4, "peak {peak} concurrent credential tool runs");
    assert_eq!(ok, 24, "every admitted request is still served, in turn");
    assert_eq!(h.source_calls(), 24);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_that_cannot_get_a_slot_in_time_is_told_to_slow_down() {
    let h = Arc::new(
        harness_with(
            Duration::from_millis(600),
            Some((1, Duration::from_millis(50))),
        )
        .await,
    );
    let run = Arc::new(h.start("run-wait"));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let run = Arc::clone(&run);
        tasks.push(tokio::spawn(async move {
            through_proxy(
                &run,
                HOST,
                request("GET", HOST, "/user", &[("authorization", &bearer(&run))]),
            )
            .await
            .map(|seen| seen.status)
        }));
    }
    let mut statuses = Vec::new();
    for task in tasks {
        statuses.push(task.await.unwrap());
    }
    assert!(statuses.contains(&Some(429)), "{statuses:?}");
    assert!(h.source.peak.load(Ordering::SeqCst) <= 1);
}

#[tokio::test]
async fn a_surrogate_smuggled_in_the_method_to_a_passthrough_host_is_reported_not_forwarded() {
    let h = harness().await;
    let run = h.start_with(
        "run-method",
        &RunSpec {
            grants: vec![grant()],
            passthrough_hosts: vec![STATIC.into()],
            ..RunSpec::default()
        },
    );
    let surrogate = run.surrogates()[0].1.as_str().to_owned();
    let seen = through_proxy(&run, STATIC, request(&surrogate, STATIC, "/x", &[]))
        .await
        .expect("answered");
    assert_eq!(seen.status, 403);
    assert!(h.passthrough.hits().is_empty(), "the request was forwarded");
    let codes = h.refusals.codes();
    assert_eq!(codes.len(), 1, "{codes:?}");
    assert!(matches!(
        codes[0],
        RefusalCode::Misdirected | RefusalCode::Misplaced
    ));
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ending_a_run_that_is_still_starting_leaves_none_of_its_surrogates_live() {
    let h = Arc::new(harness().await);
    for round in 0..40 {
        let id = format!("run-race-{round}");
        let mut spec = RunSpec::default();
        for n in 0..48 {
            let mut g = grant();
            g.env_var = format!("TOKEN_{n}");
            spec.grants.push(g);
        }
        let spec = Arc::new(spec);
        let starter = start_run(&h, &id, &spec);
        let ender = end_run_after(&h, &id, Duration::from_micros(200 * (round % 7)));
        let created = starter.await.unwrap();
        let _ = ender.await.unwrap();
        if !h.runs.is_active(&id) {
            // The registry no longer serves the run, so nothing of it may be
            // left issued: a second end revokes nothing new.
            assert_eq!(
                h.runs.end_run(&id),
                0,
                "round {round}: surrogates outlived the run (created: {created})"
            );
        }
        h.runs.end_run(&id);
    }
}

fn start_run(h: &Arc<Harness>, id: &str, spec: &Arc<RunSpec>) -> tokio::task::JoinHandle<bool> {
    let (h, id, spec) = (Arc::clone(h), id.to_owned(), Arc::clone(spec));
    tokio::task::spawn_blocking(move || {
        let _guard = tokio::runtime::Handle::current();
        h.runs.create_run(&id, &spec).is_ok()
    })
}

fn end_run_after(h: &Arc<Harness>, id: &str, delay: Duration) -> tokio::task::JoinHandle<usize> {
    let (h, id) = (Arc::clone(h), id.to_owned());
    tokio::task::spawn_blocking(move || {
        std::thread::sleep(delay);
        h.runs.end_run(&id)
    })
}
