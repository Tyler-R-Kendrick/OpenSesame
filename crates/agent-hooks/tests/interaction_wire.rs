//! What the Interaction-backed approver puts in front of a person, and what
//! it accepts back as an interaction reference.

use opensesame_agent_hooks::interaction::wire::{
    auth_req_id, authorization_detail, created, declined_binding, DETAIL_TYPE,
};
use opensesame_agent_hooks::sdk::{AgentContext, InterceptionPoint};
use opensesame_agent_hooks::ApprovalPrompt;
use serde_json::{json, Value};

const IDENTITY: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

fn context(tool: &str, agent: &str) -> AgentContext {
    match json!({"tool_call": {"name": tool}, "agent": {"id": agent}}) {
        Value::Object(map) => map,
        _ => unreachable!("an object literal"),
    }
}

fn detail(reason: Option<&str>, tool: &str, agent: &str) -> Value {
    let context = context(tool, agent);
    authorization_detail(&ApprovalPrompt {
        context_identity: IDENTITY,
        interception_point: InterceptionPoint::PreToolCall,
        reason,
        message: Some("free text the approver never sends"),
        context: &context,
    })
}

#[test]
fn identifiers_are_summarized_for_the_person() {
    let sent = detail(
        Some("opensesame:tool_requires_approval"),
        "github.create_issue",
        "release-agent",
    );
    assert_eq!(sent["type"], DETAIL_TYPE);
    assert_eq!(sent["context_identity"], IDENTITY);
    assert_eq!(sent["locations"], json!(["github.create_issue"]));
    assert_eq!(sent["agent"], "release-agent");
    assert_eq!(sent["reason"], "opensesame:tool_requires_approval");
    assert!(sent.get("message").is_none(), "a message never travels");
}

#[test]
fn prose_and_credential_shapes_are_left_out_not_trimmed() {
    let token = format!("ghp_{}", "x".repeat(36));
    let prose = "blocked because the email to jane@example.com says hello";
    for sent in [
        detail(Some(prose), "deploy now", "agent\n2"),
        detail(Some(&token), &token, &token),
    ] {
        for key in ["reason", "locations", "agent"] {
            assert!(sent.get(key).is_none(), "{key} left in: {sent}");
        }
        let text = sent.to_string();
        assert!(!text.contains("jane") && !text.contains(&token));
        assert_eq!(
            sent["context_identity"], IDENTITY,
            "the binding always travels"
        );
    }
}

#[test]
fn a_reference_that_could_walk_the_path_is_unusable() {
    let body = |reference: &str| {
        json!({
            "ref": reference,
            "url": "https://identity.example/i/x",
            "requestDigest": IDENTITY,
        })
    };
    assert!(created(Some(&body("ixn_aWQ.tag-1"))).is_some());
    for bad in [
        "..", ".", "ixn..tag", ".ixn", "ixn.", "ixn/../x", "ixn%2e", "",
    ] {
        assert!(created(Some(&body(bad))).is_none(), "{bad}");
    }
}

#[test]
fn a_request_id_that_could_walk_the_path_is_unusable() {
    let body = |id: &str| json!({"authReqId": id});
    assert_eq!(
        auth_req_id(Some(&body("areq_7sQ2mVn1-x_Z"))),
        Some("areq_7sQ2mVn1-x_Z")
    );
    for bad in [
        "",
        "..",
        "areq/../x",
        "areq/cancel",
        "areq%2f",
        "areq.x",
        "a b",
    ] {
        assert!(auth_req_id(Some(&body(bad))).is_none(), "{bad}");
    }
    assert!(auth_req_id(Some(&json!({"authReqId": 7}))).is_none());
    assert!(auth_req_id(None).is_none());
}

#[test]
fn a_refusal_is_bound_to_the_request_that_was_asked_and_nothing_else() {
    let sent = [detail(
        Some("opensesame:tool_requires_approval"),
        "deploy",
        "agent-1",
    )];
    let made = created(Some(&json!({
        "ref": "ixn_aWQ.tag-1",
        "url": "https://identity.example/i/x",
        "requestDigest": IDENTITY,
    })))
    .expect("usable");
    let binding = declined_binding(&made, &sent);
    assert!(binding.holds_for(IDENTITY), "a refusal of this request");
    assert!(
        !binding
            .holds_for("sha256:2222222222222222222222222222222222222222222222222222222222222222"),
        "not of another"
    );
    // Details that carry no identity leave nothing to bind.
    let bare = [json!({"type": DETAIL_TYPE})];
    assert!(!declined_binding(&made, &bare).holds_for(IDENTITY));
}
