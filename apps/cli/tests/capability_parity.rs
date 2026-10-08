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
    include_str!("../src/serve.rs"),
    include_str!("../src/entry.rs"),
    include_str!("../src/store.rs"),
    include_str!("../src/attach.rs"),
    include_str!("../src/bridge.rs"),
    include_str!("../src/bridge/bitwarden.rs"),
    include_str!("../src/hooks.rs"),
    include_str!("../src/rotate_local.rs"),
    include_str!("../src/rotate_recipes_sign.rs"),
    include_str!("../src/vault_migration.rs"),
    include_str!("../src/vault_file.rs"),
    include_str!("../src/vault_area.rs"),
    include_str!("../src/ceremony.rs"),
    include_str!("../src/dev_run.rs"),
    include_str!("../src/plugins.rs"),
    include_str!("../src/session.rs"),
    include_str!("../src/password_agent/mod.rs"),
    include_str!("../src/password_agent/consume.rs"),
    include_str!("../src/password_agent/service.rs"),
    include_str!("../src/password_agent/setup.rs"),
    include_str!("../src/password_agent/request.rs"),
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
    let registry = capabilities
        .as_array()
        .expect("capabilities.json is an array");
    let mut missing = Vec::new();
    for entry in registry {
        let surfaces = entry
            .get("surfaces")
            .and_then(|v| v.as_object())
            .expect("entry has surfaces object");
        let Some(cli) = surfaces.get("cli") else {
            continue;
        };
        if cli.is_null() {
            continue;
        }
        let cmd = cli
            .get("command")
            .and_then(|v| v.as_str())
            .expect("cli surface has command string");
        for token in cmd.split_whitespace() {
            if token == "opensesame" {
                continue;
            }
            if !has_word(&combined, token) {
                missing.push(format!(
                    "{}: missing `{}` in CLI sources",
                    entry.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                    token
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "capability registry lists CLI verbs absent from clap sources:\n{}",
        missing.join("\n")
    );
}
