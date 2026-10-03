//! The engine's untyped surface — a tool known by name, and the model
//! exchange — behaves as the verbs do: one lock, one phase, the caller's
//! `tool_call.id`, a transform applied or refused, never ignored. No rotation
//! or capture run calls these (ADR 0076 §8); the second CTK claim does.

mod hooks_support;

use agent_hooks::{InterceptionPoint, Verdict};
use hooks_support::{at, point, run_input, session, transform, Scripted};
use opensesame_rotation_web::hooks::{HookSession, ModelResponse, Reported, OUT_OF_ORDER};
use serde_json::{json, Value};

async fn opened(interceptor: &Scripted) -> HookSession {
    let session = session(interceptor);
    session.startup(&["lookup"]).await.unwrap();
    session.input(&run_input()).await.unwrap();
    session
}

/// A turn's final report, as the `output`.
struct Report(Value);

impl Reported for Report {
    fn report(&self) -> Value {
        self.0.clone()
    }
    fn restate(self, report: Value) -> Option<Self> {
        Some(Self(report))
    }
}

fn answer() -> ModelResponse {
    ModelResponse {
        content: json!("done"),
        tool_calls: Vec::new(),
        finish_reason: "stop".into(),
    }
}

#[tokio::test]
async fn a_tool_call_carries_the_id_it_was_given_on_both_emissions() {
    let interceptor = Scripted::allow_all();
    let session = opened(&interceptor).await;
    let result = session
        .tool_call("tc-7", "lookup", json!({ "q": "a" }), |args| async move {
            Ok(json!({ "echo": args }))
        })
        .await;
    assert_eq!(result, Ok(Ok(json!({ "echo": { "q": "a" } }))));
    let tool: Vec<_> = interceptor
        .seen()
        .into_iter()
        .filter(|c| point(c).ends_with("_tool_call"))
        .collect();
    assert_eq!(tool.len(), 2);
    assert!(tool.iter().all(|c| c["tool_call"]["id"] == "tc-7"));
    assert!(tool.iter().all(|c| c["tool_call"]["name"] == "lookup"));
}

