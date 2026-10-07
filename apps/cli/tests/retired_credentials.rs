//! Real native binary journeys: old passwords admit only synthetic reads, never real keys.
use opensesame_human_vault::retired_credentials::Response;
use opensesame_sealed_store::retired_credentials::enroll_retired_password;
use opensesame_sealed_store::{init_store, init_store_key, Entry};
use std::io::{Seek, SeekFrom, Write};
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

fn run_export(root: &Path, password: &str, destination: &Path) -> Output {
    // A real nonterminal export prompt gets a usable password, so refusal cannot
    // pass merely because KDBX password input was absent after a bad admission.
    let mut prompt = tempfile::tempfile().unwrap();
    writeln!(prompt, "fixture-export-password").unwrap();
    prompt.seek(SeekFrom::Start(0)).unwrap();
    Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass", "export-kdbx"])
        .arg(destination)
        .args(["--reveal", "--path"])
        .arg(root)
        .env("OPENSESAME_STORE_PASSWORD", password)
        .stdin(Stdio::from(prompt))
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

fn insert_standalone_credential_fixture(
    root: &opensesame_sealed_store::StoreRoot,
    key: &opensesame_sealed_store::ItemDataKey,
) -> serde_json::Value {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../spec/conformance/produce-vectors.json"
    ))
    .unwrap();
    let case = vectors["derived"][0].clone();
    let meta = serde_json::json!({ "v": 2, "kind": "credential", "values": { "method": {
        "id": "standalone", "type": "password", "pepper": false, "secret": case["root"],
        "generator": { "id": "derived", "rules": case["rules"], "counter": case["counter"] },
        "changedAt": "2026-01-01T00:00:00.000Z"
    } } });
    let entry = Entry::parse(&format!("\n{meta}\n"));
    assert!(entry.secret.is_empty());
    assert!(!entry.trailer.contains(case["password"].as_str().unwrap()));
    root.insert("Owner/standalone.password", &entry, key)
        .unwrap();
    case
}

fn assert_standalone_credential_boundary(root: &Path, case: &serde_json::Value) {
    let expected = case["password"].as_str().unwrap();
    let derivation_root = case["root"].as_str().unwrap();
    let key_before = std::fs::read(root.join(".opensesame-key")).unwrap();
    let item_before = std::fs::read(root.join("Owner/standalone.password.osseal")).unwrap();
    enroll_retired_password(
        root,
        b"current owner",
        b"selected rejected",
        Response::Reject,
    )
    .unwrap();
    for retired in ["selected retired", "selected rejected"] {
        let denied = run(
            root,
            retired,
            &["show", "Owner/standalone.password", "--reveal"],
        );
        assert!(!denied.status.success());
        for output in [&denied.stdout, &denied.stderr] {
            let text = String::from_utf8_lossy(output);
            assert!(!text.contains(expected) && !text.contains(derivation_root));
        }
        let destination = root.join(format!("denied-{retired}.kdbx"));
        let denied_export = run_export(root, retired, &destination);
        assert!(!denied_export.status.success());
        assert!(!destination.exists());
    }
    let fresh_owner = run(
        root,
        "current owner",
        &["show", "Owner/standalone.password", "--reveal"],
    );
    assert!(fresh_owner.status.success());
    assert_eq!(
        String::from_utf8(fresh_owner.stdout)
            .unwrap()
            .lines()
            .next(),
        Some(expected)
    );
    let genuine_export = root.join("fresh-owner.kdbx");
    assert!(run_export(root, "current owner", &genuine_export)
        .status
        .success());
    let encrypted = std::fs::read(genuine_export).unwrap();
    assert!(!encrypted.is_empty());
    assert!(!encrypted
        .windows(expected.len())
        .any(|bytes| bytes == expected.as_bytes()));
    assert!(!encrypted
        .windows(derivation_root.len())
        .any(|bytes| bytes == derivation_root.as_bytes()));
    assert_eq!(
        std::fs::read(root.join(".opensesame-key")).unwrap(),
        key_before
    );
    assert_eq!(
        std::fs::read(root.join("Owner/standalone.password.osseal")).unwrap(),
        item_before
    );
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
    let standalone = insert_standalone_credential_fixture(&root, &key);
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
    assert_standalone_credential_boundary(dir.path(), &standalone);
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

#[cfg(windows)]
#[test]
fn windows_real_binary_rejects_selected_password_without_changing_owner_key() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"current owner").unwrap();
    root.insert("Owner/private", &Entry::parse("owner-only-secret\n"), &key)
        .unwrap();
    enroll_retired_password(
        dir.path(),
        b"current owner",
        b"selected rejected",
        Response::Reject,
    )
    .unwrap();
    let before = std::fs::read(dir.path().join(".opensesame-key")).unwrap();
    for args in [&["list"][..], &["show", "Owner/private", "--reveal"][..]] {
        let rejected = run(dir.path(), "selected rejected", args);
        assert!(!rejected.status.success());
        assert!(!String::from_utf8(rejected.stdout)
            .unwrap()
            .contains("owner-only-secret"));
        assert_eq!(
            std::fs::read(dir.path().join(".opensesame-key")).unwrap(),
            before
        );
    }
    let genuine = run(
        dir.path(),
        "current owner",
        &["show", "Owner/private", "--reveal"],
    );
    assert!(genuine.status.success());
    assert!(String::from_utf8(genuine.stdout)
        .unwrap()
        .contains("owner-only-secret"));
}
