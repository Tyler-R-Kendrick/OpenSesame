//! Carried labels: a permit names the resurfaced labels the policy knows, so
//! a label survives a host that resurfaces one hop at a time (spec §5.4), and
//! a context string the policy never named is never echoed into the record.

use opensesame_agent_hooks::interceptor::REASON_CONTEXT_UNREADABLE;
use opensesame_agent_hooks::sdk::{
    AgentContext, AgentContextBuilder, EnforcementMode, InterceptionEmitter, InterceptionRecord,
};
use opensesame_agent_hooks::{
    HookPolicy, OpenSesameInterceptor, LABEL_CREDENTIAL_MATERIAL, REASON_LABEL_FLOW_DENIED,
};
use serde_json::{json, Value};

fn github_token() -> String {
    format!("ghp_{}", "P".repeat(36))
}

fn policy() -> HookPolicy {
    HookPolicy::parse(
        r#"{
          "version": 1,
          "tools": [
            {"prefix": "crm.", "decision": "allow", "labels": ["acme:pii"]},
            {"name": "http.post", "decision": "allow", "refuse_labels": ["acme:pii"]},
            {"name": "notes.write", "decision": "allow"},
            {"name": "deploy", "decision": "escalate"}
          ],
          "refuse_labels": ["opensesame:credential_material"]
        }"#,
    )
    .expect("policy parses")
}

fn emitter() -> InterceptionEmitter {
    let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, None);
    emitter.register(Box::new(OpenSesameInterceptor::new(policy())));
    emitter
}

fn builder() -> AgentContextBuilder {
    AgentContextBuilder::new("support-agent", "opensesame-test", "session-1")
}

/// What a one-hop host does: resurface the labels persisted with the data
/// this emission's target derives from.
fn resurface(mut ctx: AgentContext, persisted: &[String]) -> AgentContext {
    ctx.insert(
        "extensions".into(),
        json!({"opensesame": {"source_labels": persisted}}),
    );
    ctx
}

fn labels(record: &InterceptionRecord) -> Vec<&str> {
    record
        .verdict
        .result_labels
        .iter()
        .map(String::as_str)
        .collect()
}

fn messages(text: &str) -> Vec<Value> {
    vec![json!({"role": "user", "content": text})]
}

#[tokio::test]
async fn a_tool_result_label_survives_the_model_hop_to_the_next_tool_call() {
    let mut emitter = emitter();
    let mut b = builder();
    let mut result = b.post_tool_call("c1", "crm.contacts.get", json!({}), json!("Ada"), false);
    let persisted = emitter.emit(&mut result).await.expect("allowed").record;
    assert_eq!(labels(&persisted), ["acme:pii"]);
    // The model reads the result: its output is persisted with what the
    // pre_model_call permit named.
    let mut model_in = resurface(
        b.pre_model_call("m", messages("Ada")),
        &persisted.verdict.result_labels,
    );
    let model = emitter.emit(&mut model_in).await.expect("allowed").record;
    assert_eq!(labels(&model), ["acme:pii"]);
    let mut model_out = resurface(
        b.post_model_call("m", json!("send Ada"), vec![], "stop"),
        &model.verdict.result_labels,
    );
    let answer = emitter.emit(&mut model_out).await.expect("allowed").record;
    assert_eq!(labels(&answer), ["acme:pii"]);
    // The model's tool call derives from its output: refused.
    let mut next = resurface(
        b.pre_tool_call("c2", "http.post", json!({"body": "Ada"})),
        &answer.verdict.result_labels,
    );
    let blocked = emitter.emit(&mut next).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_LABEL_FLOW_DENIED)
    );
    assert!(labels(&blocked.record).is_empty());
}

#[tokio::test]
async fn redacted_credential_material_refuses_every_later_tool_call() {
    let mut emitter = emitter();
    let mut b = builder();
    let token = github_token();
    let mut result = b.post_tool_call("c1", "notes.read", json!({}), json!(token), false);
    let redacted = emitter.emit(&mut result).await.expect("rewritten").record;
    assert_eq!(labels(&redacted), [LABEL_CREDENTIAL_MATERIAL]);
    let mut model_in = resurface(
        b.pre_model_call("m", messages("[redacted]")),
        &redacted.verdict.result_labels,
    );
    let model = emitter.emit(&mut model_in).await.expect("allowed").record;
    assert_eq!(labels(&model), [LABEL_CREDENTIAL_MATERIAL]);
    let mut next = resurface(
        b.pre_tool_call("c2", "notes.write", json!({})),
        &model.verdict.result_labels,
    );
    let blocked = emitter.emit(&mut next).await.expect_err("denied");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_LABEL_FLOW_DENIED)
    );
}

#[tokio::test]
async fn an_allowed_tool_call_carries_its_inputs_labels_to_the_result() {
    let mut emitter = emitter();
    let mut b = builder();
    let pii = ["acme:pii".to_owned()];
    let mut call = resurface(b.pre_tool_call("c1", "notes.write", json!({})), &pii);
    let allowed = emitter.emit(&mut call).await.expect("allowed").record;
    assert_eq!(labels(&allowed), ["acme:pii"]);
    // Rule labels come first, then carried ones, each once.
    let both = ["acme:pii".to_owned(), LABEL_CREDENTIAL_MATERIAL.to_owned()];
    let mut result = resurface(
        b.post_tool_call("c1", "crm.x", json!({}), json!("ok"), false),
        &both,
    );
    let record = emitter.emit(&mut result).await.expect("allowed").record;
    assert_eq!(labels(&record), ["acme:pii", LABEL_CREDENTIAL_MATERIAL]);
}

#[tokio::test]
async fn a_liftable_deny_carries_no_label() {
    let mut emitter = emitter();
    let pii = ["acme:pii".to_owned()];
    let mut call = resurface(builder().pre_tool_call("c1", "deploy", json!({})), &pii);
    let blocked = emitter.emit(&mut call).await.expect_err("escalated");
    assert!(blocked.record.verdict.is_liftable());
    assert!(labels(&blocked.record).is_empty());
}

#[tokio::test]
async fn a_label_the_policy_never_names_is_not_echoed() {
    let mut emitter = emitter();
    // A context string in label shape the policy does not know — and one
    // that is not a label at all — never reach the record.
    let foreign = ["acme:unknown".to_owned(), format!("x:{}", github_token())];
    let mut ctx = resurface(builder().pre_model_call("m", messages("hi")), &foreign);
    let record = emitter.emit(&mut ctx).await.expect("allowed").record;
    assert!(labels(&record).is_empty());
    let text = serde_json::to_string(&record).expect("record serializes");
    assert!(!text.contains("acme:unknown"));
    assert!(!text.contains(&github_token()));
}

#[test]
fn malformed_source_labels_fail_closed_at_every_content_seam() {
    let interceptor = OpenSesameInterceptor::new(policy());
    let mut b = builder();
    let seams = [
        b.input(json!("hi"), "user"),
        b.pre_model_call("m", messages("hi")),
        b.post_model_call("m", json!("hi"), vec![], "stop"),
        b.post_tool_call("c1", "crm.x", json!({}), json!("ok"), false),
        b.output(json!("hi")),
    ];
    for mut ctx in seams {
        ctx.insert(
            "extensions".into(),
            json!({"opensesame": {"source_labels": "acme:pii"}}),
        );
        let verdict = interceptor.decide(&ctx);
        assert_eq!(verdict.reason.as_deref(), Some(REASON_CONTEXT_UNREADABLE));
        assert!(!verdict.is_liftable());
        assert!(verdict.result_labels.is_empty());
    }
}
