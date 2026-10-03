//! What a hook session keeps, and that a per-emission emitter is still the
//! session's own configuration (agent-hooks/0.1 §9, §10.1, §10.3, §12.3).
//!
//! A relay session can run for a long time. With a sink installed, the sink
//! is where records live and the session must not also hold every one of them
//! for its whole life; without one, `records()` is the only way to read them,
//! so it keeps them all. Both are said here so neither changes by accident.

mod hooks_support;

use std::sync::{Arc, Mutex};

use agent_hooks::{
    AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolution, ApprovalResolver,
    HostError, IdentityProvider, Verdict,
};
use async_trait::async_trait;
use hooks_support::{at, run_input, FakeBrowser, Scripted};
use opensesame_rotation_web::hooks::{
    HookSession, HookedTransport, RecordSink, SessionConfig, ShutdownReason, BROWSER_VERBS,
};
use opensesame_rotation_web::BrowserTransport;
use serde_json::json;

type Seen = Arc<Mutex<Vec<i64>>>;

fn recording() -> (Seen, RecordSink) {
    let seen: Seen = Arc::default();
    let into = Arc::clone(&seen);
    (
        seen,
        Arc::new(move |record| into.lock().unwrap().push(record.sequence)),
    )
}

fn session() -> HookSession {
    HookSession::new(
        SessionConfig::new("run:records"),
        vec![Box::new(Scripted::allow_all())],
        None,
    )
    .unwrap()
}

/// Start, open a turn, run `verbs` verbs, and close: `3 + 2 * verbs` records.
async fn run(session: HookSession, verbs: usize) -> HookedTransport<FakeBrowser> {
    let hooked = HookedTransport::new(FakeBrowser::default(), session);
    hooked.session().startup(&BROWSER_VERBS).await.unwrap();
    hooked.session().input(&run_input()).await.unwrap();
    for _ in 0..verbs {
        hooked.wait_for("#new").await.unwrap();
    }
    hooked.session().shutdown(ShutdownReason::Completed).await;
    hooked
}

#[tokio::test]
async fn without_a_sink_every_record_is_kept() {
    let hooked = run(session(), 3).await;
    let records = hooked.session().records().await;
    assert_eq!(records.len(), 9);
    let sequences: Vec<i64> = records.iter().map(|r| r.sequence).collect();
    assert_eq!(sequences, (0..9).collect::<Vec<_>>());
    assert_eq!(hooked.session().records_dropped(), 0);
}

#[tokio::test]
async fn with_a_sink_the_session_keeps_nothing_and_the_sink_gets_everything() {
    let (seen, sink) = recording();
    let hooked = run(session().with_record_sink(sink), 3).await;
    assert!(hooked.session().records().await.is_empty());
    assert_eq!(*seen.lock().unwrap(), (0..9).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_sink_and_retention_can_be_asked_for_together() {
    let (seen, sink) = recording();
    let hooked = run(session().with_record_sink(sink).with_retained_records(), 3).await;
    assert_eq!(hooked.session().records().await.len(), 9);
    assert_eq!(seen.lock().unwrap().len(), 9);
    // Asking for retention before the sink says the same thing.
    let (seen, sink) = recording();
    let hooked = run(session().with_retained_records().with_record_sink(sink), 1).await;
    assert_eq!(hooked.session().records().await.len(), 5);
    assert_eq!(seen.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn a_limit_keeps_the_newest_and_counts_the_rest_while_the_sink_sees_all() {
    let (seen, sink) = recording();
    let hooked = run(
        session()
            .with_record_sink(sink)
            .with_retained_records()
            .with_max_records(4),
        3,
    )
    .await;
    let kept: Vec<i64> = hooked
        .session()
        .records()
        .await
        .iter()
        .map(|r| r.sequence)
        .collect();
    assert_eq!(kept, [5, 6, 7, 8]);
    assert_eq!(hooked.session().records_dropped(), 5);
    assert_eq!(seen.lock().unwrap().len(), 9);
}

/// Each request a resolver was shown: its identity and the context.
type Asked = Vec<(Option<String>, AgentContext)>;

/// A resolver that keeps the request it was shown and approves it.
struct Shown(Arc<Mutex<Asked>>);

#[async_trait]
impl ApprovalResolver for Shown {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        self.0
            .lock()
            .unwrap()
            .push((request.context_identity.clone(), request.context.clone()));
        ApprovalResolution {
            outcome: ApprovalOutcome::Approve,
            context_identity: request.context_identity.clone(),
            verdict: Some(Verdict::allow()),
        }
    }
}

fn escalating() -> Scripted {
    Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("navigate")) {
            Verdict::escalate(Some("acme:approve".into()), None)
        } else {
            Verdict::allow()
        }
    })
}

fn acme_identity() -> IdentityProvider {
    IdentityProvider::custom("acme-id", |c| {
        format!("acme:{}", c["sequence"].as_u64().unwrap_or_default())
    })
    .unwrap()
}

#[tokio::test]
async fn every_emission_gets_the_approval_redactor_and_the_identity_provider() {
    let asked: Arc<Mutex<Asked>> = Arc::default();
    let config = SessionConfig {
        identity: acme_identity(),
        ..SessionConfig::new("run:wired")
    };
    let session = HookSession::new(
        config,
        vec![Box::new(escalating())],
        Some(Box::new(Shown(Arc::clone(&asked)))),
    )
    .unwrap()
    .with_approval_redactor(|context| {
        let mut shown = context.clone();
        shown.insert("target".into(), json!({ "url": "[redacted]" }));
        shown
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session);
    hooked.session().startup(&BROWSER_VERBS).await.unwrap();
    hooked.session().input(&run_input()).await.unwrap();
    hooked.navigate("https://example.com/a").await.unwrap();
    hooked.navigate("https://example.com/b").await.unwrap();

    let asked: Asked = asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 2);
    for (identity, context) in &asked {
        // What the approver saw is redacted, and the identity is the custom
        // provider's, over that context.
        assert_eq!(context["target"], json!({ "url": "[redacted]" }));
        let sequence = context["sequence"].as_u64().unwrap();
        assert_eq!(
            identity.as_deref(),
            Some(format!("acme:{sequence}").as_str())
        );
    }
    let records = hooked.session().records().await;
    assert!(records
        .iter()
        .all(|r| r.identity_provider.as_deref() == Some("acme-id")));
    // The proposed URL was never replaced by the redactor's copy.
    assert_eq!(
        hooked.inner().calls(),
        [
            "navigate(https://example.com/a)",
            "navigate(https://example.com/b)"
        ]
    );
}

#[test]
fn a_custom_identity_name_that_breaks_the_naming_rules_is_refused_at_construction() {
    for name in ["jcs-sha256", "Acme", "", "1acme"] {
        let config = SessionConfig {
            identity: IdentityProvider::Custom {
                name: name.to_owned(),
                f: Box::new(|_| String::new()),
            },
            ..SessionConfig::new("run:bad-identity")
        };
        let refused = HookSession::new(config, vec![Box::new(Scripted::allow_all())], None);
        assert!(
            matches!(refused, Err(HostError::ContextInvalid)),
            "{name:?} was accepted"
        );
    }
}
