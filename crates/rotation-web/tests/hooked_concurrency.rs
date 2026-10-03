//! Concurrent verbs on one hook session (agent-hooks/0.1 §12.2).
//!
//! A verb parked on the approval seam — a person, possibly for minutes — must
//! not hold up another verb's emission (§12.2.2: emissions of different tool
//! calls MAY proceed concurrently; §12.2.4: the host does not serialize
//! emissions on an interceptor's behalf), while `sequence` stays unique and
//! totally ordered (§12.2.3), the records leave in that order, labels are
//! still persisted per emission, and §3.1's startup/shutdown bracket still
//! holds.
//!
//! Time is paused, so "the other verb did not wait" is a measurement, not a
//! race: with the clock frozen, a verb that queued behind the parked approval
//! would only complete once the runtime idled and the clock jumped to the
//! approval's deadline.

mod hooks_support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_hooks::{
    AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolution, ApprovalResolver, Decision,
    InterceptionPoint, InterceptionRecord, Interceptor, Verdict,
};
use async_trait::async_trait;
use hooks_support::{at, points_of, run_input, FakeBrowser, Scripted};
use opensesame_rotation_web::hooks::{
    HookSession, HookedTransport, SessionConfig, ShutdownReason, BROWSER_VERBS,
};
use opensesame_rotation_web::{BrowserTransport, StepError};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio::time::Instant;

/// How long a person takes to answer.
const HELD: Duration = Duration::from_secs(600);

/// A person who answers after [`HELD`], and says when the question arrived.
struct Slow {
    asked: Arc<Notify>,
}

#[async_trait]
impl ApprovalResolver for Slow {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        self.asked.notify_one();
        tokio::time::sleep(HELD).await;
        ApprovalResolution {
            outcome: ApprovalOutcome::Approve,
            context_identity: request.context_identity.clone(),
            verdict: Some(Verdict::allow()),
        }
    }
}

/// A scripted interceptor registered under a namespace.
struct Named(&'static str, Scripted);

#[async_trait]
impl Interceptor for Named {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        self.1.intercept(context).await
    }

    fn name(&self) -> Option<String> {
        Some(self.0.to_owned())
    }
}

/// Escalates `navigate` (a person must say yes); labels what `wait_for`
/// returns; allows the rest.
fn policy() -> Scripted {
    Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("navigate")) {
            Verdict::escalate(Some("acme:approve".into()), None)
        } else if at(c, "post_tool_call", Some("wait_for")) {
            Verdict {
                result_labels: vec!["acme:pii".into()],
                ..Verdict::allow()
            }
        } else {
            Verdict::allow()
        }
    })
}

type Delivered = Arc<Mutex<Vec<i64>>>;

struct Rig {
    hooked: Arc<HookedTransport<FakeBrowser>>,
    seen: Scripted,
    asked: Arc<Notify>,
    delivered: Delivered,
}

async fn rig() -> Rig {
    let seen = policy();
    let asked = Arc::new(Notify::new());
    let delivered: Delivered = Arc::default();
    let sink = Arc::clone(&delivered);
    let session = HookSession::new(
        SessionConfig::new("run:concurrent"),
        vec![Box::new(Named("acme", seen.clone()))],
        Some(Box::new(Slow {
            asked: Arc::clone(&asked),
        })),
    )
    .unwrap()
    .with_record_sink(Arc::new(move |record| {
        sink.lock().unwrap().push(record.sequence);
    }))
    .with_retained_records()
    .with_timestamps(|| "2026-09-28T00:00:00.000Z".to_owned());
    let hooked = Arc::new(HookedTransport::new(FakeBrowser::default(), session));
    hooked.session().startup(&BROWSER_VERBS).await.unwrap();
    hooked.session().input(&run_input()).await.unwrap();
    Rig {
        hooked,
        seen,
        asked,
        delivered,
    }
}

type Verb = tokio::task::JoinHandle<Result<(), StepError>>;

/// Start `navigate` and return once it is parked on the approval seam.
async fn parked_navigate(rig: &Rig) -> Verb {
    let hooked = Arc::clone(&rig.hooked);
    let verb = tokio::spawn(async move { hooked.navigate("https://example.com").await });
    rig.asked.notified().await;
    verb
}

async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

fn sequences(records: &[InterceptionRecord]) -> Vec<i64> {
    records.iter().map(|record| record.sequence).collect()
}

fn source_labels(context: &AgentContext) -> Value {
    context
        .get("extensions")
        .and_then(|e| e.get("acme"))
        .and_then(|n| n.get("source_labels"))
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test(start_paused = true)]
async fn a_verb_parked_on_approval_does_not_hold_up_another() {
    let rig = rig().await;
    let started = Instant::now();
    let parked = parked_navigate(&rig).await;

    // The other verb runs to completion while the person is still deciding.
    rig.hooked.wait_for("#new").await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the second verb waited for the approval: {:?}",
        started.elapsed()
    );
    assert!(!parked.is_finished());

    tokio::time::advance(HELD).await;
    parked.await.unwrap().unwrap();
    assert!(started.elapsed() >= HELD);
    assert_eq!(rig.hooked.inner().verbs(), ["wait_for", "navigate"]);
}

