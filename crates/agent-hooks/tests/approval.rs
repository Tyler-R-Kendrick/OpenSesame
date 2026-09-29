//! The approval seam bound to the request digest, driven through the
//! canonical host so the SDK enforces the echo rule and records the outcome.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use opensesame_agent_hooks::approval::{REASON_APPROVAL_DECLINED, REASON_APPROVAL_NOT_BOUND};
use opensesame_agent_hooks::sdk::{
    AgentContextBuilder, Decision, EnforcementMode, IdentityProvider, InterceptionEmitter,
};
use opensesame_agent_hooks::{
    redact_for_approver, ApprovalBinding, ApprovalPrompt, ApproverError, BoundApprovalResolver,
    HookPolicy, HumanApprover, HumanDecision, OpenSesameInterceptor,
};
use serde_json::json;

/// How the scripted person answers.
#[derive(Clone, Copy)]
enum Answer {
    Approve,
    Decline,
    ApproveSomethingElse,
    ApproveAnotherIdentity,
    Silence,
}

/// A person who answers from a script and remembers what they were shown.
#[derive(Clone)]
struct ScriptedPerson {
    answer: Answer,
    seen: Arc<Mutex<Vec<(String, String)>>>,
}

impl ScriptedPerson {
    fn new(answer: Answer) -> Self {
        Self {
            answer,
            seen: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[async_trait]
impl HumanApprover for ScriptedPerson {
    async fn ask(&self, prompt: ApprovalPrompt<'_>) -> Result<HumanDecision, ApproverError> {
        self.seen.lock().expect("lock").push((
            prompt.context_identity.to_owned(),
            serde_json::to_string(prompt.context).expect("context serializes"),
        ));
        let identity = prompt.context_identity;
        let other = format!("sha256:{}", "0".repeat(64));
        match self.answer {
            Answer::Approve => Ok(HumanDecision {
                approved: true,
                binding: ApprovalBinding::direct(identity, identity),
            }),
            Answer::Decline => Ok(HumanDecision {
                approved: false,
                binding: ApprovalBinding::direct(identity, identity),
            }),
            Answer::ApproveSomethingElse => Ok(HumanDecision {
                approved: true,
                binding: ApprovalBinding::direct(identity, &other),
            }),
            // A proof bound to its request, but the request carries another
            // identity: the transitive binding does not reach this emission.
            Answer::ApproveAnotherIdentity => Ok(HumanDecision {
                approved: true,
                binding: ApprovalBinding {
                    request_digest: other.clone(),
                    bound_digest: Some(other.clone()),
                    carried_identity: Some(other),
                },
            }),
            Answer::Silence => Err(ApproverError::TimedOut),
        }
    }
}

fn escalating_policy() -> HookPolicy {
    HookPolicy::parse(r#"{"version": 1, "tools": [{"name": "deploy", "decision": "escalate"}]}"#)
        .expect("policy parses")
}

fn emitter(person: &ScriptedPerson) -> InterceptionEmitter {
    let resolver = BoundApprovalResolver::new(person.clone());
    let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, Some(Box::new(resolver)));
    emitter.register(Box::new(OpenSesameInterceptor::new(escalating_policy())));
    emitter.set_approval_redactor(redact_for_approver);
    emitter
}

fn deploy_context() -> opensesame_agent_hooks::sdk::AgentContext {
    AgentContextBuilder::new("release-agent", "opensesame-test", "session-1").pre_tool_call(
        "c1",
        "deploy",
        json!({"env": "prod"}),
    )
}

#[tokio::test]
async fn a_bound_approval_lifts_the_deny() {
    let person = ScriptedPerson::new(Answer::Approve);
    let mut emitter = emitter(&person);
    let mut ctx = deploy_context();
    let outcome = emitter.emit(&mut ctx).await.expect("approved");
    assert_eq!(outcome.record.verdict.decision, Decision::Allow);
    assert_eq!(outcome.record.resolved_by, Some("approval"));

    let seen = person.seen.lock().expect("lock");
    assert_eq!(seen.len(), 1);
    assert!(seen[0].0.starts_with("sha256:"), "{}", seen[0].0);
}

#[tokio::test]
async fn a_decline_stands_as_a_deny() {
    let person = ScriptedPerson::new(Answer::Decline);
    let mut emitter = emitter(&person);
    let blocked = emitter
        .emit(&mut deploy_context())
        .await
        .expect_err("declined");
    assert_eq!(blocked.record.resolved_by, Some("rejection"));
    assert_eq!(blocked.record.verdict.decision, Decision::Deny);
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_APPROVAL_DECLINED)
    );
}

#[tokio::test]
async fn an_approval_bound_to_another_request_does_not_lift_this_one() {
    let person = ScriptedPerson::new(Answer::ApproveSomethingElse);
    let mut emitter = emitter(&person);
    let blocked = emitter
        .emit(&mut deploy_context())
        .await
        .expect_err("unbound");
    assert_eq!(blocked.record.resolved_by, Some("rejection"));
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_APPROVAL_NOT_BOUND)
    );
}

