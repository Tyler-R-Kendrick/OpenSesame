//! How an Interaction-backed `ask` ends, and what it leaves behind
//! (ADR 0156): a refusal is reported at once, every exit without an approval
//! withdraws both the interaction and the authorization request it fronted,
//! a cancelled `ask` cannot strand what it half raised, and a create whose
//! reply was lost is found again rather than duplicated.

mod interaction_mock;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use interaction_mock::{
    approver, config, serve, serve_with, until, Fault, Step, SERVER_PROSE, SUBJECT_ID,
};
use opensesame_agent_hooks::approval::{REASON_APPROVAL_DECLINED, REASON_APPROVAL_NOT_BOUND};
use opensesame_agent_hooks::sdk::{
    AgentContext, AgentContextBuilder, Decision, EnforcementMode, InterceptionEmitter,
    InterceptionPoint, InterceptionRecord,
};
use opensesame_agent_hooks::{
    redact_for_approver, ApprovalPrompt, BoundApprovalResolver, HookPolicy, HumanApprover,
    InteractionApprover, OpenSesameInterceptor,
};
use serde_json::json;

const UNRESOLVED: &str = "host_error:approval_unresolved";

fn emitter(approver: InteractionApprover) -> InterceptionEmitter {
    let policy = HookPolicy::parse(
        r#"{"version": 1, "tools": [{"name": "deploy", "decision": "escalate"}]}"#,
    )
    .expect("policy parses");
    let mut emitter = InterceptionEmitter::new(
        EnforcementMode::Enforce,
        Some(Box::new(BoundApprovalResolver::new(approver))),
    );
    emitter.register(Box::new(OpenSesameInterceptor::new(policy)));
    emitter.set_approval_redactor(redact_for_approver);
    emitter
}

fn deploy_context() -> AgentContext {
    AgentContextBuilder::new("release-agent", "opensesame-test", "session-1").pre_tool_call(
        "c1",
        "deploy",
        json!({"env": "prod"}),
    )
}

async fn emit(approver: InteractionApprover) -> Result<InterceptionRecord, InterceptionRecord> {
    emitter(approver)
        .emit(&mut deploy_context())
        .await
        .map(|outcome| outcome.record)
        .map_err(|blocked| blocked.record)
}

fn denied_with(outcome: &Result<InterceptionRecord, InterceptionRecord>, reason: &str) {
    let record = outcome.as_ref().expect_err("the action must stay denied");
    assert_eq!(record.verdict.decision, Decision::Deny);
    assert_eq!(record.verdict.reason.as_deref(), Some(reason));
    let message = record.verdict.message.clone().unwrap_or_default();
    assert!(!message.contains(SERVER_PROSE), "server prose echoed");
}

fn quick(server: &interaction_mock::Server) -> InteractionApprover {
    InteractionApprover::new(config(&server.base, Duration::from_secs(5)))
        .unwrap()
        .with_request_timeout(Duration::from_millis(300))
        .unwrap()
}

#[tokio::test]
async fn a_refusal_is_a_reject_at_once_not_a_deadline() {
    let server = serve(
        vec![
            Step::Reply(401, "approval_required"),
            Step::Reply(403, "approval_denied"),
        ],
        201,
    )
    .await;
    let started = Instant::now();
    let outcome = emit(approver(&server.base)).await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a refusal must not wait out the 5 s deadline"
    );
    denied_with(&outcome, REASON_APPROVAL_DECLINED);
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.consumes, 2, "stops polling the moment it is refused");
    assert_eq!(seen.revokes, 1);
    assert_eq!(seen.cancels, [SUBJECT_ID], "the refused request is closed");
}

#[tokio::test]
async fn every_exit_without_an_approval_withdraws_the_interaction_and_its_request() {
    let scripts: Vec<(&str, Vec<Step>)> = vec![
        ("expired", vec![Step::Reply(410, "interaction_expired")]),
        ("revoked", vec![Step::Reply(409, "interaction_revoked")]),
        (
            "consumed elsewhere",
            vec![Step::Reply(409, "interaction_consumed")],
        ),
        ("unbound", vec![Step::Reply(409, "digest_mismatch")]),
        ("server error", vec![Step::Reply(503, "unavailable")]),
        ("unreadable spend", vec![Step::Oversized]),
    ];
    for (label, script) in scripts {
        let server = serve(script, 201).await;
        let outcome = emit(approver(&server.base)).await;
        assert!(outcome.is_err(), "{label}: not an approval");
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.revokes, 1, "{label}: interaction withdrawn");
        assert_eq!(seen.cancels, [SUBJECT_ID], "{label}: request withdrawn");
    }
}

#[tokio::test]
async fn an_interaction_that_could_not_be_raised_still_withdraws_its_request() {
    // The request exists; fronting it failed. Nothing is left in the
    // approver's inbox for an action that will never be attempted.
    let server = serve(vec![Step::Spend], 409).await;
    let outcome = emit(approver(&server.base)).await;
    denied_with(&outcome, UNRESOLVED);
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.revokes, 0, "there was no interaction to revoke");
    assert_eq!(seen.cancels, [SUBJECT_ID]);
    assert_eq!(seen.consumes, 0);
}

fn prompt(context: &AgentContext) -> ApprovalPrompt<'_> {
    ApprovalPrompt {
        context_identity: interaction_mock::DIGEST,
        interception_point: InterceptionPoint::PreToolCall,
        reason: Some("opensesame:tool_requires_approval"),
        message: None,
        context,
    }
}

