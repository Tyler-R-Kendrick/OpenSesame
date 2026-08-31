//! Runtime install and uninstall, with no build in between (ADR 0087 §7).

use std::fs;

use opensesame_vault_item_types::{ErrorCode, ItemTypeRegistry, Source};

fn community(id: &str, publisher: &str, version: &str) -> String {
    serde_json::json!({
        "apiVersion": "opensesame.dev/v1alpha1",
        "kind": "VaultItemType",
        "metadata": { "id": id, "version": version, "publisher": publisher },
        "spec": {
            "title": "Community type",
            "plural": "Community types",
            "extension": ".ct",
            "summary": "Installed at runtime, with no build.",
            "categories": ["other"],
            "sections": [{
                "id": "main",
                "title": "Main",
                "fields": [{ "id": "label", "type": "string", "label": "Label" }]
            }],
            "native": { "secret": null, "trailer": [{ "key": "label", "field": "label" }] },
            "cxf": { "credential": "custom-fields" },
            "subtitle": ["label"],
            "search": ["label"]
        }
    })
    .to_string()
}

#[test]
fn installs_and_uninstalls_a_community_type() {
    let mut registry = ItemTypeRegistry::with_builtins();
    assert!(!registry.has("field-notes"));
    registry
        .install(
            &community("field-notes", "https://community.test", "1.0.0"),
            Source::Vault,
        )
        .expect("a valid definition installs");
    assert!(registry.has("field-notes"));
    assert_eq!(registry.source_of("field-notes"), Some(Source::Vault));
    assert!(!registry.is_builtin("field-notes"));

    assert!(registry.uninstall("field-notes"));
    assert!(!registry.has("field-notes"));
    assert!(!registry.uninstall("field-notes"));
    // Uninstalling one type leaves every other alone.
    assert!(registry.has("login"));
}

#[test]
fn refuses_to_shadow_a_built_in_id() {
    let mut registry = ItemTypeRegistry::with_builtins();
    let errors = registry
        .install(
            &community("login", "https://community.test", "9.0.0"),
            Source::Vault,
        )
        .expect_err("a built-in id is reserved");
    assert!(errors.has(ErrorCode::Id));
    assert_eq!(
        registry.get("login").map(|d| d.spec.title.clone()),
        Some("Login".to_owned())
    );
}

#[test]
fn refuses_a_second_publisher_taking_over_an_installed_id() {
    let mut registry = ItemTypeRegistry::with_builtins();
    registry
        .install(
            &community("shared", "https://first.test", "1.0.0"),
            Source::Vault,
        )
        .expect("first install");
    let errors = registry
        .install(
            &community("shared", "https://second.test", "2.0.0"),
            Source::Vault,
        )
        .expect_err("identity is publisher + id");
    assert!(errors.has(ErrorCode::Publisher));
}

#[test]
fn accepts_an_upgrade_and_refuses_a_downgrade() {
    let mut registry = ItemTypeRegistry::with_builtins();
    registry
        .install(
            &community("shared", "https://first.test", "1.2.0"),
            Source::Vault,
        )
        .expect("first install");
    registry
        .install(
            &community("shared", "https://first.test", "1.3.0"),
            Source::Vault,
        )
        .expect("an upgrade from the same publisher");
    let errors = registry
        .install(
            &community("shared", "https://first.test", "1.0.0"),
            Source::Vault,
        )
        .expect_err("a downgrade is refused");
    assert!(errors.has(ErrorCode::Version));
    assert_eq!(
        registry.get("shared").map(|d| d.metadata.version.clone()),
        Some("1.3.0".to_owned())
    );
}

#[test]
fn loads_a_host_provisioned_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(
        dir.path().join("field-notes.json"),
        community("field-notes", "https://ops.test", "1.0.0"),
    )
    .expect("write definition");
    fs::write(dir.path().join("README.md"), "not a definition").expect("write readme");

    let mut registry = ItemTypeRegistry::with_builtins();
    let loaded = registry
        .load_directory(dir.path())
        .expect("directory loads");
    assert_eq!(loaded, 1);
    assert_eq!(registry.source_of("field-notes"), Some(Source::Host));
}

#[test]
fn an_absent_directory_provisions_nothing_rather_than_failing() {
    let mut registry = ItemTypeRegistry::with_builtins();
    let loaded = registry
        .load_directory(std::path::Path::new("/nonexistent/item-types"))
        .expect("an absent directory is not an error");
    assert_eq!(loaded, 0);
}

#[test]
fn an_invalid_file_in_the_directory_fails_the_load() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("broken.json"), "{ not json").expect("write broken");
    let mut registry = ItemTypeRegistry::with_builtins();
    let error = registry
        .load_directory(dir.path())
        .expect_err("an invalid definition fails the load rather than being skipped");
    assert!(error.to_string().contains("broken.json"));
}

#[test]
fn an_empty_registry_knows_nothing() {
    let registry = ItemTypeRegistry::new();
    assert!(registry.get("login").is_none());
    assert!(registry.list().is_empty());
}

#[test]
fn refuses_an_install_that_claims_another_types_extension() {
    let mut registry = ItemTypeRegistry::with_builtins();
    // `.login` is how the VFS tree spells a login. A type that could claim it
    // could dress its items as logins.
    let errors = registry
        .install(
            &community("impostor", "https://community.test", "1.0.0").replace(".ct", ".login"),
            Source::Vault,
        )
        .expect_err("a built-in extension is taken");
    assert!(errors.has(ErrorCode::Extension));

    registry
        .install(
            &community("first", "https://a.test", "1.0.0"),
            Source::Vault,
        )
        .expect("first install");
    let errors = registry
        .install(
            &community("second", "https://b.test", "1.0.0"),
            Source::Vault,
        )
        .expect_err("an installed extension is taken too");
    assert!(errors.has(ErrorCode::Extension));
}

#[test]
fn a_type_keeps_its_own_extension_across_an_upgrade() {
    let mut registry = ItemTypeRegistry::with_builtins();
    registry
        .install(&community("same", "https://a.test", "1.0.0"), Source::Vault)
        .expect("first install");
    registry
        .install(&community("same", "https://a.test", "1.1.0"), Source::Vault)
        .expect("an upgrade keeps its own extension");
}
