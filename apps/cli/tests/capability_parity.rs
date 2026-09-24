//! Agent-surface parity pact (ADR 0065): every `surfaces.cli` command the
//! capability registry claims for the `opensesame` binary must still exist in
//! the clap sources. Renaming or removing a CLI verb without updating
//! `packages/capability-registry` fails here; adding a verb without a registry
//! entry is caught by the weekly agent-surface drift routine and the
//! registry's own coverage rules.

const CAPABILITIES_JSON: &str =
    include_str!("../../../packages/capability-registry/capabilities.json");

const CLI_SOURCES: &[&str] = &[
    include_str!("../src/main.rs"),
    include_str!("../src/daemon_cmd.rs"),
    include_str!("../src/daemon_toolbar.rs"),
    include_str!("../src/serve.rs"),
    include_str!("../src/entry.rs"),
    include_str!("../src/connect.rs"),
    include_str!("../src/configs.rs"),
    include_str!("../src/certs.rs"),
    include_str!("../src/store.rs"),
    include_str!("../src/attach.rs"),
    include_str!("../src/bridge.rs"),
    include_str!("../src/lifecycle.rs"),
    include_str!("../src/sync_commands.rs"),
    include_str!("../src/local_authority.rs"),
    include_str!("../src/vault_migration.rs"),
];

/// True when `token` appears in `haystack` (lowercased) delimited by
/// non-identifier characters, so clap derive variant names (`Ls`, `Rotate`),
/// `#[command(name = "...")]` literals, and aliases all match while substrings
/// inside longer identifiers do not.
fn has_word(haystack: &str, token: &str) -> bool {
    let token = token.to_ascii_lowercase();
    let haystack = haystack.to_ascii_lowercase();
    let bytes = haystack.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(&token) {
        let at = start + pos;
        let end = at + token.len();
        let left_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        let right_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        start = at + 1;
    }
    false
}

#[test]
fn registry_cli_surfaces_exist_in_clap_sources() {
    let capabilities: serde_json::Value =
        serde_json::from_str(CAPABILITIES_JSON).expect("capabilities.json parses");
    let combined = CLI_SOURCES
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("\n");

    let mut checked = 0usize;
    let mut missing: Vec<String> = Vec::new();
    for capability in capabilities.as_array().expect("registry is an array") {
        let Some(cli) = capability["surfaces"]["cli"].as_str() else {
            continue;
        };
        let mut tokens = cli.split_whitespace();
        if tokens.next() != Some("opensesame") {
            continue; // opensesame-id surfaces are checked by packages/cli.
        }
        for token in tokens {
            checked += 1;
            if !has_word(&combined, token) {
                missing.push(format!(
                    "{}: `{cli}` token `{token}` not found in CLI sources",
                    capability["id"]
                ));
            }
        }
    }

    assert!(checked > 20, "registry lost its opensesame CLI surfaces");
    assert!(
        missing.is_empty(),
        "capability registry / CLI drift:\n{}",
        missing.join("\n")
    );
}

/// Verbs that are shell mechanics or another interface over capabilities the
/// registry already holds, rather than capabilities of their own.
const INTERFACE_VERBS: &[&str] = &["help", "completion", "tui"];

/// The other direction: every top-level `opensesame` verb is a registry
/// capability, so a verb cannot ship on the CLI without the registry — and
/// with it every other target's column — knowing (ADR 0139).
#[test]
fn every_cli_verb_is_a_registry_capability() {
    let help = std::process::Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .arg("--help")
        .output()
        .expect("opensesame --help runs");
    let help = String::from_utf8(help.stdout).expect("help is UTF-8");
    let verbs: Vec<&str> = help
        .lines()
        .skip_while(|line| !line.starts_with("Commands:"))
        .skip(1)
        .take_while(|line| line.starts_with("  "))
        .filter_map(|line| line.split_whitespace().next())
        .collect();
    assert!(
        verbs.len() > 20,
        "no commands in `opensesame --help`:\n{help}"
    );

    let capabilities: serde_json::Value =
        serde_json::from_str(CAPABILITIES_JSON).expect("capabilities.json parses");
    let registered: std::collections::BTreeSet<&str> = capabilities
        .as_array()
        .expect("registry is an array")
        .iter()
        .filter_map(|capability| capability["surfaces"]["cli"].as_str())
        .filter_map(|cli| cli.strip_prefix("opensesame "))
        .filter_map(|rest| rest.split_whitespace().next())
        .collect();
    let unregistered: Vec<&str> = verbs
        .into_iter()
        .filter(|verb| !registered.contains(verb) && !INTERFACE_VERBS.contains(verb))
        .collect();
    assert!(
        unregistered.is_empty(),
        "`opensesame` verbs with no packages/capability-registry entry: {unregistered:?}"
    );
}

#[test]
fn word_matching_rejects_substrings() {
    assert!(has_word("connectcmd::ls {", "ls"));
    assert!(!has_word("let value = false;", "ls"));
    assert!(has_word("Rotate {", "rotate"));
    assert!(!has_word("rotated_at", "rotate"));
}