#[tokio::test(start_paused = true)]
async fn sequences_are_unique_and_records_leave_in_sequence_order() {
    let rig = rig().await;
    let parked = parked_navigate(&rig).await;
    rig.hooked.wait_for("#new").await.unwrap();

    // `wait_for` finished first but was sequenced second: its records are held
    // until the earlier emission's record can go out ahead of them.
    assert_eq!(sequences(&rig.hooked.session().records().await), [0, 1]);
    assert_eq!(*rig.delivered.lock().unwrap(), [0, 1]);

    tokio::time::advance(HELD).await;
    parked.await.unwrap().unwrap();

    let records = rig.hooked.session().records().await;
    assert_eq!(sequences(&records), [0, 1, 2, 3, 4, 5]);
    assert_eq!(*rig.delivered.lock().unwrap(), [0, 1, 2, 3, 4, 5]);
    assert_eq!(
        points_of(&records),
        [
            "agent_startup",
            "input",
            "pre_tool_call",
            "pre_tool_call",
            "post_tool_call",
            "post_tool_call"
        ]
    );
    // The escalated emission carries the approval; the other one did not wait.
    assert_eq!(records[2].resolved_by, Some("approval"));
    assert_eq!(records[3].resolved_by, None);
    // Every context the interceptor saw had its own sequence.
    let mut seen: Vec<u64> = rig
        .seen
        .seen()
        .iter()
        .map(|c| c["sequence"].as_u64().unwrap())
        .collect();
    seen.sort_unstable();
    assert_eq!(seen, [0, 1, 2, 3, 4, 5]);
}

#[tokio::test(start_paused = true)]
async fn labels_persist_per_emission_while_another_is_parked() {
    let rig = rig().await;
    let parked = parked_navigate(&rig).await;
    rig.hooked.wait_for("#new").await.unwrap();
    tokio::time::advance(HELD).await;
    parked.await.unwrap().unwrap();

    let contexts = rig.seen.seen();
    let of = |wanted: &str, verb: &str| {
        contexts
            .iter()
            .find(|c| at(c, wanted, Some(verb)))
            .unwrap_or_else(|| panic!("{wanted} {verb}"))
    };
    // `navigate` was proposed before `wait_for`'s result existed, so its
    // `pre_tool_call` cannot carry that label; its `post_tool_call` is built
    // after the label was persisted, and does.
    assert_eq!(source_labels(of("pre_tool_call", "navigate")), Value::Null);
    assert_eq!(
        source_labels(of("post_tool_call", "navigate")),
        json!(["acme:pii"])
    );
    // An emission that was never labelled by the parked one stays unlabelled
    // by it: only `wait_for`'s permitted result introduced a label.
    let records = rig.hooked.session().records().await;
    let labelled: Vec<i64> = records
        .iter()
        .filter(|r| !r.verdict.result_labels.is_empty())
        .map(|r| r.sequence)
        .collect();
    assert_eq!(labelled, [4]);
}

#[tokio::test(start_paused = true)]
async fn shutdown_waits_for_the_parked_emission_and_nothing_follows_it() {
    let rig = rig().await;
    let parked = parked_navigate(&rig).await;

    let closing = {
        let hooked = Arc::clone(&rig.hooked);
        tokio::spawn(async move { hooked.session().shutdown(ShutdownReason::Cancelled).await })
    };
    settle().await;
    // §3.1: `agent_shutdown` follows everything already sequenced.
    assert!(!closing.is_finished());
    assert_eq!(sequences(&rig.hooked.session().records().await), [0, 1]);

    // A verb that arrives behind the shutdown finds the session closed and is
    // refused without an emission.
    let late = {
        let hooked = Arc::clone(&rig.hooked);
        tokio::spawn(async move { hooked.wait_for("#late").await })
    };
    settle().await;

    tokio::time::advance(HELD).await;
    let _ = parked.await.unwrap();
    let record = closing.await.unwrap().expect("shutdown was emitted");
    assert_eq!(late.await.unwrap(), Err(StepError::Refused));

    let records = rig.hooked.session().records().await;
    assert_eq!(
        points_of(&records),
        ["agent_startup", "input", "pre_tool_call", "agent_shutdown"]
    );
    assert_eq!(sequences(&records), [0, 1, 2, 3]);
    assert_eq!(record.sequence, 3);
    assert_eq!(*rig.delivered.lock().unwrap(), [0, 1, 2, 3]);
    assert!(!rig.hooked.inner().verbs().contains(&"wait_for".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn an_abandoned_emission_does_not_stall_the_records_behind_it() {
    let rig = rig().await;
    let parked = parked_navigate(&rig).await;
    rig.hooked.wait_for("#new").await.unwrap();
    assert_eq!(sequences(&rig.hooked.session().records().await), [0, 1]);

    // The caller gives up on the parked verb. Nothing waits for it, and the
    // attempt does not vanish: its sequence carries a record that it was cut
    // off before any verdict.
    parked.abort();
    assert!(parked.await.unwrap_err().is_cancelled());

    let records = rig.hooked.session().records().await;
    assert_eq!(sequences(&records), [0, 1, 2, 3, 4]);
    assert_eq!(*rig.delivered.lock().unwrap(), [0, 1, 2, 3, 4]);
    let abandoned = &records[2];
    assert_eq!(abandoned.interception_point, InterceptionPoint::PreToolCall);
    assert_eq!(abandoned.verdict.decision, Decision::Deny);
    assert_eq!(
        abandoned.verdict.reason.as_deref(),
        Some("host_error:interceptor_timeout")
    );
    assert!(!abandoned.proceeds());

    // And the session keeps going, with the next sequence after every one
    // already handed out.
    rig.hooked.submit("#save").await.unwrap();
    let records = rig.hooked.session().records().await;
    assert_eq!(sequences(&records), [0, 1, 2, 3, 4, 5, 6]);
}
