//! Deterministic infrastructure-level fault injection ("chaos") for the
//! invoke-through executor's upstream HTTP path (ADR 0048 D6/D7).
//!
//! Every case asserts fail-closed behavior under a hard overall deadline:
//! the call errors, it never panics, it never hangs, and no error surface
//! carries the credential. Faults come from the scripted listener in
//! [`support::fault`] — no randomness, no real network.

mod support;

use std::sync::Arc;
use std::time::Duration;

use opensesame_invoke_through::{
    AuthStyle, EgressRule, InvokeError, InvokeRequest, Invoker, TokenSource,
};
use secrecy::SecretString;
use support::fault::{Fault, FaultListener};

/// Canary credential: any error surface containing it is a leak.
const CANARY: &str = "CANARY-TOKEN-chaos-never-leaks";

/// Hard per-case deadline: a regression that hangs fails fast instead of
/// wedging the suite.
const DEADLINE: Duration = Duration::from_secs(10);

/// Executor timeout for the chaos invoker — short, so a Stall case is fast
/// while still an order of magnitude above the SlowDrip cadence.
const EXECUTOR_TIMEOUT: Duration = Duration::from_millis(300);

fn loopback_invoker() -> Invoker {
    Invoker::with_rules(vec![EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts: &["127.0.0.1"],
        auth: AuthStyle::Bearer,
    }])
    .allow_http_for_tests()
    .with_timeout(EXECUTOR_TIMEOUT)
}

fn request(url: String) -> InvokeRequest {
    InvokeRequest {
        provider_id: "github".into(),
        method: "GET".into(),
        url,
        headers: vec![],
        body: None,
        subject: Some("user:alice".into()),
        actor: Some("agent:chaos".into()),
    }
}

fn canary() -> SecretString {
    SecretString::from(CANARY)
}

/// One brokered call against the fault listener, reduced to its verdict.
async fn run(listener: &FaultListener) -> Result<(), InvokeError> {
    let invoker = loopback_invoker();
    let prepared = invoker
        .preflight(request(format!("{}/zen", listener.url())))
        .unwrap();
    invoker.execute(&canary(), prepared).await.map(|_| ())
}

fn assert_opaque(error: &InvokeError) {
    let rendered = format!("{error} / {error:?}");
    assert!(!rendered.contains(CANARY), "{rendered}");
}

#[tokio::test]
async fn chaos_upstream_reset_mid_request_errors_without_leaking() {
    tokio::time::timeout(DEADLINE, async {
        let listener = FaultListener::spawn(Fault::Reset).await;
        let error = run(&listener)
            .await
            .expect_err("a resetting upstream must fail the call");
        assert!(matches!(error, InvokeError::Transport(_)), "{error:?}");
        assert_opaque(&error);
        assert!(
            listener.connections() >= 1,
            "the fault listener was never reached"
        );
    })
    .await
    .expect("chaos case exceeded its deadline");
}

#[tokio::test]
async fn chaos_upstream_stall_hits_the_executor_timeout() {
    tokio::time::timeout(DEADLINE, async {
        let listener = FaultListener::spawn(Fault::Stall).await;
        let error = run(&listener)
            .await
            .expect_err("a stalled upstream must fail the call");
        assert!(matches!(error, InvokeError::Timeout), "{error:?}");
        assert_opaque(&error);
        assert!(
            listener.connections() >= 1,
            "the fault listener was never reached"
        );
    })
    .await
    .expect("chaos case exceeded its deadline");
}

#[tokio::test]
async fn chaos_upstream_garbage_bytes_error_without_panicking() {
    tokio::time::timeout(DEADLINE, async {
        let listener = FaultListener::spawn(Fault::Garbage).await;
        let error = run(&listener)
            .await
            .expect_err("a garbage-spewing upstream must fail the call");
        assert!(matches!(error, InvokeError::Transport(_)), "{error:?}");
        assert_opaque(&error);
        assert!(
            listener.connections() >= 1,
            "the fault listener was never reached"
        );
    })
    .await
    .expect("chaos case exceeded its deadline");
}