#[tokio::test]
async fn cancelling_the_ask_after_the_interaction_exists_but_before_raise_returns_leaves_nothing_live(
) {
    // The server creates the interaction and answers 300 ms later; the host
    // gives up at 100 ms, while `raise` is still waiting for that answer. The
    // ask body runs in a task the drop cannot cancel, so the create is
    // allowed to finish and is then withdrawn.
    let server = serve_with(
        vec![Step::Pending],
        201,
        Fault::SlowInteraction(Duration::from_millis(300)),
    )
    .await;
    let links = Arc::new(Mutex::new(Vec::new()));
    let sink = links.clone();
    let approver = approver(&server.base).with_on_pending(Arc::new(move |url: &str| {
        sink.lock().unwrap().push(url.to_owned());
    }));
    let context = deploy_context();
    let asked =
        tokio::time::timeout(Duration::from_millis(100), approver.ask(prompt(&context))).await;
    assert!(asked.is_err(), "the host cancelled the ask");

    until(&server, |seen| seen.revokes == 1 && seen.cancels.len() == 1).await;
    // And it stays that way: nothing polls, nothing is announced.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.interactions.len(), 1);
    assert_eq!(seen.revokes, 1);
    assert_eq!(seen.cancels, [SUBJECT_ID]);
    assert_eq!(
        seen.consumes, 0,
        "a cancelled ask does not wait for a person"
    );
    assert!(links.lock().unwrap().is_empty(), "no link for a dead ask");
}

#[tokio::test]
async fn cancelling_the_ask_between_the_two_creates_never_creates_the_interaction() {
    let server = serve_with(
        vec![Step::Pending],
        201,
        Fault::SlowSubject(Duration::from_millis(300)),
    )
    .await;
    let approver = approver(&server.base);
    let context = deploy_context();
    let asked =
        tokio::time::timeout(Duration::from_millis(100), approver.ask(prompt(&context))).await;
    assert!(asked.is_err(), "the host cancelled the ask");

    until(&server, |seen| seen.cancels.len() == 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let seen = server.seen.lock().unwrap();
    assert!(
        seen.interactions.is_empty(),
        "no interaction for a dead ask"
    );
    assert_eq!(seen.revokes, 0);
    assert_eq!(
        seen.cancels,
        [SUBJECT_ID],
        "the request it did raise is withdrawn"
    );
}

#[tokio::test]
async fn a_dropped_ask_withdraws_both_things_it_raised() {
    let server = serve(vec![Step::Pending], 201).await;
    let approver = approver(&server.base);
    let context = deploy_context();
    let asked =
        tokio::time::timeout(Duration::from_millis(150), approver.ask(prompt(&context))).await;
    assert!(asked.is_err());
    until(&server, |seen| seen.revokes == 1 && seen.cancels.len() == 1).await;
}

#[tokio::test]
async fn a_lost_interaction_reply_is_found_again_under_the_same_key() {
    // The server processed the create; the answer never came back. The one
    // retry carries the same key, so the server replays its answer instead of
    // creating a second interaction nobody holds a reference to.
    let server = serve_with(vec![Step::Spend], 201, Fault::LoseFirstInteractionReply).await;
    let outcome = emit(quick(&server)).await;
    let record = outcome.expect("approved after the retry");
    assert_eq!(record.verdict.decision, Decision::Allow);
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.interactions.len(), 1, "created once");
    assert_eq!(seen.interaction_keys.len(), 2, "asked twice");
    assert_eq!(seen.interaction_keys[0], seen.interaction_keys[1]);
    assert!(!seen.interaction_keys[0].is_empty());
    assert_eq!(seen.revokes, 0);
    assert!(seen.cancels.is_empty());
}

#[tokio::test]
async fn a_lost_request_reply_is_found_again_under_the_same_key() {
    let server = serve_with(vec![Step::Spend], 201, Fault::LoseFirstSubjectReply).await;
    let outcome = emit(quick(&server)).await;
    assert_eq!(
        outcome.expect("approved after the retry").verdict.decision,
        Decision::Allow
    );
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.auth_requests.len(), 1, "raised once");
    assert_eq!(seen.subject_keys.len(), 2);
    assert_eq!(seen.subject_keys[0], seen.subject_keys[1]);
}

#[tokio::test]
async fn keys_are_never_shared_between_asks_or_between_the_two_creates() {
    let server = serve(vec![Step::Spend], 201).await;
    let approver = approver(&server.base);
    for _ in 0..2 {
        let context = deploy_context();
        approver
            .ask(prompt(&context))
            .await
            .expect("the mock spends at once");
    }
    let seen = server.seen.lock().unwrap();
    let mut keys: Vec<&String> = seen
        .subject_keys
        .iter()
        .chain(seen.interaction_keys.iter())
        .collect();
    assert_eq!(keys.len(), 4);
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), 4, "a shared key would replay a stale answer");
}

#[tokio::test]
async fn a_server_that_reports_a_digest_over_other_content_is_never_believed() {
    // Everything the server reports agrees with itself — the create's digest,
    // the consumed digest, the details it echoes — but the digest is not the
    // digest of what was sent. The approval is spent and reported unbound.
    let server = serve_with(vec![Step::Spend], 201, Fault::WrongDigest).await;
    let outcome = emit(approver(&server.base)).await;
    denied_with(&outcome, REASON_APPROVAL_NOT_BOUND);
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.revokes, 1, "an approval we refused is withdrawn");
    assert_eq!(seen.cancels, [SUBJECT_ID]);
}