#[tokio::test]
async fn a_pre_tool_transform_is_what_the_tool_receives_and_a_deny_means_it_never_ran() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("lookup")) {
            transform("$target.q", json!("scrubbed"))
        } else {
            Verdict::allow()
        }
    });
    let session = opened(&interceptor).await;
    let seen = std::sync::Mutex::new(Vec::<Value>::new());
    let seen = &seen;
    let result = session
        .tool_call("tc-1", "lookup", json!({ "q": "raw" }), |args| async move {
            seen.lock().unwrap().push(args);
            Ok(json!("ok"))
        })
        .await;
    assert_eq!(result, Ok(Ok(json!("ok"))));
    assert_eq!(*seen.lock().unwrap(), [json!({ "q": "scrubbed" })]);

    let deny = Scripted::new(|c| {
        if at(c, "pre_tool_call", None) {
            Verdict::deny(Some("acme:no".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let session = opened(&deny).await;
    let ran = std::sync::atomic::AtomicBool::new(false);
    let ran = &ran;
    let refusal = session
        .tool_call("tc-2", "lookup", json!({}), |_| async move {
            ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(json!("ok"))
        })
        .await
        .unwrap_err();
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(refusal.point, InterceptionPoint::PreToolCall);
    assert_eq!(refusal.reason.as_deref(), Some("acme:no"));
}

#[tokio::test]
async fn a_tool_error_stays_an_error_through_a_post_transform() {
    let interceptor = Scripted::new(|c| {
        if at(c, "post_tool_call", None) {
            transform("$target", json!("redacted"))
        } else {
            Verdict::allow()
        }
    });
    let session = opened(&interceptor).await;
    let result = session
        .tool_call("tc-1", "lookup", json!({}), |_| async move {
            Err(json!("boom"))
        })
        .await;
    assert_eq!(result, Ok(Err(json!("redacted"))));
}

#[tokio::test]
async fn model_points_join_the_same_ordered_session() {
    let interceptor = Scripted::allow_all();
    let session = opened(&interceptor).await;
    let messages = session
        .pre_model_call("m", vec![json!({ "role": "user", "content": "hi" })])
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(session.post_model_call("m", answer()).await, Ok(answer()));
    let points: Vec<_> = interceptor
        .seen()
        .iter()
        .map(|c| point(c).to_owned())
        .collect();
    assert_eq!(
        points,
        [
            "agent_startup",
            "input",
            "pre_model_call",
            "post_model_call"
        ]
    );
    let sequences: Vec<_> = interceptor
        .seen()
        .iter()
        .map(|c| c["sequence"].as_i64().unwrap())
        .collect();
    assert_eq!(sequences, [0, 1, 2, 3]);
}

#[tokio::test]
async fn a_model_point_outside_a_turn_is_refused_without_an_emission() {
    let interceptor = Scripted::allow_all();
    let session = session(&interceptor);
    let refusal = session.pre_model_call("m", Vec::new()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));
    let refusal = session
        .tool_call("tc", "lookup", json!({}), |_| async { Ok(json!(1)) })
        .await
        .unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));
    assert!(interceptor.seen().is_empty(), "nothing was emitted");
    assert!(session.records().await.is_empty());
}

fn user_message() -> Vec<Value> {
    vec![json!({ "role": "user", "content": "hi" })]
}

const INVALID: Option<&str> = Some("host_error:transform_invalid");

#[tokio::test]
async fn a_model_transform_that_is_not_the_shape_is_refused_not_ignored() {
    let interceptor = Scripted::new(|c| match point(c) {
        "pre_model_call" => transform("$target", json!("not a list")),
        "post_model_call" => transform("$target.finish_reason", json!(7)),
        _ => Verdict::allow(),
    });
    let session = opened(&interceptor).await;
    let refusal = session
        .pre_model_call("m", user_message())
        .await
        .unwrap_err();
    assert_eq!(refusal.point, InterceptionPoint::PreModelCall);
    assert_eq!(refusal.reason.as_deref(), INVALID);

    // The refused request was not sent, so it has no response to pair with.
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));

    let interceptor = Scripted::new(|c| match point(c) {
        "post_model_call" => transform("$target.finish_reason", json!(7)),
        _ => Verdict::allow(),
    });
    let session = opened(&interceptor).await;
    session.pre_model_call("m", user_message()).await.unwrap();
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.point, InterceptionPoint::PostModelCall);
    assert_eq!(refusal.reason.as_deref(), INVALID);
}

#[tokio::test]
async fn a_transform_that_breaks_a_section_4_2_shape_is_refused() {
    // A model message with no role, a response whose call has no name.
    let interceptor = Scripted::new(|c| match point(c) {
        "pre_model_call" => transform("$target[0].role", json!(3)),
        "post_model_call" => transform("$target.tool_calls", json!([{ "id": "t" }])),
        "pre_tool_call" => transform("$target", json!("a string, not an object")),
        _ => Verdict::allow(),
    });
    let session = opened(&interceptor).await;
    let refusal = session
        .pre_model_call("m", user_message())
        .await
        .unwrap_err();
    assert_eq!(refusal.reason.as_deref(), INVALID);

    let interceptor = Scripted::new(|c| match point(c) {
        "post_model_call" => transform("$target.tool_calls", json!([{ "id": "t" }])),
        "pre_tool_call" => transform("$target", json!("a string, not an object")),
        _ => Verdict::allow(),
    });
    let session = opened(&interceptor).await;
    session.pre_model_call("m", user_message()).await.unwrap();
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), INVALID);

    // Arguments that are no longer an object never reach the tool.
    let ran = std::sync::atomic::AtomicBool::new(false);
    let ran = &ran;
    let refusal = session
        .tool_call("tc", "lookup", json!({ "q": 1 }), |_| async move {
            ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(json!(1))
        })
        .await
        .unwrap_err();
    assert_eq!(refusal.point, InterceptionPoint::PreToolCall);
    assert_eq!(refusal.reason.as_deref(), INVALID);
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test]
async fn what_is_not_a_section_4_2_shape_to_begin_with_is_refused_without_an_emission() {
    let interceptor = Scripted::allow_all();
    let session = opened(&interceptor).await;
    let before = interceptor.seen().len();
    let context_invalid = Some("host_error:context_invalid");

    let refusal = session
        .pre_model_call("m", vec![json!({ "content": "no role" })])
        .await
        .unwrap_err();
    assert_eq!(refusal.reason.as_deref(), context_invalid);
    session.pre_model_call("m", user_message()).await.unwrap();
    let bad = ModelResponse {
        tool_calls: vec![json!({ "id": "t", "name": "lookup", "args": "x" })],
        ..answer()
    };
    let refusal = session.post_model_call("m", bad).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), context_invalid);
    let refusal = session
        .tool_call("tc", "lookup", json!(["not", "an", "object"]), |_| async {
            Ok(json!(1))
        })
        .await
        .unwrap_err();
    assert_eq!(refusal.reason.as_deref(), context_invalid);
    // Only the one request that was well formed reached an interceptor.
    assert_eq!(interceptor.seen().len(), before + 1);
}

