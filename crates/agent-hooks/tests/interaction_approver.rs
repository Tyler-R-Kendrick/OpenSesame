//! The Interaction-backed approver, driven through the canonical host against
//! a scripted Identity API: an approval lifts the deny only once it has been
//! spent and its binding reaches this emission's `context_identity`.

mod interaction_mock;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use interaction_mock::{
    approver, config, serve, serve_under, Step, APPROVER_REF, BEARER, OTHER_DIGEST, SERVER_PROSE,
};
use opensesame_agent_hooks::approval::REASON_APPROVAL_NOT_BOUND;
use opensesame_agent_hooks::sdk::{
    AgentContext, AgentContextBuilder, Decision, EnforcementMode, InterceptionEmitter,
    InterceptionRecord,
};
use opensesame_agent_hooks::{
    redact_for_approver, BoundApprovalResolver, HookPolicy, InteractionApprover,
    OpenSesameInterceptor,
};
use serde_json::{json, Value};

const UNRESOLVED: &str = "host_error:approval_unresolved";

fn emitter(approver: InteractionApprover) -> InterceptionEmitter {
    let policy = HookPolicy::parse(
        r#"{"version": 1, "tools": [{"name": "deploy", "decision": "escalate"}]}"#,
    )
    .expect("policy parses");
    let resolver = BoundApprovalResolver::new(approver);
    let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, Some(Box::new(resolver)));
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

/// Emit once through an approver against a mock scripted with `script`.
async fn run(
    script: Vec<Step>,
) -> (
    Result<InterceptionRecord, InterceptionRecord>,
    interaction_mock::Server,
) {
    let server = serve(script, 201).await;
    let mut emitter = emitter(approver(&server.base));
    let outcome = emitter
        .emit(&mut deploy_context())
        .await
        .map(|o| o.record)
        .map_err(|b| b.record);
    (outcome, server)
}

fn denied_with(outcome: &Result<InterceptionRecord, InterceptionRecord>, reason: &str) {
    let record = outcome.as_ref().expect_err("the action must stay denied");
    assert_eq!(record.verdict.decision, Decision::Deny);
    assert_eq!(record.verdict.reason.as_deref(), Some(reason));
    let message = record.verdict.message.clone().unwrap_or_default();
    assert!(!message.contains(SERVER_PROSE), "server prose echoed");
}

#[tokio::test]
async fn an_approval_spent_exactly_once_lifts_the_deny() {
    let (outcome, server) = run(vec![Step::Pending, Step::Pending, Step::Spend]).await;
    let record = outcome.expect("approved");
    assert_eq!(record.verdict.decision, Decision::Allow);
    assert_eq!(record.resolved_by, Some("approval"));

    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.consumes, 3, "polls until spent, then stops");
    assert_eq!(seen.revokes, 0, "a spent approval is not withdrawn");
    assert!(seen.cancels.is_empty(), "nor is the request it settled");
    assert!(seen
        .bearers
        .iter()
        .all(|b| b == &format!("Bearer {BEARER}")));

    // The identity rides in the one detail both requests carry, so the
    // server's request digest covers it.
    let subject = &seen.auth_requests[0];
    let fronted = &seen.interactions[0];
    assert_eq!(subject["approverRef"], APPROVER_REF);
    assert_eq!(fronted["kind"], "authorization_request");
    assert_eq!(
        fronted["subject"],
        json!({"kind": "authorization_request", "subjectId": "areq_1"})
    );
    assert_eq!(
        subject["authorizationDetails"],
        fronted["authorizationDetails"]
    );
    let detail = &fronted["authorizationDetails"][0];
    let identity = detail["context_identity"].as_str().expect("identity");
    assert!(
        identity.starts_with("sha256:") && identity.len() == 71,
        "{identity}"
    );
    assert_eq!(detail["interception_point"], "pre_tool_call");
    assert_eq!(detail["locations"], json!(["deploy"]));
    assert_eq!(detail["reason"], "opensesame:tool_requires_approval");
}

#[tokio::test]
async fn an_unanswered_interaction_is_unresolved_at_the_deadline() {
    // Nobody answers (401 approval_required): the deadline passes and the
    // deny stands. A refusal is not this case (`interaction_lifecycle.rs`).
    let server = serve(vec![Step::Reply(401, "approval_required")], 201).await;
    let approver =
        InteractionApprover::new(config(&server.base, Duration::from_millis(200))).unwrap();
    let blocked = emitter(approver)
        .emit(&mut deploy_context())
        .await
        .expect_err("unanswered");
    denied_with(&Err(blocked.record), UNRESOLVED);
    let seen = server.seen.lock().unwrap();
    assert!(seen.consumes >= 2);
    assert_eq!(seen.revokes, 1, "the unanswered interaction is withdrawn");
    assert_eq!(seen.cancels, ["areq_1"], "and so is the request it fronted");
}