#[tokio::test]
async fn chaos_slow_drip_mid_body_is_never_a_success() {
    tokio::time::timeout(DEADLINE, async {
        let listener = FaultListener::spawn(Fault::SlowDrip).await;
        // The head is valid and promises 64 bytes; the connection dies a
        // few bytes into the body. The executor must not hand the partial
        // body back as a response, and the truncated read is a transport
        // fault — not a response-size violation.
        let error = run(&listener)
            .await
            .expect_err("a truncated drip must never be treated as success");
        assert!(
            matches!(error, InvokeError::Transport(_)),
            "a truncated body is a transport fault, got {error:?}"
        );
        assert_opaque(&error);
        assert!(
            listener.connections() >= 1,
            "the fault listener was never reached"
        );
    })
    .await
    .expect("chaos case exceeded its deadline");
}

/// A source tool that is killed mid-exec (SIGKILL): acquisition fails
/// before any credential exists, so no upstream connection may happen.
struct KilledSource;

impl TokenSource for KilledSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        let status = std::process::Command::new("sh")
            .args(["-c", "kill -9 $$"])
            .status()
            .map_err(|error| InvokeError::TokenUnavailable(format!("spawn: {error}")))?;
        Err(InvokeError::TokenUnavailable(format!(
            "source tool died: {status}"
        )))
    }
}

/// A source tool that exits nonzero, like `gh auth token` logged out.
struct FailingSource;

impl TokenSource for FailingSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        let status = std::process::Command::new("sh")
            .args(["-c", "exit 1"])
            .status()
            .map_err(|error| InvokeError::TokenUnavailable(format!("spawn: {error}")))?;
        Err(InvokeError::TokenUnavailable(format!(
            "source tool exited: {status}"
        )))
    }
}

#[tokio::test]
async fn chaos_failed_acquisition_makes_zero_upstream_connections() {
    tokio::time::timeout(DEADLINE, async {
        // The listener is live and would answer — only the acquisition
        // fence stands between the caller and the wire.
        let listener = FaultListener::spawn(Fault::Reset).await;
        for source in [&KilledSource as &dyn TokenSource, &FailingSource] {
            let invoker = loopback_invoker();
            let error = invoker
                .execute_with_source(source, request(format!("{}/zen", listener.url())))
                .await
                .expect_err("a dead source tool must fail the call");
            assert!(
                matches!(error, InvokeError::TokenUnavailable(_)),
                "{error:?}"
            );
            // The failure surface is a class (signal/exit status), never a
            // credential — and no credential ever existed here.
            assert_opaque(&error);
        }
        assert_eq!(
            listener.connections(),
            0,
            "a call that never acquired a credential reached the upstream"
        );
    })
    .await
    .expect("chaos case exceeded its deadline");
}

#[tokio::test]
async fn chaos_concurrent_faults_all_fail_closed() {
    tokio::time::timeout(DEADLINE, async {
        let reset = FaultListener::spawn(Fault::Reset).await;
        let stall = FaultListener::spawn(Fault::Stall).await;
        let garbage = FaultListener::spawn(Fault::Garbage).await;
        let invoker = Arc::new(loopback_invoker());
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..16 {
            let url = match index % 3 {
                0 => format!("{}/zen", reset.url()),
                1 => format!("{}/zen", stall.url()),
                _ => format!("{}/zen", garbage.url()),
            };
            let invoker = invoker.clone();
            tasks.spawn(async move {
                let prepared = invoker.preflight(request(url)).unwrap();
                invoker.execute(&canary(), prepared).await
            });
        }
        let mut completed = 0;
        while let Some(joined) = tasks.join_next().await {
            // A panicked invocation surfaces as a JoinError and fails here.
            let outcome = joined.expect("a chaos invocation panicked");
            let error = outcome.expect_err("a faulted upstream returned success");
            assert_opaque(&error);
            completed += 1;
        }
        assert_eq!(completed, 16, "an invocation never completed");
        assert!(reset.connections() >= 1);
        assert!(stall.connections() >= 1);
        assert!(garbage.connections() >= 1);
    })
    .await
    .expect("chaos case exceeded its deadline");
}
