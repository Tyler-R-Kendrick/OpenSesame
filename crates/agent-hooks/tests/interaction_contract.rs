//! Pact with the Identity API: every body the Interaction-backed approver
//! sends validates against the control plane's published schema
//! (`packages/control-plane/openapi.json`, generated from its Zod
//! contracts), every body the mock answers with validates against the
//! response schema the real routes are held to, and every error code the
//! approver branches on is in the closed `InteractionErrorCode` vocabulary.

mod interaction_mock;

use std::path::PathBuf;

use interaction_mock::{approver, serve, Step, BEARER};
use opensesame_agent_hooks::sdk::{AgentContextBuilder, EnforcementMode, InterceptionEmitter};
use opensesame_agent_hooks::{
    redact_for_approver, BoundApprovalResolver, HookPolicy, OpenSesameInterceptor,
};
use serde_json::{json, Value};

fn openapi() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/control-plane/openapi.json");
    let text = std::fs::read_to_string(&path).expect("the control plane's openapi.json is present");
    serde_json::from_str(&text).expect("openapi.json parses")
}

fn schema<'a>(doc: &'a Value, name: &str) -> &'a Value {
    let found = &doc["components"]["schemas"][name];
    assert!(found.is_object(), "openapi.json has no schema {name}");
    found
}

fn resolve<'a>(doc: &'a Value, node: &'a Value) -> &'a Value {
    match node.get("$ref").and_then(Value::as_str) {
        Some(reference) => {
            let name = reference.trim_start_matches("#/components/schemas/");
            resolve(doc, schema(doc, name))
        }
        None => node,
    }
}

fn check_bounds(node: &Value, value: &Value, at: &str, out: &mut Vec<String>) {
    let len = |v: &Value| match v {
        Value::String(s) => Some(s.chars().count() as u64),
        Value::Array(a) => Some(a.len() as u64),
        _ => None,
    };
    let bound = |key: &str| node.get(key).and_then(Value::as_u64);
    if let (Some(n), Some(min)) = (len(value), bound("minLength").or(bound("minItems"))) {
        if n < min {
            out.push(format!("{at}: shorter than {min}"));
        }
    }
    if let (Some(n), Some(max)) = (len(value), bound("maxLength").or(bound("maxItems"))) {
        if n > max {
            out.push(format!("{at}: longer than {max}"));
        }
    }
    if let Some(n) = value.as_i64() {
        let low = node.get("minimum").and_then(Value::as_i64);
        let high = node.get("maximum").and_then(Value::as_i64);
        if low.is_some_and(|l| n < l) || high.is_some_and(|h| n > h) {
            out.push(format!("{at}: out of range"));
        }
    }
    if let Some(allowed) = node.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            out.push(format!("{at}: not in enum"));
        }
    }
}

fn check_object(doc: &Value, node: &Value, value: &Value, at: &str, out: &mut Vec<String>) {
    let Some(object) = value.as_object() else {
        return out.push(format!("{at}: not an object"));
    };
    let properties = node.get("properties").and_then(Value::as_object);
    for required in node["required"].as_array().into_iter().flatten() {
        if !object.contains_key(required.as_str().unwrap_or_default()) {
            out.push(format!("{at}: missing {required}"));
        }
    }
    let closed = node.get("additionalProperties") == Some(&Value::Bool(false));
    for (key, item) in object {
        match properties.and_then(|p| p.get(key)) {
            Some(sub) => validate(doc, sub, item, &format!("{at}.{key}"), out),
            None if closed => out.push(format!("{at}: unknown property {key}")),
            None => {}
        }
    }
}

