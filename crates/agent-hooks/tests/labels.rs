//! Result labels and label-flow control (spec §5.4, §7.3), driven through
//! the canonical `InterceptionEmitter` so every verdict passes the SDK's own
//! validation, composition and record projection.

use opensesame_agent_hooks::interceptor::{
    REASON_CONTEXT_UNREADABLE, REASON_RAW_SECRET, REASON_TOOL_DENIED,
};
use opensesame_agent_hooks::sdk::{
    AgentContext, AgentContextBuilder, Decision, EnforcementMode, InterceptionEmitter,
    InterceptionRecord,
};
use opensesame_agent_hooks::{
    HookPolicy, OpenSesameInterceptor, SecretGuard, LABEL_CREDENTIAL_MATERIAL,
    REASON_LABEL_FLOW_DENIED,
};
use serde_json::{json, Value};

fn github_token() -> String {
    format!("ghp_{}", "L".repeat(36))
}

fn policy() -> HookPolicy {
    HookPolicy::parse(
        r#"{
          "version": 1,
          "tools": [
            {"prefix": "crm.", "decision": "allow", "labels": ["acme:pii"]},
            {"name": "vault.read", "decision": "allow",
             "labels": ["acme:secret_adjacent", "opensesame:credential_material"]},
            {"name": "email.send", "decision": "allow", "refuse_labels": ["acme:pii", "acme:hr"]},
            {"name": "deploy", "decision": "escalate", "refuse_labels": ["acme:pii"]},
            {"name": "shell", "decision": "deny", "refuse_labels": ["acme:pii"]},
            {"name": "notes.write", "decision": "allow"}
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

fn with_sources(mut ctx: AgentContext, ours: Value) -> AgentContext {
    let extensions = serde_json::Map::from_iter([("opensesame".to_owned(), ours)]);
    ctx.insert("extensions".into(), Value::Object(extensions));
    ctx
}

fn tool_call(name: &str, sources: &[&str]) -> AgentContext {
    with_sources(
        builder().pre_tool_call("c1", name, json!({"to": "a@example.test"})),
        json!({ "source_labels": sources }),
    )
}

fn labels(record: &InterceptionRecord) -> Vec<&str> {
    record
        .verdict
        .result_labels
        .iter()
        .map(String::as_str)
        .collect()
}

#[tokio::test]
async fn every_guard_rewrite_carries_the_credential_material_label() {
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
        b.post_tool_call(
            "c1",
            "notes.write",
            json!({}),
            json!(format!("saved {token}")),
            false,
        ),
        b.output(json!(format!("done, token {token}"))),
    ];
    for ctx in &mut contexts {
        let outcome = emitter.emit(ctx).await.expect("redacted, not blocked");
        assert_eq!(outcome.record.verdict.decision, Decision::Transform);
        assert_eq!(labels(&outcome.record), [LABEL_CREDENTIAL_MATERIAL]);
        let persisted = serde_json::to_string(&outcome.record).expect("record");
        assert!(persisted.contains(LABEL_CREDENTIAL_MATERIAL), "{persisted}");
        assert!(!persisted.contains(&token), "{persisted}");
    }
}

#[tokio::test]
async fn clean_content_and_unlabelled_tools_carry_no_label() {
    let mut emitter = emitter(policy());
    let mut b = builder();
    let mut contexts = vec![
        b.input(json!("list my open issues"), "user"),
        b.post_tool_call("c1", "notes.write", json!({}), json!("ok"), false),
        b.post_tool_call("c2", "unlisted.tool", json!({}), json!("ok"), false),
        b.output(json!({"issues": 3})),
    ];
    for ctx in &mut contexts {
        let outcome = emitter.emit(ctx).await.expect("allowed");
        assert_eq!(outcome.record.verdict.decision, Decision::Allow);
        assert!(labels(&outcome.record).is_empty());
    }
}

#[tokio::test]
async fn a_labelled_tool_result_carries_its_rule_labels() {
    let mut emitter = emitter(policy());
    let mut ctx = builder().post_tool_call(
        "c1",
        "crm.contacts.get",
        json!({"id": 7}),
        json!({"name": "Ada"}),
        false,
    );
    let outcome = emitter.emit(&mut ctx).await.expect("allowed");
    assert_eq!(outcome.record.verdict.decision, Decision::Allow);
    assert_eq!(labels(&outcome.record), ["acme:pii"]);

    // The guard fired too: the rule's labels first, then the built-in one.
    let mut ctx = builder().post_tool_call(
        "c2",
        "crm.contacts.get",
        json!({"id": 7}),
        json!({"api_key": github_token()}),
        false,
    );
    let outcome = emitter.emit(&mut ctx).await.expect("transform proceeds");
    assert_eq!(outcome.record.verdict.decision, Decision::Transform);
    assert_eq!(
        labels(&outcome.record),
        ["acme:pii", LABEL_CREDENTIAL_MATERIAL]
    );
}

#[tokio::test]
async fn labels_are_deduplicated_in_first_seen_order() {
    let mut emitter = emitter(policy());
    let mut ctx = builder().post_tool_call(
        "c1",
        "vault.read",
        json!({}),
        json!(format!("value {}", github_token())),
        false,
    );
    let outcome = emitter.emit(&mut ctx).await.expect("transform proceeds");
    assert_eq!(
        labels(&outcome.record),
        ["acme:secret_adjacent", LABEL_CREDENTIAL_MATERIAL]
    );
}

#[tokio::test]
async fn the_guard_off_still_labels_a_tool_result() {
    let mut policy = policy();
    policy.secret_guard = SecretGuard::Off;
    let mut emitter = emitter(policy);
    let mut ctx = builder().post_tool_call("c1", "crm.x", json!({}), json!("ok"), false);
    let outcome = emitter.emit(&mut ctx).await.expect("allowed");
    assert_eq!(labels(&outcome.record), ["acme:pii"]);
}

#[tokio::test]
async fn a_deny_carries_no_result_labels() {
    // §5.4: nothing is persisted for an action that did not proceed. The
    // deny posture refuses a labelled tool's result carrying a secret.
    let mut policy = policy();
    policy.secret_guard = SecretGuard::Deny;
    let mut emitter = emitter(policy);
    let mut ctx = builder().post_tool_call(
        "c1",
        "crm.contacts.get",
        json!({}),
        json!(github_token()),
        false,
    );
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_RAW_SECRET)
    );
    assert!(labels(&blocked.record).is_empty());
    let persisted = serde_json::to_string(&blocked.record).expect("record");
    assert!(!persisted.contains("result_labels"), "{persisted}");
}

