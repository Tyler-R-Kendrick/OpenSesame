//! The interceptor driven by the canonical agent-hooks host
//! (`InterceptionEmitter`), so every verdict passes the SDK's own §5
//! validation, composition and record projection — the path a real Rust host
//! takes.

use opensesame_agent_hooks::interceptor::{
    REASON_RAW_SECRET, REASON_SECRET_REDACTED, REASON_TOOL_DENIED, REASON_TOOL_REQUIRES_APPROVAL,
};
use opensesame_agent_hooks::sdk::{
    AgentContextBuilder, Decision, EnforcementMode, InterceptionEmitter, InterceptionRecord,
};
use opensesame_agent_hooks::{HookPolicy, OpenSesameInterceptor};
use serde_json::{json, Value};

fn github_token() -> String {
    format!("ghp_{}", "T".repeat(36))
}

fn policy() -> HookPolicy {
    HookPolicy::parse(
        r#"{
          "version": 1,
          "tools": [
            {"prefix": "github.", "decision": "allow"},
            {"name": "shell", "decision": "deny"},
            {"name": "deploy", "decision": "escalate"}
          ]
        }"#,
    )
    .expect("policy parses")
}

fn emitter(policy: HookPolicy) -> InterceptionEmitter {
    let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, None);
    emitter.register(Box::new(OpenSesameInterceptor::new(policy)));
    emitter
}

fn builder() -> AgentContextBuilder {
    AgentContextBuilder::new("support-agent", "opensesame-test", "session-1")
}

fn record_json(record: &InterceptionRecord) -> String {
    serde_json::to_string(record).expect("record serializes")
}

#[tokio::test]
async fn an_allowed_tool_proceeds_and_a_denied_one_does_not_dispatch() {
    let mut emitter = emitter(policy());
    let mut b = builder();

    let mut ctx = b.pre_tool_call("c1", "github.issues.list", json!({"repo": "acme/app"}));
    let outcome = emitter.emit(&mut ctx).await.expect("allowed");
    assert_eq!(outcome.record.verdict.decision, Decision::Allow);
    assert_eq!(outcome.target, json!({"repo": "acme/app"}));

    let mut ctx = b.pre_tool_call("c2", "shell", json!({"cmd": "ls"}));
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_TOOL_DENIED)
    );
    assert_eq!(blocked.record.decided_by, Some(0));
    assert_eq!(
        blocked.record.verdict.approval, None,
        "a plain deny is not liftable"
    );
}

#[tokio::test]
async fn an_escalated_tool_is_a_deny_until_something_lifts_it() {
    let mut emitter = emitter(policy());
    let mut ctx = builder().pre_tool_call("c1", "deploy", json!({"env": "prod"}));
    let blocked = emitter
        .emit(&mut ctx)
        .await
        .expect_err("no resolver registered");
    let verdict = &blocked.record.verdict;
    assert_eq!(verdict.decision, Decision::Deny);
    assert_eq!(
        verdict.reason.as_deref(),
        Some(REASON_TOOL_REQUIRES_APPROVAL)
    );
    assert!(
        verdict.approval.is_some(),
        "liftable: carries an approval block"
    );
}

#[tokio::test]
async fn an_unlisted_tool_escalates_by_default() {
    let mut emitter = emitter(HookPolicy::default());
    let mut ctx = builder().pre_tool_call("c1", "anything", json!({}));
    let blocked = emitter.emit(&mut ctx).await.expect_err("fail closed");
    assert!(blocked.record.verdict.is_liftable());
}

#[tokio::test]
async fn a_raw_secret_in_tool_arguments_is_a_plain_deny_even_for_an_allowed_tool() {
    let token = github_token();
    let mut emitter = emitter(policy());
    let mut ctx = builder().pre_tool_call(
        "c1",
        "github.repos.get",
        json!({"repo": "acme/app", "auth": token}),
    );
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    let verdict = &blocked.record.verdict;
    assert_eq!(verdict.reason.as_deref(), Some(REASON_RAW_SECRET));
    assert_eq!(verdict.approval, None);
    assert!(!record_json(&blocked.record).contains(&token));

    // An escalated tool with a secret in its arguments is not offered to a
    // person either.
    let mut ctx = builder().pre_tool_call("c2", "deploy", json!({"key": github_token()}));
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_RAW_SECRET)
    );
    assert!(!blocked.record.verdict.is_liftable());
}