#[tokio::test]
async fn an_expired_interaction_is_unresolved() {
    let (outcome, server) = run(vec![Step::Pending, Step::Reply(410, "interaction_expired")]).await;
    denied_with(&outcome, UNRESOLVED);
    assert_eq!(server.seen.lock().unwrap().revokes, 1);
}

#[tokio::test]
async fn a_spend_whose_details_do_not_carry_this_identity_is_a_reject() {
    fn strip(detail: &mut Value) {
        detail["authorizationDetails"][0]
            .as_object_mut()
            .unwrap()
            .remove("context_identity");
    }
    fn swap(detail: &mut Value) {
        detail["authorizationDetails"][0]["context_identity"] = json!(OTHER_DIGEST);
    }
    fn duplicate(detail: &mut Value) {
        let copy = detail["authorizationDetails"][0].clone();
        detail["authorizationDetails"]
            .as_array_mut()
            .unwrap()
            .push(copy);
    }
    for alter in [strip as fn(&mut Value), swap, duplicate] {
        let (outcome, _server) = run(vec![Step::SpendAltered(alter)]).await;
        denied_with(&outcome, REASON_APPROVAL_NOT_BOUND);
    }
}

#[tokio::test]
async fn a_spend_bound_to_another_digest_is_a_reject() {
    fn other(detail: &mut Value) {
        detail["requestDigest"] = json!(OTHER_DIGEST);
    }
    fn missing(detail: &mut Value) {
        detail.as_object_mut().unwrap().remove("requestDigest");
    }
    fn not_consumed(detail: &mut Value) {
        detail["status"] = json!("approved");
    }
    for alter in [other as fn(&mut Value), missing, not_consumed] {
        let (outcome, _server) = run(vec![Step::SpendAltered(alter)]).await;
        denied_with(&outcome, REASON_APPROVAL_NOT_BOUND);
    }
}

#[tokio::test]
async fn an_approval_the_server_refuses_to_bind_is_a_reject() {
    let (outcome, server) = run(vec![Step::Reply(409, "digest_mismatch")]).await;
    denied_with(&outcome, REASON_APPROVAL_NOT_BOUND);
    assert_eq!(server.seen.lock().unwrap().revokes, 1);
}

#[tokio::test]
async fn a_lost_consume_race_is_unresolved_never_an_approval() {
    // Somebody holding this requester's bearer spent the approval first.
    // Reporting it here would replay one approval for two emissions.
    let (outcome, _server) = run(vec![Step::Reply(409, "interaction_consumed")]).await;
    denied_with(&outcome, UNRESOLVED);
}

#[tokio::test]
async fn a_withdrawn_interaction_is_unresolved() {
    let (outcome, _server) = run(vec![Step::Reply(409, "interaction_revoked")]).await;
    denied_with(&outcome, UNRESOLVED);
}

#[tokio::test]
async fn a_server_error_is_unresolved_and_withdraws() {
    for status in [500, 502, 503] {
        let (outcome, server) = run(vec![Step::Reply(status, "internal")]).await;
        denied_with(&outcome, UNRESOLVED);
        assert_eq!(server.seen.lock().unwrap().revokes, 1);
    }
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let (outcome, server) = run(vec![Step::Redirect]).await;
    denied_with(&outcome, UNRESOLVED);
    assert_eq!(server.seen.lock().unwrap().redirected, 0);
}

#[tokio::test]
async fn an_oversized_spend_cannot_be_verified_and_is_a_reject() {
    let (outcome, _server) = run(vec![Step::Oversized]).await;
    denied_with(&outcome, REASON_APPROVAL_NOT_BOUND);
}

#[tokio::test]
async fn an_interaction_that_cannot_be_raised_is_unresolved() {
    let server = serve(vec![Step::Spend], 409).await;
    let blocked = emitter(approver(&server.base))
        .emit(&mut deploy_context())
        .await
        .expect_err("not raised");
    denied_with(&Err(blocked.record), UNRESOLVED);
    assert_eq!(server.seen.lock().unwrap().consumes, 0);
}

