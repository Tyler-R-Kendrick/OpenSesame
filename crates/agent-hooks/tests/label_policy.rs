//! Label lists in the hook policy: syntax, bounds and positional errors
//! that never echo a label back.

use opensesame_agent_hooks::labels::{is_label, MAX_LABELS, MAX_LABEL_BYTES};
use opensesame_agent_hooks::policy::{HookPolicy, PolicyError, ToolDecision};

fn quoted(labels: &[String]) -> String {
    serde_json::to_string(labels).expect("labels serialize")
}

fn rule_doc(list: &str, labels: &[String]) -> String {
    format!(
        r#"{{"version": 1, "tools": [
            {{"name": "ok", "decision": "allow"}},
            {{"name": "a", "decision": "allow", "{list}": {}}}
        ]}}"#,
        quoted(labels)
    )
}

fn top_doc(labels: &[String]) -> String {
    format!(r#"{{"version": 1, "refuse_labels": {}}}"#, quoted(labels))
}

/// Label lists that are refused, and the first bad position in each.
fn bad_lists() -> Vec<(Vec<String>, usize)> {
    let ok = |s: &str| s.to_owned();
    let at_limit = format!("acme:{}", "x".repeat(MAX_LABEL_BYTES - 5));
    let over_limit = format!("{at_limit}y");
    let many: Vec<String> = (0..=MAX_LABELS).map(|i| format!("acme:l{i}")).collect();
    vec![
        (vec![ok("Acme:pii")], 0),
        (vec![ok("acme:pii"), ok("acmepii")], 1),
        (vec![ok("acme:")], 0),
        (vec![ok(":pii")], 0),
        (vec![ok("1acme:pii")], 0),
        (vec![ok("ac-me:pii")], 0),
        (vec![ok("acme:PII")], 0),
        (vec![ok("acme:p i")], 0),
        (vec![ok("acme:pii"), ok("")], 1),
        (vec![at_limit.clone(), over_limit], 1),
        (vec![ok("acme:pii"), ok("acme:hr"), ok("acme:pii")], 2),
        (many, MAX_LABELS),
    ]
}

#[test]
fn the_label_syntax_is_namespace_colon_name() {
    for good in [
        "acme:pii",
        "opensesame:credential_material",
        "a:b",
        "a_1:x.y-z:w",
        &format!("acme:{}", "x".repeat(MAX_LABEL_BYTES - 5)),
    ] {
        assert!(is_label(good), "{good}");
    }
    for bad in [
        "", "acme", "acme:", ":pii", "Acme:pii", "_a:b", "a-b:c", "a:b c", "a:é",
    ] {
        assert!(!is_label(bad), "{bad}");
    }
    assert!(!is_label(&format!(
        "acme:{}",
        "x".repeat(MAX_LABEL_BYTES - 4)
    )));
}

#[test]
fn labelled_rules_parse_and_match() {
    let policy = HookPolicy::parse(
        r#"{
          "version": 1,
          "refuse_labels": ["opensesame:credential_material"],
          "tools": [
            {"prefix": "crm.", "decision": "allow", "labels": ["acme:pii"]},
            {"name": "email.send", "decision": "allow", "refuse_labels": ["acme:pii"]}
          ]
        }"#,
    )
    .expect("parses");
    assert_eq!(policy.refuse_labels, ["opensesame:credential_material"]);
    let crm = policy.tool("crm.contacts.get");
    assert_eq!(crm.labels, ["acme:pii"]);
    assert!(crm.refuse_labels.is_empty());
    let email = policy.tool("email.send");
    assert!(email.labels.is_empty());
    assert_eq!(email.refuse_labels, ["acme:pii"]);
    let unlisted = policy.tool("other");
    assert_eq!(unlisted.decision, ToolDecision::Escalate);
    assert!(unlisted.labels.is_empty() && unlisted.refuse_labels.is_empty());
}

#[test]
fn the_empty_document_refuses_no_label() {
    let policy = HookPolicy::parse(r#"{"version": 1}"#).expect("parses");
    assert!(policy.refuse_labels.is_empty());
    assert_eq!(policy, HookPolicy::default());
    // `hooks check` prints the policy-wide list with its default.
    let printed = serde_json::to_value(&policy).expect("serializes");
    assert_eq!(printed["refuse_labels"], serde_json::json!([]));
}

#[test]
fn a_bad_rule_label_is_named_by_rule_list_and_position() {
    for list in ["labels", "refuse_labels"] {
        for (labels, index) in bad_lists() {
            assert_eq!(
                HookPolicy::parse(&rule_doc(list, &labels)),
                Err(PolicyError::RuleLabel {
                    rule: 1,
                    list,
                    index
                }),
                "{list} {labels:?}"
            );
        }
    }
}

#[test]
fn a_bad_policy_wide_label_is_named_by_position() {
    for (labels, index) in bad_lists() {
        assert_eq!(
            HookPolicy::parse(&top_doc(&labels)),
            Err(PolicyError::Label {
                list: "refuse_labels",
                index
            }),
            "{labels:?}"
        );
    }
}

#[test]
fn exactly_the_maximum_number_of_labels_is_accepted() {
    let full: Vec<String> = (0..MAX_LABELS).map(|i| format!("acme:l{i}")).collect();
    HookPolicy::parse(&top_doc(&full)).expect("at the bound");
    HookPolicy::parse(&rule_doc("labels", &full)).expect("at the bound");
}

#[test]
fn label_errors_never_echo_the_label() {
    let leaky = "Leaky-Label-Text:x".to_owned();
    for doc in [
        rule_doc("labels", std::slice::from_ref(&leaky)),
        rule_doc("refuse_labels", std::slice::from_ref(&leaky)),
        top_doc(std::slice::from_ref(&leaky)),
    ] {
        let message = HookPolicy::parse(&doc).expect_err("refused").to_string();
        assert!(!message.contains("Leaky"), "{message}");
        assert!(message.contains("[0]"), "{message}");
    }
    let message = HookPolicy::parse(&rule_doc("refuse_labels", &[leaky]))
        .expect_err("refused")
        .to_string();
    assert!(
        message.starts_with("tools[1].refuse_labels[0]"),
        "{message}"
    );
}

#[test]
fn a_label_list_must_be_an_array_of_strings() {
    for doc in [
        r#"{"version": 1, "refuse_labels": "acme:pii"}"#,
        r#"{"version": 1, "refuse_labels": [1]}"#,
        r#"{"version": 1, "tools": [{"name": "a", "decision": "allow", "labels": {}}]}"#,
    ] {
        assert!(
            matches!(HookPolicy::parse(doc), Err(PolicyError::Malformed(_))),
            "{doc}"
        );
    }
}

#[test]
fn a_policy_built_in_code_is_checked_the_same_way() {
    let policy = HookPolicy {
        refuse_labels: vec!["acme:pii".into(), "acme:pii".into()],
        ..HookPolicy::default()
    };
    assert_eq!(
        policy.check(),
        Err(PolicyError::Label {
            list: "refuse_labels",
            index: 1
        })
    );
}
