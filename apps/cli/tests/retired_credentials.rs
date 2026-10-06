//! Real native binary journeys: old passwords admit only synthetic reads, never real keys.
use opensesame_human_vault::retired_credentials::Response;
use opensesame_sealed_store::retired_credentials::enroll_retired_password;
use opensesame_sealed_store::{init_store, init_store_key, Entry};
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn run(root: &Path, password: &str, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass"])
        .args(args)
        .arg("--path")
        .arg(root)
        .env("OPENSESAME_STORE_PASSWORD", password)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn insert_pepper_fixture(
    root: &opensesame_sealed_store::StoreRoot,
    key: &opensesame_sealed_store::ItemDataKey,
) {
    let meta = serde_json::json!({ "v": 2, "kind": "account", "values": { "methods": [{
        "id": "m", "type": "password", "pepper": true, "pepperAt": "-2",
        "secret": "abcdefgh", "generator": { "id": "manual" }, "changedAt": "x"
    }] } });
    root.insert("Owner/peppered", &Entry::parse(&format!("\n{meta}\n")), key)
        .unwrap();
}

fn assert_current_owner_pepper_facade(root: &Path) {
    let shown = run(
        root,
        "current owner",
        &["show", "Owner/peppered", "--reveal"],
    );
    assert!(shown.status.success());
    assert_eq!(
        String::from_utf8(shown.stdout).unwrap().lines().next(),
        Some("abcdef")
    );
    assert!(String::from_utf8(shown.stderr)
        .unwrap()
        .contains("Add your pepper after this"));
    assert!(!run(
        root,
        "selected retired",
        &["show", "Owner/peppered", "--reveal"]
    )
    .status
    .success());
}

#[test]
fn real_binary_routes_normal_reads_and_denies_every_production_branch() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"current owner").unwrap();
    insert_pepper_fixture(&root, &key);
    root.insert(
        "Example/account",
        &Entry::parse("owner-only-secret\n"),
        &key,
    )
    .unwrap();
    root.insert(
        "Owner/private",
        &Entry::parse("another-owner-secret\n"),
        &key,
    )
    .unwrap();
    enroll_retired_password(
        dir.path(),
        b"current owner",
        b"selected retired",
        Response::SyntheticDecoy,
    )
    .unwrap();
    let decoy = run(
        dir.path(),
        "selected retired",
        &["show", "Example/account", "--reveal"],
    );
    assert!(
        decoy.status.success(),
        "{}",
        String::from_utf8_lossy(&decoy.stderr)
    );
    let text = String::from_utf8(decoy.stdout).unwrap();
    assert!(text.starts_with("synthetic-"));
    assert!(!text.contains("owner-only-secret"));
    let list = run(dir.path(), "selected retired", &["ls"]);
    assert!(list.status.success());
    assert_eq!(
        String::from_utf8(list.stdout).unwrap().trim(),
        "Example/account"
    );
    assert!(
        !run(dir.path(), "selected retired", &["rm", "Owner/private"])
            .status
            .success()
    );
    assert!(!run(dir.path(), "selected retired", &["backup"])
        .status
        .success());
    let exported = dir.path().join("escaped.kdbx");
    let output = run(
        dir.path(),
        "selected retired",
        &["export-kdbx", exported.to_str().unwrap(), "--reveal"],
    );
    assert!(!output.status.success());
    assert!(!exported.exists());
    let real = run(
        dir.path(),
        "current owner",
        &["show", "Owner/private", "--reveal"],
    );
    assert!(real.status.success());
    assert!(String::from_utf8(real.stdout)
        .unwrap()
        .contains("another-owner-secret"));
    assert_current_owner_pepper_facade(dir.path());
}

#[test]
fn settings_enrollment_cannot_be_armed_by_a_non_terminal_agent() {
    let output = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args([
            "pass",
            "security",
            "retired",
            "enroll",
            "--acknowledge-verifier-risk",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("human terminal"));
}