#[tokio::test]
async fn a_refused_label_in_the_inputs_is_a_plain_deny() {
    let mut emitter = emitter(policy());
    let mut ctx = tool_call("email.send", &["zz:unrelated", "acme:hr", "acme:pii"]);
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    let verdict = &blocked.record.verdict;
    assert_eq!(verdict.reason.as_deref(), Some(REASON_LABEL_FLOW_DENIED));
    assert!(!verdict.is_liftable());
    assert!(labels(&blocked.record).is_empty());
    let message = verdict.message.as_deref().expect("message");
    // Named in the policy's order; a label only the context holds is never
    // repeated back.
    assert!(message.contains("acme:pii, acme:hr"), "{message}");
    assert!(!message.contains("zz:unrelated"), "{message}");

    let mut ctx = tool_call("email.send", &["zz:unrelated"]);
    let outcome = emitter.emit(&mut ctx).await.expect("no intersection");
    assert_eq!(outcome.record.verdict.decision, Decision::Allow);
}

#[tokio::test]
async fn label_flow_outranks_escalate_but_not_a_rule_deny_or_a_raw_secret() {
    let mut emitter = emitter(policy());

    let mut ctx = tool_call("deploy", &["acme:pii"]);
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_LABEL_FLOW_DENIED)
    );
    assert!(
        !blocked.record.verdict.is_liftable(),
        "not offered to a person"
    );

    let mut ctx = tool_call("shell", &["acme:pii"]);
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_TOOL_DENIED)
    );

    let mut ctx = with_sources(
        builder().pre_tool_call("c1", "email.send", json!({"auth": github_token()})),
        json!({ "source_labels": ["acme:pii"] }),
    );
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_RAW_SECRET)
    );
}

