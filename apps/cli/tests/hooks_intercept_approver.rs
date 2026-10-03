//! `opensesame hooks intercept --approver-*`, driven through the real binary
//! against a stand-in Identity API that a person answers (ADR 0150): an
//! escalation is put to them, and what they say is what the verdict says.

mod hooks_mock;

use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

use hooks_mock::{opensesame, serve, stdout_json, Request, BEARER, HANDLE};
use opensesame_agent_hooks::interaction::digest::{request_digest, RequestFields};
use opensesame_agent_hooks::sdk::ffi_surface;
use serde_json::{json, Value};

// --- `hooks intercept --approver-*` against a stand-in Identity API --------

const REF: &str = "ixn_aWQtMQ.tag-1";
const BINDING: &str = "pre_tool_call on deploy";
const EXPIRES: &str = "2099-01-01T00:05:00.000Z";
const REQUESTER: &str = "req_abcdefghijklmnopqrstuvwx";

#[derive(Clone, Copy, PartialEq)]
enum Person {
    Approves,
    Declines,
    /// Approves, but the server attests a digest over other content.
    ApprovesSomethingElse,
    /// The Identity API fails.
    Unreachable,
}

fn identity(person: Person) -> (String, Arc<Mutex<Vec<Request>>>) {
    serve(move |request, log| {
        let created: Option<Value> = log
            .iter()
            .find(|r| r.path == "/v1/interactions")
            .and_then(|r| serde_json::from_str(&r.body).ok());
        let digest_of = |sent: &Value| {
            let mut details = sent["authorizationDetails"].as_array().unwrap().clone();
            if person == Person::ApprovesSomethingElse {
                details.push(json!({"type": "something_else"}));
            }
            request_digest(&RequestFields {
                kind: "authorization_request",
                subject: "authorization_request:areq_1",
                approver_ref: sent["approverRef"].as_str().unwrap(),
                requester_ref: REQUESTER,
                authorization_details: &details,
                binding_message: BINDING,
                resource_ref: None,
                expires_at: EXPIRES,
            })
            .unwrap()
        };
        if person == Person::Unreachable {
            return ("500 Internal Server Error", json!({"error": "down"}));
        }
        match request.path.as_str() {
            "/v1/authorization-requests" => {
                let sent: Value = serde_json::from_str(&request.body).unwrap();
                (
                    "201 Created",
                    json!({"authReqId": "areq_1", "status": "pending",
                           "authorizationDetails": sent["authorizationDetails"]}),
                )
            }
            "/v1/interactions" => {
                let sent: Value = serde_json::from_str(&request.body).unwrap();
                (
                    "201 Created",
                    json!({"ref": REF, "url": format!("https://identity.example/i/{REF}"),
                           "requestDigest": digest_of(&sent), "bindingMessage": BINDING,
                           "expiresAt": EXPIRES, "status": "pending"}),
                )
            }
            p if p.ends_with("/consume") && person == Person::Declines => {
                ("403 Forbidden", json!({"error": "approval_denied"}))
            }
            p if p.ends_with("/consume") => {
                let sent = created.expect("the interaction was created first");
                (
                    "200 OK",
                    json!({"kind": "authorization_request", "status": "consumed",
                           "expiresAt": EXPIRES, "requiresApprover": true, "id": "ixn-row-1",
                           "requesterRef": REQUESTER, "bindingMessage": BINDING,
                           "requestDigest": digest_of(&sent),
                           "authorizationDetails": sent["authorizationDetails"]}),
                )
            }
            _ => ("200 OK", json!({"status": "ok"})),
        }
    })
}

fn tool_call(name: &str, args: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "spec": "agent-hooks/0.1",
        "interception_point": "pre_tool_call",
        "timestamp": "2026-09-28T12:00:00Z",
        "sequence": 4,
        "agent": {"id": "release-agent", "framework": "demo"},
        "session": {"id": "s-1"},
        "tool_call": {"id": "c1", "name": name, "args": args},
        "target": args,
    }))
    .unwrap()
}

