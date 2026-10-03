//! The presets: one source (ADR 0139) with a drift test, every one a policy
//! the parser reads, and the rotation preset proven by walking a real hooked
//! run under it.

use std::collections::BTreeSet;
use std::path::PathBuf;

use opensesame_agent_hooks::policy::ToolDecision;
use opensesame_agent_hooks::HookPolicy;
use opensesame_rotation_web::hooks::{BROWSER_VERBS, CEREMONY_VERBS};

use super::{all, parse, SOURCES};

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/agent-hooks/presets")
}

pub(super) fn policy_of(name: &str) -> HookPolicy {
    all()
        .unwrap()
        .into_iter()
        .find(|preset| preset.name == name)
        .unwrap_or_else(|| panic!("no preset named {name}"))
        .policy
}

/// ADR 0139: the directory is the source, this table is an embedding of it.
#[test]
fn the_embedded_table_and_the_presets_directory_agree() {
    let mut on_disk = BTreeSet::new();
    for entry in std::fs::read_dir(directory()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let stem = path.file_stem().unwrap().to_str().unwrap().to_owned();
            // The embedded text is the file's text, not a stale copy.
            let text = std::fs::read_to_string(&path).unwrap();
            let embedded = SOURCES.iter().find(|(name, _)| *name == stem);
            assert_eq!(
                embedded.map(|(_, source)| *source),
                Some(text.as_str()),
                "{stem}.json is missing from SOURCES or differs from it"
            );
            on_disk.insert(stem);
        }
    }
    let embedded: BTreeSet<String> = SOURCES.iter().map(|(name, _)| (*name).to_owned()).collect();
    assert_eq!(on_disk, embedded, "a preset file and the table disagree");
    // The route's order is the table's, and the table is sorted.
    let names: Vec<&str> = SOURCES.iter().map(|(name, _)| *name).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted);
}

#[test]
fn every_preset_is_a_policy_the_parser_reads() {
    let presets = all().unwrap();
    assert_eq!(presets.len(), SOURCES.len());
    for preset in &presets {
        assert!(!preset.summary.is_empty(), "{}", preset.name);
        // What the route hands out is what a PUT would store: the parser
        // reads it, and reads back the same policy.
        let text = serde_json::to_string(&preset.policy).unwrap();
        assert_eq!(HookPolicy::parse(&text).as_ref(), Ok(&preset.policy));
    }
}

#[test]
fn a_malformed_preset_file_is_refused_by_name() {
    for (source, why) in [
        ("{}", "not a preset file"),
        (
            r#"{"preset":2,"name":"x","summary":"s","policy":{"version":1}}"#,
            "unsupported preset version",
        ),
        (
            r#"{"preset":1,"name":"other","summary":"s","policy":{"version":1}}"#,
            "the name is not the file's name",
        ),
        (
            r#"{"preset":1,"name":"x","summary":"s","policy":{"version":9}}"#,
            "policy refused",
        ),
        (
            r#"{"preset":1,"name":"x","summary":"s","policy":{"version":1},"extra":1}"#,
            "not a preset file",
        ),
    ] {
        let fault = parse("x", source).unwrap_err();
        assert!(fault.0.starts_with("preset x:"), "{}", fault.0);
        assert!(fault.0.contains(why), "{}: {why}", fault.0);
    }
}

#[test]
fn strict_denies_everything_and_observe_allows_everything() {
    let strict = policy_of("strict");
    assert_eq!(strict.unlisted_tools, ToolDecision::Deny);
    assert!(strict.tools.is_empty());
    assert_eq!(
        strict.secret_guard,
        opensesame_agent_hooks::SecretGuard::Deny
    );
    for verb in BROWSER_VERBS.iter().chain(&CEREMONY_VERBS) {
        assert_eq!(strict.tool(verb).decision, ToolDecision::Deny, "{verb}");
    }
    let observe = policy_of("observe");
    assert_eq!(observe.unlisted_tools, ToolDecision::Allow);
    assert_eq!(
        observe.secret_guard,
        opensesame_agent_hooks::SecretGuard::Redact
    );
    assert_eq!(
        observe.tool("anything_at_all").decision,
        ToolDecision::Allow
    );
}

#[test]
fn the_rotation_preset_names_exactly_the_tool_boundary_and_nothing_else() {
    let rotation = policy_of("rotation-web-login");
    let verbs: BTreeSet<&str> = BROWSER_VERBS
        .iter()
        .chain(&CEREMONY_VERBS)
        .copied()
        .collect();
    let named: BTreeSet<&str> = rotation
        .tools
        .iter()
        .map(|rule| rule.name.as_deref().expect("exact names, never prefixes"))
        .collect();
    assert_eq!(named, verbs, "a verb was added or renamed in rotation-web");
    for rule in &rotation.tools {
        assert_eq!(rule.decision, ToolDecision::Allow);
    }
    // Anything else — a prefix lookalike included — is refused outright.
    assert_eq!(rotation.unlisted_tools, ToolDecision::Deny);
    for other in ["shell", "navigate2", "fill_credential_raw", "github.issues"] {
        assert_eq!(rotation.tool(other).decision, ToolDecision::Deny, "{other}");
    }
    assert_eq!(
        rotation.secret_guard,
        opensesame_agent_hooks::SecretGuard::Redact
    );
    assert_eq!(
        rotation.refuse_labels,
        [opensesame_agent_hooks::LABEL_CREDENTIAL_MATERIAL]
    );
    for read in ["read_dom_redacted", "screenshot_redacted"] {
        assert_eq!(
            rotation.tool(read).labels,
            ["opensesame:untrusted_page"],
            "{read}"
        );
    }
}