#[tokio::test]
async fn an_approval_of_a_request_carrying_another_identity_does_not_lift_this_one() {
    let person = ScriptedPerson::new(Answer::ApproveAnotherIdentity);
    let mut emitter = emitter(&person);
    let blocked = emitter
        .emit(&mut deploy_context())
        .await
        .expect_err("unbound");
    assert_eq!(blocked.record.resolved_by, Some("rejection"));
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some(REASON_APPROVAL_NOT_BOUND)
    );
}

#[test]
fn a_binding_holds_only_when_all_three_facts_line_up() {
    let identity = format!("sha256:{}", "a".repeat(64));
    let digest = format!("sha256:{}", "b".repeat(64));
    let bound = ApprovalBinding {
        request_digest: digest.clone(),
        bound_digest: Some(digest.clone()),
        carried_identity: Some(identity.clone()),
    };
    assert!(bound.holds_for(&identity));
    assert!(!bound.holds_for(&digest), "carried identity must match");
    assert!(!bound.holds_for(""), "an empty identity binds nothing");
    let refused = ApprovalBinding {
        bound_digest: None,
        ..bound.clone()
    };
    assert!(
        !refused.holds_for(&identity),
        "a refused proof binds nothing"
    );
    let elsewhere = ApprovalBinding {
        bound_digest: Some(identity.clone()),
        ..bound.clone()
    };
    assert!(!elsewhere.holds_for(&identity), "proof bound elsewhere");
    let carries_none = ApprovalBinding {
        carried_identity: None,
        ..bound.clone()
    };
    assert!(!carries_none.holds_for(&identity));
    let empty = ApprovalBinding {
        request_digest: String::new(),
        bound_digest: Some(String::new()),
        carried_identity: Some(identity.clone()),
    };
    assert!(
        !empty.holds_for(&identity),
        "an empty request digest binds nothing"
    );
}

#[tokio::test]
async fn silence_is_unresolved_and_unresolved_is_a_deny() {
    let person = ScriptedPerson::new(Answer::Silence);
    let mut emitter = emitter(&person);
    let blocked = emitter
        .emit(&mut deploy_context())
        .await
        .expect_err("unresolved");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some("host_error:approval_unresolved")
    );
}

#[tokio::test]
async fn an_identity_unbound_request_is_never_put_to_a_person() {
    let person = ScriptedPerson::new(Answer::Approve);
    let mut emitter = emitter(&person);
    emitter
        .set_identity_provider(IdentityProvider::Null)
        .expect("null is a valid provider");
    let blocked = emitter
        .emit(&mut deploy_context())
        .await
        .expect_err("unresolved");
    assert_eq!(
        blocked.record.verdict.reason.as_deref(),
        Some("host_error:approval_unresolved")
    );
    assert!(person.seen.lock().expect("lock").is_empty());
}

#[test]
fn the_approver_is_shown_no_secret() {
    let token = format!("ghp_{}", "S".repeat(36));
    let mut ctx = deploy_context();
    ctx.insert(
        "messages".into(),
        json!([{"role": "user", "content": token.clone()}]),
    );
    let shown = serde_json::to_string(&redact_for_approver(&ctx)).expect("serializes");
    assert!(!shown.contains(&token));
    assert!(shown.contains("[redacted:github_token]"));
}