#[tokio::test]
async fn a_secret_in_a_tool_result_is_redacted_before_the_model_reads_it() {
    let token = github_token();
    let mut emitter = emitter(policy());
    let mut ctx = builder().post_tool_call(
        "c1",
        "github.actions.env",
        json!({}),
        json!({"stdout": format!("GITHUB_TOKEN={token}\nok")}),
        false,
    );
    let outcome = emitter.emit(&mut ctx).await.expect("transform proceeds");
    let record = &outcome.record;
    assert_eq!(record.verdict.decision, Decision::Transform);
    assert_eq!(
        record.verdict.reason.as_deref(),
        Some(REASON_SECRET_REDACTED)
    );
    assert_eq!(
        outcome.target,
        json!({"stdout": "GITHUB_TOKEN=[redacted:github_token]\nok"})
    );
    // §4.3 write-back: the tool result the loop keeps is the redacted one.
    assert_eq!(ctx["tool_result"]["value"], outcome.target);
    assert_ne!(record.input_identity, record.enforced_identity);
    // §10.3: the record drops transform.value; the secret never reaches it.
    let persisted = record_json(record);
    assert!(!persisted.contains(&token), "{persisted}");
    assert!(persisted.contains("github_token×1"));
}

#[tokio::test]
async fn every_content_seam_is_guarded() {
    let token = github_token();
    let mut emitter = emitter(policy());
    let mut b = builder();
    let mut contexts = vec![
        b.input(json!(format!("my token is {token}")), "user"),
        b.pre_model_call(
            "model-x",
            vec![json!({"role": "user", "content": format!("use {token}")})],
        ),
        b.post_model_call("model-x", json!(format!("Here: {token}")), vec![], "stop"),
        b.output(json!(format!("done, token {token}"))),
    ];
    for ctx in &mut contexts {
        let outcome = emitter.emit(ctx).await.expect("redacted, not blocked");
        assert_eq!(outcome.record.verdict.decision, Decision::Transform);
        let target: Value = outcome.target;
        assert!(!target.to_string().contains(&token), "{target}");
    }
}

#[tokio::test]
async fn the_deny_posture_blocks_instead_of_rewriting() {
    let mut policy = policy();
    policy.secret_guard = opensesame_agent_hooks::SecretGuard::Deny;
    let mut emitter = emitter(policy);
    let mut ctx = builder().output(json!(format!("token {}", github_token())));
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_RAW_SECRET)
    );
}

#[tokio::test]
async fn session_boundaries_and_clean_content_are_allowed() {
    let mut emitter = emitter(policy());
    let mut b = builder();
    let mut contexts = vec![
        b.agent_startup(vec!["github.issues.list".into(), "shell".into()]),
        b.input(json!("list my open issues"), "user"),
        b.output(json!({"issues": 3})),
        b.agent_shutdown("completed"),
    ];
    for ctx in &mut contexts {
        let outcome = emitter.emit(ctx).await.expect("allowed");
        assert_eq!(outcome.record.verdict.decision, Decision::Allow);
    }
}

#[tokio::test]
async fn evaluate_only_records_the_verdict_and_changes_nothing() {
    let mut emitter = InterceptionEmitter::new(EnforcementMode::EvaluateOnly, None);
    emitter.register(Box::new(OpenSesameInterceptor::new(policy())));
    let token = github_token();
    let mut ctx = builder().output(json!(format!("token {token}")));
    let outcome = emitter
        .emit(&mut ctx)
        .await
        .expect("evaluate_only proceeds");
    assert_eq!(outcome.record.verdict.decision, Decision::Transform);
    assert!(outcome.target.to_string().contains(&token), "not applied");
}

#[tokio::test]
async fn a_default_message_never_repeats_the_tool_name_the_context_supplied() {
    let mut emitter = emitter(policy());
    let name = "shell";
    let mut ctx = builder().pre_tool_call("c1", name, json!({}));
    let denied = emitter.emit(&mut ctx).await.expect_err("denied");
    let mut ctx = builder().pre_tool_call("c2", "deploy", json!({}));
    let escalated = emitter.emit(&mut ctx).await.expect_err("escalated");
    for blocked in [denied, escalated] {
        let message = blocked.record.verdict.message.expect("has a message");
        assert!(!message.contains(name) && !message.contains("deploy"));
    }
}