#[tokio::test]
async fn a_post_model_call_pairs_with_a_pre_model_call_that_proceeded() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "pre_model_call" && c["messages"][0]["content"] == "blocked" {
            Verdict::deny(Some("acme:no".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let session = opened(&interceptor).await;

    // None open: nothing to answer, nothing emitted (§3.1.4).
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));

    // A blocked request is not sent, so no response can follow it (§6.2).
    let blocked = vec![json!({ "role": "user", "content": "blocked" })];
    session.pre_model_call("m", blocked).await.unwrap_err();
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));

    // One request, one response; a second response has no request left.
    session.pre_model_call("m", user_message()).await.unwrap();
    session.post_model_call("m", answer()).await.unwrap();
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));

    let points: Vec<_> = interceptor
        .seen()
        .iter()
        .map(|c| point(c).to_owned())
        .collect();
    assert_eq!(
        points,
        [
            "agent_startup",
            "input",
            "pre_model_call",
            "pre_model_call",
            "post_model_call"
        ]
    );
}

#[tokio::test]
async fn concurrent_model_calls_each_pair_and_a_turn_end_closes_the_rest() {
    let interceptor = Scripted::allow_all();
    let session = opened(&interceptor).await;
    session.pre_model_call("m", user_message()).await.unwrap();
    session.pre_model_call("m", user_message()).await.unwrap();
    session.post_model_call("m", answer()).await.unwrap();
    session.post_model_call("m", answer()).await.unwrap();
    assert!(session.post_model_call("m", answer()).await.is_err());

    // A request left open when the turn ends does not carry into the next.
    session.pre_model_call("m", user_message()).await.unwrap();
    session.output(Report(json!("done"))).await.unwrap();
    session.input(&run_input()).await.unwrap();
    let refusal = session.post_model_call("m", answer()).await.unwrap_err();
    assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));
}

#[tokio::test]
async fn two_posts_in_flight_cannot_both_answer_the_same_pre() {
    let interceptor = Scripted::allow_all();
    let session = opened(&interceptor).await;
    session.pre_model_call("m", user_message()).await.unwrap();
    // The pairing is claimed when an emission is reserved, not when it
    // settles, so however the two interleave only one holds the pre.
    let (first, second) = tokio::join!(
        session.post_model_call("m", answer()),
        session.post_model_call("m", answer()),
    );
    assert_eq!(
        [first.is_ok(), second.is_ok()]
            .iter()
            .filter(|ok| **ok)
            .count(),
        1
    );
    let posts = interceptor
        .seen()
        .iter()
        .filter(|c| point(c) == "post_model_call")
        .count();
    assert_eq!(posts, 1);
}
