//! A boundary emission cut off by the run's deadline still moves the session.
//!
//! The abandoned `agent_startup` or `agent_shutdown` leaves a synthetic deny
//! (`host_error:interceptor_timeout`) in the audit trail, and the session's
//! phase moves the way that deny moves it: after a startup deny the closing
//! `agent_shutdown` (§6.1a) is admitted; after a cut shutdown the session is
//! closed, so no second `agent_shutdown` follows (§3.1: once).

mod hooks_support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_hooks::{AgentContext, Decision, Interceptor, Verdict};
use async_trait::async_trait;
use hooks_support::{point, points_of, run_input};
use opensesame_rotation_web::hooks::{HookSession, SessionConfig, ShutdownReason, BROWSER_VERBS};

/// Allows everything, except that it never answers at one point.
struct StallsAt {
    point: &'static str,
    seen: Arc<Mutex<Vec<AgentContext>>>,
}

#[async_trait]
impl Interceptor for StallsAt {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        self.seen.lock().unwrap().push(context.clone());
        if point(context) == self.point {
            std::future::pending::<()>().await;
        }
        Verdict::allow()
    }
}

fn session_stalling_at(point: &'static str) -> (HookSession, Arc<Mutex<Vec<AgentContext>>>) {
    let seen = Arc::default();
    let stalls = StallsAt {
        point,
        seen: Arc::clone(&seen),
    };
    let session = HookSession::new(SessionConfig::new("run:cut"), vec![Box::new(stalls)], None)
        .unwrap()
        .with_retained_records()
        .with_timestamps(|| "2026-09-28T00:00:00.000Z".to_owned());
    (session, seen)
}

/// Cut `emission` off at the run's deadline, as `timeout` does to a hosted run.
async fn cut<T>(emission: impl std::future::Future<Output = T>) {
    let outcome = tokio::time::timeout(Duration::from_millis(50), emission).await;
    assert!(outcome.is_err(), "the emission was meant to be cut off");
}

fn reasons_of_shutdowns(seen: &Mutex<Vec<AgentContext>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|context| point(context) == "agent_shutdown")
        .map(|context| context["summary"]["reason"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_cut_startup_is_followed_by_exactly_one_error_shutdown() {
    let (session, seen) = session_stalling_at("agent_startup");
    cut(session.startup(&BROWSER_VERBS)).await;

    // The shutdown the launcher emits after the deadline is admitted: a
    // startup deny is closed by an `agent_shutdown`, not left open.
    let closing = session
        .shutdown(ShutdownReason::Error)
        .await
        .expect("a cut startup is closed by an agent_shutdown");
    assert_eq!(closing.interception_point.as_str(), "agent_shutdown");
    // And only one: the session is closed now.
    assert!(session.shutdown(ShutdownReason::Error).await.is_none());

    let records = session.records().await;
    assert_eq!(points_of(&records), ["agent_startup", "agent_shutdown"]);
    assert_eq!(records[0].verdict.decision, Decision::Deny);
    assert_eq!(
        records[0].verdict.reason.as_deref(),
        Some("host_error:interceptor_timeout")
    );
    assert_eq!(reasons_of_shutdowns(&seen), ["error"]);
    // Nothing else may follow a startup deny.
    assert!(session.input(&run_input()).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_cut_shutdown_is_not_followed_by_a_second_one() {
    let (session, seen) = session_stalling_at("agent_shutdown");
    session.startup(&BROWSER_VERBS).await.unwrap();
    session.input(&run_input()).await.unwrap();
    cut(session.shutdown(ShutdownReason::Cancelled)).await;

    // The launcher's own shutdown after the deadline finds the session closed
    // and refuses at once; a second emission would stall on the interceptor.
    let second = tokio::time::timeout(
        Duration::from_millis(50),
        session.shutdown(ShutdownReason::Error),
    )
    .await;
    assert!(
        matches!(second, Ok(None)),
        "a second agent_shutdown was emitted: {second:?}"
    );

    let records = session.records().await;
    assert_eq!(
        points_of(&records),
        ["agent_startup", "input", "agent_shutdown"]
    );
    assert_eq!(records[2].verdict.decision, Decision::Deny);
    assert_eq!(
        records[2].verdict.reason.as_deref(),
        Some("host_error:interceptor_timeout")
    );
    // The interceptor was asked about one shutdown only, the run's own.
    assert_eq!(reasons_of_shutdowns(&seen), ["cancelled"]);
}