#[tokio::test]
async fn the_link_is_handed_to_the_host_and_no_secret_leaves() {
    let server = serve(vec![Step::Spend], 201).await;
    let links = Arc::new(Mutex::new(Vec::new()));
    let sink = links.clone();
    let approver = approver(&server.base).with_on_pending(Arc::new(move |url: &str| {
        sink.lock().unwrap().push(url.to_owned());
    }));
    let token = format!("ghp_{}", "S".repeat(36));
    let mut ctx = AgentContextBuilder::new("release-agent", "opensesame-test", "session-1")
        .pre_tool_call("c1", "deploy", json!({"env": "prod", "note": "plain"}));
    ctx.insert(
        "messages".into(),
        json!([{"role": "user", "content": token}]),
    );
    let outcome = emitter(approver).emit(&mut ctx).await.expect("approved");
    assert_eq!(outcome.record.verdict.decision, Decision::Allow);

    let links = links.lock().unwrap();
    assert_eq!(
        links.as_slice(),
        [format!("{}/i/{}", server.base, interaction_mock::REF)]
    );
    let seen = server.seen.lock().unwrap();
    let sent = serde_json::to_string(&(&seen.auth_requests, &seen.interactions)).unwrap();
    assert!(
        !sent.contains(&token),
        "a credential left for the Identity API"
    );
    assert!(
        !sent.contains("prod") && !sent.contains("plain"),
        "tool arguments left"
    );
}

#[tokio::test]
async fn the_deadline_is_a_wall_even_mid_attempt() {
    // The server holds the consume past the deadline and would then spend:
    // the attempt is abandoned at the deadline and nothing is reported.
    let server = serve(vec![Step::Stall(Duration::from_secs(3))], 201).await;
    let approver =
        InteractionApprover::new(config(&server.base, Duration::from_millis(200))).unwrap();
    let started = std::time::Instant::now();
    let blocked = emitter(approver)
        .emit(&mut deploy_context())
        .await
        .expect_err("past the deadline");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the deadline held"
    );
    denied_with(&Err(blocked.record), UNRESOLVED);
    assert_eq!(server.seen.lock().unwrap().revokes, 1);
}

#[tokio::test]
async fn a_dropped_ask_still_withdraws_its_interaction() {
    use std::sync::atomic::{AtomicBool, Ordering};

    use opensesame_agent_hooks::sdk::InterceptionPoint;
    use opensesame_agent_hooks::{ApprovalPrompt, HumanApprover};

    let server = serve(vec![Step::Pending], 201).await;
    let raised = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&raised);
    // `on_pending` runs only after the withdraw guard is armed.
    let approver = approver(&server.base).with_on_pending(Arc::new(move |_| {
        flag.store(true, Ordering::SeqCst);
    }));
    let context = deploy_context();
    let prompt = ApprovalPrompt {
        context_identity: interaction_mock::DIGEST,
        interception_point: InterceptionPoint::PreToolCall,
        reason: Some("opensesame:tool_requires_approval"),
        message: None,
        context: &context,
    };
    // The pin binding is only a reference. Leaving the block drops `ask`
    // itself, after the interaction exists and before the approver's deadline.
    {
        let ask = approver.ask(prompt);
        tokio::pin!(ask);
        let give_up = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            tokio::select! {
                result = &mut ask => {
                    let _ = result;
                    panic!("ask finished before the host cancelled it");
                }
                () = tokio::time::sleep(Duration::from_millis(10)) => {
                    if raised.load(Ordering::SeqCst) {
                        break;
                    }
                    assert!(
                        tokio::time::Instant::now() < give_up,
                        "the interaction was not raised"
                    );
                }
            }
        }
    }
    for _ in 0..200 {
        if server.seen.lock().unwrap().revokes > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let seen = server.seen.lock().unwrap();
    assert_eq!(
        seen.interactions.len(),
        1,
        "the ask had raised an interaction"
    );
    assert_eq!(seen.revokes, 1, "a cancelled ask leaves nothing answerable");
}

#[tokio::test]
async fn an_identity_api_behind_a_path_prefix_is_reached_under_it() {
    // A base with a path (`/idp`), with and without its trailing slash, keeps
    // that path on every route the approver speaks.
    for suffix in ["", "/"] {
        let server = serve_under("/idp", vec![Step::Spend], 201).await;
        let base = format!("{}{suffix}", server.base);
        let outcome = emitter(approver(&base))
            .emit(&mut deploy_context())
            .await
            .map(|o| o.record);
        let record = outcome.unwrap_or_else(|_| panic!("approved under {base}"));
        assert_eq!(record.verdict.decision, Decision::Allow);
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.auth_requests.len(), 1, "{base}");
        assert_eq!(seen.interactions.len(), 1, "{base}");
    }
}
