//! Result labels carried through a hosted run (agent-hooks/0.1 §5.4).
//!
//! A permit's `result_labels` must come back as
//! `extensions.<namespace>.source_labels` on later emissions — that is the
//! channel a label-flow policy reads — and must never come back for an
//! action that did not proceed. The model is remote, so this host cannot tell
//! which later target derives from which result; the labels are sticky for
//! the rest of the run, which can only make a label policy refuse more.

mod hooks_support;

use agent_hooks::{AgentContext, CompositionConfig, Interceptor, Verdict};
use async_trait::async_trait;
use hooks_support::{at, run_input, transform, FakeBrowser, Scripted};
use opensesame_rotation_web::hooks::{
    HookSession, HookedTransport, SessionConfig, ShutdownReason, BROWSER_VERBS,
};
use opensesame_rotation_web::{BrowserTransport, StepError};
use serde_json::{json, Value};

/// A scripted interceptor registered under a namespace.
struct Named(Option<&'static str>, Scripted);

#[async_trait]
impl Interceptor for Named {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        self.1.intercept(context).await
    }

    fn name(&self) -> Option<String> {
        self.0.map(str::to_owned)
    }
}

fn labelled(labels: &[&str]) -> Verdict {
    Verdict {
        result_labels: labels.iter().map(|&l| l.to_owned()).collect(),
        ..Verdict::allow()
    }
}

/// Labels `pii` on every `navigate` result; allows everything else.
fn labelling() -> Scripted {
    Scripted::new(|c| {
        if at(c, "post_tool_call", Some("navigate")) {
            labelled(&["acme:pii"])
        } else {
            Verdict::allow()
        }
    })
}

async fn opened(
    interceptors: Vec<Box<dyn Interceptor>>,
    composition: CompositionConfig,
) -> HookedTransport<FakeBrowser> {
    let config = SessionConfig {
        composition,
        ..SessionConfig::new("run:labels")
    };
    let session = HookSession::new(config, interceptors, None).unwrap();
    let hooked = HookedTransport::new(FakeBrowser::default(), session);
    hooked.session().startup(&BROWSER_VERBS).await.unwrap();
    hooked.session().input(&run_input()).await.unwrap();
    hooked
}

fn source_labels(context: &AgentContext, namespace: &str) -> Value {
    context
        .get("extensions")
        .and_then(|e| e.get(namespace))
        .and_then(|n| n.get("source_labels"))
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test]
async fn a_permitted_label_rides_every_later_emission_under_its_namespace() {
    let seen = labelling();
    let hooked = opened(
        vec![Box::new(Named(Some("acme"), seen.clone()))],
        CompositionConfig::default(),
    )
    .await;
    hooked.navigate("https://example.com").await.unwrap();
    hooked.wait_for("#new").await.unwrap();
    hooked.submit("#save").await.unwrap();

    let contexts = seen.seen();
    let post_navigate = contexts
        .iter()
        .position(|c| at(c, "post_tool_call", Some("navigate")))
        .unwrap();
    for context in &contexts[..=post_navigate] {
        assert_eq!(source_labels(context, "acme"), Value::Null);
    }
    for context in &contexts[post_navigate + 1..] {
        assert_eq!(source_labels(context, "acme"), json!(["acme:pii"]));
    }
    // §10.3 keeps the labels on the record that produced them, too.
    let records = hooked.session().records().await;
    assert!(records
        .iter()
        .any(|r| r.verdict.result_labels == ["acme:pii"]));
}

#[tokio::test]
async fn labels_accumulate_once_each_and_stay_for_the_rest_of_the_run() {
    let seen = Scripted::new(
        |c| match c.get("tool_call").and_then(|t| t["name"].as_str()) {
            Some("navigate") if at(c, "post_tool_call", None) => labelled(&["a", "b"]),
            Some("wait_for") if at(c, "post_tool_call", None) => labelled(&["b", "c"]),
            _ => Verdict::allow(),
        },
    );
    let hooked = opened(
        vec![Box::new(Named(Some("acme"), seen.clone()))],
        CompositionConfig::default(),
    )
    .await;
    hooked.navigate("https://example.com").await.unwrap();
    hooked.wait_for("#new").await.unwrap();
    hooked.submit("#save").await.unwrap();
    hooked.session().shutdown(ShutdownReason::Completed).await;

    let last = seen.seen().pop().unwrap();
    assert_eq!(last["interception_point"], "agent_shutdown");
    assert_eq!(source_labels(&last, "acme"), json!(["a", "b", "c"]));
}

#[tokio::test]
async fn a_label_on_an_action_that_did_not_proceed_is_never_resurfaced() {
    // A deny carrying labels, and a transform the verb cannot take: neither
    // action proceeded, so neither label may be persisted (§5.4).
    let seen = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("navigate")) {
            Verdict {
                result_labels: vec!["acme:denied".into()],
                ..Verdict::deny(Some("acme:no".into()), None)
            }
        } else if at(c, "post_tool_call", Some("wait_for")) {
            Verdict {
                result_labels: vec!["acme:unapplied".into()],
                ..transform("$target", json!("not a unit"))
            }
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(
        vec![Box::new(Named(Some("acme"), seen.clone()))],
        CompositionConfig::default(),
    )
    .await;
    assert_eq!(
        hooked.navigate("https://example.com").await,
        Err(StepError::Refused)
    );
    assert_eq!(hooked.wait_for("#new").await, Err(StepError::Refused));
    hooked.submit("#save").await.unwrap();
    for context in seen.seen() {
        assert!(context.get("extensions").is_none(), "{context:?}");
    }
}

#[tokio::test]
async fn a_label_the_combined_verdict_dropped_does_not_come_back() {
    // run_all: the first interceptor labels and permits, the second denies.
    // The combination denies, so the first one's label is not persisted.
    let labels = labelling();
    let denies = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("navigate")) {
            Verdict::deny(Some("acme:no".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(
        vec![
            Box::new(Named(Some("acme"), labels.clone())),
            Box::new(Named(Some("other"), denies)),
        ],
        CompositionConfig::run_all(),
    )
    .await;
    assert_eq!(
        hooked.navigate("https://example.com").await,
        Err(StepError::Refused)
    );
    hooked.wait_for("#new").await.unwrap();
    assert!(labels.seen().iter().all(|c| c.get("extensions").is_none()));
}

#[tokio::test]
async fn labels_resurface_per_namespace_and_never_to_an_unnamed_or_reserved_one() {
    let acme = labelling();
    let unnamed = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("navigate")) {
            labelled(&["anon:x"])
        } else {
            Verdict::allow()
        }
    });
    let reserved = Scripted::new(|c| {
        if at(c, "post_tool_call", Some("navigate")) {
            labelled(&["ctk:x"])
        } else {
            Verdict::allow()
        }
    });
    let hooked = opened(
        vec![
            Box::new(Named(Some("acme"), acme.clone())),
            Box::new(Named(None, unnamed)),
            Box::new(Named(Some("ctk"), reserved)),
        ],
        CompositionConfig::run_all(),
    )
    .await;
    hooked.navigate("https://example.com").await.unwrap();
    hooked.wait_for("#new").await.unwrap();
    let last = acme.seen().pop().unwrap();
    assert_eq!(
        last["extensions"],
        json!({ "acme": { "source_labels": ["acme:pii"] } })
    );
}
