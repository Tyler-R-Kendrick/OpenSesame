//! `opensesame hooks` driven through the real binary, the way an
//! out-of-process agent-hooks host drives it: one `AgentContext` on standard
//! input, one `Verdict` on standard output (ADR 0150).

use std::io::Write;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};

fn intercept(policy: Option<&str>, stdin: &[u8]) -> Output {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .args(["hooks", "intercept"])
        .env_remove("OPENSESAME_HOOK_POLICY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(policy) = policy {
        let path = dir.path().join("policy.json");
        std::fs::write(&path, policy).expect("write policy");
        command.arg("--policy").arg(path);
    }
    let mut child = command.spawn().expect("spawn opensesame");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin)
        .expect("write context");
    child.wait_with_output().expect("wait")
}

fn verdict(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("stdout is one verdict")
}

fn context(point: &str, extra: &Value, target: &Value) -> Vec<u8> {
    let mut ctx = json!({
        "spec": "agent-hooks/0.1",
        "interception_point": point,
        "timestamp": "2026-09-28T12:00:00Z",
        "sequence": 4,
        "agent": {"id": "release-agent", "framework": "demo"},
        "session": {"id": "s-1"},
        "target": target,
    });
    for (key, value) in extra.as_object().expect("object") {
        ctx[key] = value.clone();
    }
    serde_json::to_vec(&ctx).expect("serialize")
}

fn tool_call(name: &str, args: &Value) -> Vec<u8> {
    context(
        "pre_tool_call",
        &json!({"tool_call": {"id": "c1", "name": name, "args": args}}),
        args,
    )
}

const POLICY: &str = r#"{"version": 1, "tools": [
  {"prefix": "github.", "decision": "allow"},
  {"name": "shell", "decision": "deny"}
]}"#;

#[test]
fn tool_rules_decide_pre_tool_call() {
    let allowed = verdict(&intercept(
        Some(POLICY),
        &tool_call("github.issues.list", &json!({})),
    ));
    assert_eq!(allowed, json!({"decision": "allow"}));

    let denied = verdict(&intercept(Some(POLICY), &tool_call("shell", &json!({}))));
    assert_eq!(denied["decision"], "deny");
    assert_eq!(denied["reason"], "opensesame:tool_denied");
    assert!(denied.get("approval").is_none());

    let unlisted = verdict(&intercept(Some(POLICY), &tool_call("deploy", &json!({}))));
    assert_eq!(unlisted["reason"], "opensesame:tool_requires_approval");
    assert_eq!(unlisted["approval"], json!({}), "liftable deny");
}

#[test]
fn no_policy_means_every_tool_escalates() {
    let out = verdict(&intercept(
        None,
        &tool_call("github.issues.list", &json!({})),
    ));
    assert_eq!(out["decision"], "deny");
    assert_eq!(out["approval"], json!({}));
}

#[test]
fn credential_material_is_redacted_on_output_and_refused_in_tool_arguments() {
    let token = format!("ghp_{}", "q".repeat(36));
    let output = json!({"content": format!("your token is {token}")});
    let redacted = verdict(&intercept(
        Some(POLICY),
        &context("output", &json!({"output": output}), &output),
    ));
    assert_eq!(redacted["decision"], "transform");
    assert_eq!(redacted["transform"]["path"], "$target");
    assert_eq!(
        redacted["transform"]["value"],
        json!({"content": "your token is [redacted:github_token]"})
    );

    let refused = verdict(&intercept(
        Some(POLICY),
        &tool_call("github.repos.get", &json!({"auth": token})),
    ));
    assert_eq!(refused["reason"], "opensesame:raw_secret");
    assert!(!refused.to_string().contains(&token));
}

#[test]
fn an_unreadable_context_is_denied_not_allowed() {
    for stdin in [
        b"not json".to_vec(),
        br#"{"interception_point": "output"}"#.to_vec(),
        vec![0xff, 0xfe, 0x00],
    ] {
        let out = verdict(&intercept(Some(POLICY), &stdin));
        assert_eq!(out["decision"], "deny");
        assert_eq!(out["reason"], "opensesame:context_unreadable");
    }
}

#[test]
fn an_unusable_policy_fails_with_nothing_on_stdout() {
    let out = intercept(
        Some(r#"{"version": 1, "tools": [{"decision": "allow"}]}"#),
        &tool_call("shell", &json!({})),
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty(), "no verdict a host could mistake");
}