/// The subset of JSON Schema the control plane's generator emits.
fn validate(doc: &Value, node: &Value, value: &Value, at: &str, out: &mut Vec<String>) {
    let node = resolve(doc, node);
    let kind = node.get("type").and_then(Value::as_str);
    let fits = match kind {
        Some("object") => {
            check_object(doc, node, value, at, out);
            true
        }
        Some("array") => {
            for (i, item) in value.as_array().into_iter().flatten().enumerate() {
                validate(doc, &node["items"], item, &format!("{at}[{i}]"), out);
            }
            value.is_array()
        }
        Some("string") => value.is_string(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("boolean") => value.is_boolean(),
        _ => true,
    };
    if !fits {
        out.push(format!("{at}: not a {}", kind.unwrap_or("value")));
    }
    check_bounds(node, value, at, out);
}

fn assert_valid(doc: &Value, name: &str, value: &Value) {
    let mut problems = Vec::new();
    validate(doc, schema(doc, name), value, name, &mut problems);
    assert!(problems.is_empty(), "{name}: {problems:#?}");
}

#[test]
fn the_validator_refuses_what_the_schema_refuses() {
    let doc = openapi();
    let mut problems = Vec::new();
    let bad = json!({"kind": "agent_action", "subject": {}, "approverRef": "x",
        "authorizationDetails": [], "ttlSeconds": 5, "bindingMessage": "chosen"});
    validate(
        &doc,
        schema(&doc, "CreateInteraction"),
        &bad,
        "$",
        &mut problems,
    );
    for expected in [
        "$.kind: not in enum",
        "$.subject: missing \"kind\"",
        "$.approverRef: shorter than 8",
        "$.authorizationDetails: shorter than 1",
        "$.ttlSeconds: out of range",
        "$: unknown property bindingMessage",
    ] {
        assert!(
            problems.iter().any(|p| p == expected),
            "{expected} not in {problems:#?}"
        );
    }
}

async fn captured_requests() -> (Value, Value) {
    let server = serve(vec![Step::Spend], 201).await;
    let policy = HookPolicy::parse(r#"{"version": 1, "unlisted_tools": "escalate"}"#).unwrap();
    let resolver = BoundApprovalResolver::new(approver(&server.base));
    let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, Some(Box::new(resolver)));
    emitter.register(Box::new(OpenSesameInterceptor::new(policy)));
    emitter.set_approval_redactor(redact_for_approver);
    let mut ctx = AgentContextBuilder::new("release-agent", "opensesame-test", "s-1")
        .pre_tool_call("c1", "deploy", json!({}));
    emitter.emit(&mut ctx).await.expect("approved");
    let seen = server.seen.lock().unwrap();
    (seen.auth_requests[0].clone(), seen.interactions[0].clone())
}

#[tokio::test]
async fn what_the_approver_sends_is_what_the_identity_api_accepts() {
    let doc = openapi();
    let (subject, interaction) = captured_requests().await;
    assert_valid(&doc, "CreateAuthorizationRequest", &subject);
    assert_valid(&doc, "CreateInteraction", &interaction);
    // Neither the digest nor the interaction's binding message is ever sent:
    // the server derives both (ADR 0086).
    assert!(interaction.get("requestDigest").is_none());
    assert!(interaction.get("bindingMessage").is_none());
    // The Zod bounds openapi.json does not carry (contracts
    // authorization-requests.ts `AuthorizationDetailSchema`).
    let detail = &interaction["authorizationDetails"][0];
    assert!(detail["type"].as_str().unwrap().len() <= 128);
    for (field, max) in [("actions", 128), ("locations", 512)] {
        let items = detail[field].as_array().unwrap();
        assert!(items.len() <= 32);
        assert!(items.iter().all(|i| i.as_str().unwrap().len() <= max));
    }
}

#[tokio::test]
async fn what_the_mock_answers_is_what_the_identity_api_answers() {
    let doc = openapi();
    let server = serve(vec![Step::Spend], 201).await;
    let http = reqwest::Client::new();
    let post = |path: &str, body: Value| {
        http.post(format!("{}{path}", server.base))
            .bearer_auth(BEARER)
            .json(&body)
            .send()
    };
    let (subject, interaction) = captured_requests().await;
    let reply: Value = post("/v1/authorization-requests", subject)
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_valid(&doc, "AuthorizationRequest", &reply);
    let reply: Value = post("/v1/interactions", interaction)
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_valid(&doc, "InteractionCreated", &reply);
    let path = format!("/v1/interactions/{}/consume", interaction_mock::REF);
    let reply: Value = post(&path, json!({})).await.unwrap().json().await.unwrap();
    assert_valid(&doc, "InteractionDetail", &reply);
}

#[test]
fn every_error_code_the_approver_branches_on_is_in_the_vocabulary() {
    let doc = openapi();
    let vocabulary = schema(&doc, "InteractionErrorCode")["enum"]
        .as_array()
        .unwrap()
        .clone();
    for code in [
        "approval_required",
        "approval_denied",
        "digest_mismatch",
        "interaction_consumed",
        "interaction_revoked",
        "interaction_expired",
    ] {
        assert!(
            vocabulary.contains(&json!(code)),
            "{code} left the vocabulary"
        );
    }
    let kinds = schema(&doc, "InteractionKind")["enum"]
        .as_array()
        .unwrap()
        .clone();
    assert!(kinds.contains(&json!(
        opensesame_agent_hooks::interaction::wire::INTERACTION_KIND
    )));
    let statuses = schema(&doc, "InteractionStatus")["enum"]
        .as_array()
        .unwrap()
        .clone();
    assert!(statuses.contains(&json!("consumed")));
}
