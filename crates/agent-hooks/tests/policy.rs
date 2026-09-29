//! The hook policy document: strict parsing and rule precedence.

use opensesame_agent_hooks::policy::{
    HookPolicy, PolicyError, SecretGuard, ToolDecision, POLICY_VERSION,
};

#[test]
fn the_empty_document_is_the_fail_closed_default() {
    let policy = HookPolicy::parse(r#"{"version": 1}"#).expect("parses");
    assert_eq!(policy, HookPolicy::default());
    assert_eq!(policy.unlisted_tools, ToolDecision::Escalate);
    assert_eq!(policy.secret_guard, SecretGuard::Redact);
    assert_eq!(policy.tool("anything").decision, ToolDecision::Escalate);
}

#[test]
fn exact_names_beat_prefixes_and_longer_prefixes_beat_shorter() {
    let policy = HookPolicy::parse(
        r#"{
          "version": 1,
          "unlisted_tools": "deny",
          "tools": [
            {"prefix": "github.", "decision": "allow"},
            {"prefix": "github.admin.", "decision": "escalate", "reason": "acme:admin_scope"},
            {"name": "github.admin.audit_log", "decision": "allow"},
            {"name": "shell", "decision": "deny", "message": "no shell"}
          ]
        }"#,
    )
    .expect("parses");

    assert_eq!(
        policy.tool("github.issues.list").decision,
        ToolDecision::Allow
    );
    let admin = policy.tool("github.admin.delete_repo");
    assert_eq!(admin.decision, ToolDecision::Escalate);
    assert_eq!(admin.reason, Some("acme:admin_scope"));
    assert_eq!(
        policy.tool("github.admin.audit_log").decision,
        ToolDecision::Allow
    );
    let shell = policy.tool("shell");
    assert_eq!(shell.decision, ToolDecision::Deny);
    assert_eq!(shell.message, Some("no shell"));
    assert_eq!(policy.tool("shellx").decision, ToolDecision::Deny);
    assert_eq!(policy.tool("gitlab.x").decision, ToolDecision::Deny);
}

#[test]
fn unknown_fields_and_other_versions_are_refused() {
    assert!(matches!(
        HookPolicy::parse(r#"{"version": 1, "tool": []}"#),
        Err(PolicyError::Malformed(_))
    ));
    assert!(matches!(
        HookPolicy::parse(
            r#"{"version": 1, "tools": [{"name": "a", "decision": "allow", "regex": ".*"}]}"#
        ),
        Err(PolicyError::Malformed(_))
    ));
    assert!(matches!(
        HookPolicy::parse(r#"{"version": 1, "unlisted_tools": "warn"}"#),
        Err(PolicyError::Malformed(_))
    ));
    assert_eq!(
        HookPolicy::parse(r#"{"version": 2}"#),
        Err(PolicyError::Version(2))
    );
    assert!(matches!(
        HookPolicy::parse("not json"),
        Err(PolicyError::Malformed(_))
    ));
    assert_eq!(POLICY_VERSION, 1);
}

#[test]
fn ambiguous_or_empty_selectors_are_refused() {
    let cases = [
        (r#"{"decision": "allow"}"#, PolicyError::Selector(0)),
        (
            r#"{"name": "a", "prefix": "a", "decision": "allow"}"#,
            PolicyError::Selector(0),
        ),
        (
            r#"{"name": "", "decision": "allow"}"#,
            PolicyError::Selector(0),
        ),
        (
            r#"{"prefix": "", "decision": "allow"}"#,
            PolicyError::Selector(0),
        ),
    ];
    for (rule, expected) in cases {
        let doc = format!(r#"{{"version": 1, "tools": [{rule}]}}"#);
        assert_eq!(HookPolicy::parse(&doc), Err(expected), "{rule}");
    }
    let duplicate = r#"{"version": 1, "tools": [
        {"name": "a", "decision": "allow"},
        {"name": "a", "decision": "deny"}
    ]}"#;
    assert_eq!(HookPolicy::parse(duplicate), Err(PolicyError::Duplicate(1)));
}

#[test]
fn a_rule_may_not_claim_a_host_error_or_an_unusable_reason() {
    for reason in [
        "host_error:no_interceptor",
        "",
        "has space",
        &"r".repeat(129),
    ] {
        let doc = format!(
            r#"{{"version": 1, "tools": [{{"name": "a", "decision": "deny", "reason": {}}}]}}"#,
            serde_json::to_string(reason).expect("string")
        );
        assert_eq!(
            HookPolicy::parse(&doc),
            Err(PolicyError::Reason(0)),
            "{reason:?}"
        );
    }
}

#[test]
fn errors_name_positions_not_content() {
    let doc =
        r#"{"version": 1, "tools": [{"name": "leaky-name", "prefix": "x", "decision": "allow"}]}"#;
    let message = HookPolicy::parse(doc).expect_err("refused").to_string();
    assert!(message.contains("tools[0]"));
    assert!(!message.contains("leaky-name"));
}