#[tokio::test]
async fn a_policy_wide_refusal_covers_every_tool() {
    let mut policy = policy();
    policy.refuse_labels = vec![LABEL_CREDENTIAL_MATERIAL.into()];
    policy.check().expect("valid");
    let mut emitter = emitter(policy);
    for tool in ["notes.write", "unlisted.tool", "email.send"] {
        let mut ctx = tool_call(tool, &[LABEL_CREDENTIAL_MATERIAL]);
        let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
        let verdict = &blocked.record.verdict;
        assert_eq!(
            verdict.reason.as_deref(),
            Some(REASON_LABEL_FLOW_DENIED),
            "{tool}"
        );
        assert!(!verdict.is_liftable(), "{tool}");
    }
    // A rule's list and the policy-wide one are named together, once each.
    let mut ctx = tool_call("email.send", &[LABEL_CREDENTIAL_MATERIAL, "acme:pii"]);
    let blocked = emitter.emit(&mut ctx).await.expect_err("denied");
    let message = blocked.record.verdict.message.clone().expect("message");
    assert!(
        message.contains(&format!("acme:pii, {LABEL_CREDENTIAL_MATERIAL}")),
        "{message}"
    );
}

#[tokio::test]
async fn labels_a_result_earned_refuse_the_next_call_once_resurfaced() {
    let mut emitter = emitter(policy());
    let mut b = builder();
    let mut result = b.post_tool_call("c1", "crm.contacts.get", json!({}), json!("Ada"), false);
    let outcome = emitter.emit(&mut result).await.expect("allowed");
    // The host persists the labels and resurfaces them (§5.4).
    let persisted = outcome.record.verdict.result_labels.clone();
    let mut next = with_sources(
        b.pre_tool_call("c2", "email.send", json!({"body": "Ada"})),
        json!({ "source_labels": persisted }),
    );
    let blocked = emitter.emit(&mut next).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_LABEL_FLOW_DENIED)
    );
}

#[tokio::test]
async fn malformed_source_labels_fail_closed() {
    let mut emitter = emitter(policy());
    for ours in [
        json!("acme:pii"),
        json!({"source_labels": "acme:pii"}),
        json!({"source_labels": [1]}),
        json!({"source_labels": ["acme:pii", null]}),
        json!({"source_labels": {"acme:pii": true}}),
    ] {
        // Even a tool that refuses nothing: a garbled namespace is not read
        // as "no labels".
        let mut ctx = with_sources(
            builder().pre_tool_call("c1", "notes.write", json!({})),
            ours.clone(),
        );
        let blocked = emitter.emit(&mut ctx).await.expect_err("fail closed");
        let verdict = &blocked.record.verdict;
        assert_eq!(
            verdict.reason.as_deref(),
            Some(REASON_CONTEXT_UNREADABLE),
            "{ours}"
        );
        assert!(!verdict.is_liftable(), "{ours}");
        assert!(labels(&blocked.record).is_empty());
    }
    // Other namespaces are not ours to read.
    let mut ctx = builder().pre_tool_call("c1", "notes.write", json!({}));
    ctx.insert("extensions".into(), json!({"acme": {"source_labels": 7}}));
    emitter.emit(&mut ctx).await.expect("allowed");
}

#[test]
fn a_non_object_extensions_member_fails_closed() {
    let interceptor = OpenSesameInterceptor::new(policy());
    let mut ctx = builder().pre_tool_call("c1", "notes.write", json!({}));
    ctx.insert("extensions".into(), json!(["opensesame"]));
    let verdict = interceptor.decide(&ctx);
    assert_eq!(verdict.decision, Decision::Deny);
    assert_eq!(verdict.reason.as_deref(), Some(REASON_CONTEXT_UNREADABLE));
}

#[test]
fn a_tool_result_without_a_tool_name_fails_closed() {
    let interceptor = OpenSesameInterceptor::new(policy());
    let mut ctx = builder().post_tool_call("c1", "crm.x", json!({}), json!("ok"), false);
    ctx.remove("tool_call");
    let verdict = interceptor.decide(&ctx);
    assert_eq!(verdict.reason.as_deref(), Some(REASON_CONTEXT_UNREADABLE));
    assert!(verdict.result_labels.is_empty());
}
