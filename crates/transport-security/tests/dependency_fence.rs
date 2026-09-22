//! This crate must never reach a Wasm or browser build, nor the daemon's
//! dependency budget: parse the workspace manifests and assert the fenced
//! crates do not depend on it, directly or through `[target.*]` tables.

use std::path::Path;

fn manifest_depends_on(path: &Path, name: &str) -> bool {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let value: toml::Value =
        toml::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut tables: Vec<&toml::Value> = Vec::new();
    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(t) = value.get(key) {
            tables.push(t);
        }
    }
    if let Some(targets) = value.get("target").and_then(|t| t.as_table()) {
        for target in targets.values() {
            for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(t) = target.get(key) {
                    tables.push(t);
                }
            }
        }
    }
    tables.iter().any(|t| {
        t.as_table().is_some_and(|table| {
            table
                .iter()
                .any(|(k, v)| k == name || v.get("package").and_then(|p| p.as_str()) == Some(name))
        })
    })
}

#[test]
fn fenced_crates_never_depend_on_transport_security() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for fenced in [
        "crates/core",
        "crates/client-core",
        "apps/daemon",
        "crates/domain",
        "crates/uds-authn",
    ] {
        let manifest = root.join(fenced).join("Cargo.toml");
        assert!(manifest.exists(), "{}", manifest.display());
        assert!(
            !manifest_depends_on(&manifest, "opensesame-transport-security"),
            "{fenced} must not depend on opensesame-transport-security"
        );
    }
    // And this crate is not a default member (never built into a binary by
    // accident) and never depends on the fenced crates either.
    let own = root.join("crates/transport-security/Cargo.toml");
    for fenced in [
        "opensesame-core",
        "opensesame-client-core",
        "opensesame-daemon",
    ] {
        assert!(!manifest_depends_on(&own, fenced));
    }
    let workspace: toml::Value =
        toml::from_str(&std::fs::read_to_string(root.join("Cargo.toml")).unwrap()).unwrap();
    let members = workspace["workspace"]["members"].as_array().unwrap();
    assert!(members
        .iter()
        .any(|m| m.as_str() == Some("crates/transport-security")));
    let defaults = workspace["workspace"]["default-members"]
        .as_array()
        .unwrap();
    assert!(!defaults
        .iter()
        .any(|m| m.as_str() == Some("crates/transport-security")));
}