fn intercept(base: Option<&str>, configure: impl FnOnce(&mut Command), stdin: &[u8]) -> Output {
    let dir = tempfile::tempdir().unwrap();
    let mut command = opensesame(dir.path());
    command
        .args(["hooks", "intercept"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(base) = base {
        command
            .env("OPENSESAME_HOOK_APPROVER_URL", base)
            .env("OPENSESAME_HOOK_APPROVER_REF", HANDLE)
            .env("OPENSESAME_HOOK_APPROVER_BEARER", BEARER);
    }
    configure(&mut command);
    let mut child = command.spawn().unwrap();
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

fn escalated(base: &str, person_policy_context: &[u8]) -> Output {
    intercept(Some(base), |_| {}, person_policy_context)
}

#[test]
fn an_approval_bound_to_this_request_lifts_the_escalation_to_an_allow() {
    let (base, seen) = identity(Person::Approves);
    let context = tool_call("deploy", &json!({"env": "prod"}));
    let verdict = stdout_json(&escalated(&base, &context));
    assert_eq!(verdict, json!({"decision": "allow"}));

    let seen = seen.lock().unwrap();
    assert!(seen
        .iter()
        .all(|r| r.authorization == format!("Bearer {BEARER}")));
    let raised: Value = serde_json::from_str(
        &seen
            .iter()
            .find(|r| r.path == "/v1/interactions")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(raised["approverRef"], HANDLE);
    // What was asked is this context, as the approver is shown it.
    let shown = String::from_utf8(context).unwrap();
    let identity = ffi_surface::context_identity(&shown).unwrap();
    assert_eq!(
        raised["authorizationDetails"][0]["context_identity"],
        json!(identity)
    );
}

#[test]
fn a_declined_escalation_is_a_deny_naming_that() {
    let (base, _) = identity(Person::Declines);
    let verdict = stdout_json(&escalated(&base, &tool_call("deploy", &json!({}))));
    assert_eq!(verdict["decision"], "deny");
    assert_eq!(verdict["reason"], "opensesame:approval_declined");
    assert!(verdict.get("approval").is_none(), "{verdict}");
}

#[test]
fn an_approval_bound_to_another_request_is_a_deny_not_an_allow() {
    let (base, _) = identity(Person::ApprovesSomethingElse);
    let verdict = stdout_json(&escalated(&base, &tool_call("deploy", &json!({}))));
    assert_eq!(verdict["decision"], "deny");
    assert_eq!(verdict["reason"], "opensesame:approval_not_bound");
}

#[test]
fn no_answer_leaves_the_escalation_for_the_host_to_resolve() {
    let (base, _) = identity(Person::Unreachable);
    let verdict = stdout_json(&escalated(&base, &tool_call("deploy", &json!({}))));
    assert_eq!(verdict["decision"], "deny");
    assert_eq!(verdict["reason"], "opensesame:tool_requires_approval");
    assert_eq!(verdict["approval"], json!({}), "still liftable by the host");
    assert!(
        !verdict.to_string().contains("host_error"),
        "host reasons belong to hosts"
    );
}

#[test]
fn only_an_escalation_is_asked_about() {
    let (base, seen) = identity(Person::Approves);
    let token = format!("ghp_{}", "q".repeat(36));
    let dir = tempfile::tempdir().unwrap();
    let policy = dir.path().join("policy.json");
    std::fs::write(
        &policy,
        r#"{"version":1,"tools":[{"name":"read","decision":"allow"},{"name":"shell","decision":"deny"}]}"#,
    )
    .unwrap();
    for (tool, args, decision, reason) in [
        ("read", json!({}), "allow", None),
        ("shell", json!({}), "deny", Some("opensesame:tool_denied")),
        // A raw secret in the arguments is a plain deny, even to a tool a
        // person could have approved: no approval is raised for it.
        (
            "deploy",
            json!({"auth": token}),
            "deny",
            Some("opensesame:raw_secret"),
        ),
    ] {
        let verdict = stdout_json(&intercept(
            Some(&base),
            |command| {
                command.arg("--policy").arg(&policy);
            },
            &tool_call(tool, &args),
        ));
        assert_eq!(verdict["decision"], decision, "{tool}");
        if let Some(reason) = reason {
            assert_eq!(verdict["reason"], reason, "{tool}");
        }
    }
    assert!(seen.lock().unwrap().is_empty(), "nobody was asked");
}

#[test]
fn a_partial_approver_fails_with_nothing_on_stdout_and_never_shows_the_bearer() {
    let context = tool_call("deploy", &json!({}));
    for (name, set) in [
        (
            "url only",
            vec![(
                "OPENSESAME_HOOK_APPROVER_URL",
                "https://identity.example.com",
            )],
        ),
        ("ref only", vec![("OPENSESAME_HOOK_APPROVER_REF", HANDLE)]),
        (
            "bearer only",
            vec![("OPENSESAME_HOOK_APPROVER_BEARER", BEARER)],
        ),
        (
            "no bearer",
            vec![
                (
                    "OPENSESAME_HOOK_APPROVER_URL",
                    "https://identity.example.com",
                ),
                ("OPENSESAME_HOOK_APPROVER_REF", HANDLE),
            ],
        ),
    ] {
        let out = intercept(
            None,
            |command| {
                for (key, value) in &set {
                    command.env(key, value);
                }
            },
            &context,
        );
        assert!(!out.status.success(), "{name}");
        assert!(
            out.stdout.is_empty(),
            "{name}: no verdict a host could mistake"
        );
        let said = String::from_utf8_lossy(&out.stderr);
        assert!(said.contains("all three or none"), "{name}: {said}");
        assert!(!said.contains(BEARER), "{name}: {said}");
    }
}

#[test]
fn the_bearer_has_no_flag_so_it_can_never_be_on_argv() {
    let out = intercept(
        None,
        |command| {
            command.args(["--approver-bearer", BEARER]);
        },
        &tool_call("deploy", &json!({})),
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("unexpected argument"), "{said}");
}

#[test]
fn an_insecure_or_malformed_approver_is_refused_before_a_verdict() {
    for (url, handle) in [
        ("http://identity.example.com", HANDLE),
        ("https://identity.example.com", "not-an-inbox-handle"),
    ] {
        let out = intercept(
            None,
            |command| {
                command
                    .env("OPENSESAME_HOOK_APPROVER_URL", url)
                    .env("OPENSESAME_HOOK_APPROVER_REF", handle)
                    .env("OPENSESAME_HOOK_APPROVER_BEARER", BEARER);
            },
            &tool_call("deploy", &json!({})),
        );
        assert!(!out.status.success(), "{url} {handle}");
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains(BEARER));
    }
}
