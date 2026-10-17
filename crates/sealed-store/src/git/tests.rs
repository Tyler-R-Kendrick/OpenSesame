use super::*;
use crate::{init_store, Entry, ItemDataKey};
use std::process::Command;

fn git_init(dir: &Path) {
    let init = Command::new("git")
        .args(["init"])
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(init.success());
    let _ = Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(dir)
        .status();
}

fn tracked_files(dir: &Path) -> String {
    let tree = Command::new("git")
        .args([
            "-C",
            dir.to_str().unwrap(),
            "ls-tree",
            "-r",
            "--name-only",
            "HEAD",
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&tree.stdout).into_owned()
}

#[test]
fn auto_commit_records_insert() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());

    let root = init_store(dir.path(), &[]).unwrap();
    std::fs::write(dir.path().join("manifest.json"), r#"[{"secret":"leak"}]"#).unwrap();
    let key = ItemDataKey([1u8; 32]);
    root.insert(
        "a",
        &Entry {
            secret: "x".into(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .unwrap();
    let log = Command::new("git")
        .args([
            "-C",
            dir.path().to_str().unwrap(),
            "log",
            "-1",
            "--pretty=%s",
        ])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains(crate::store::COMMIT_ADD));
    assert!(!tracked_files(dir.path()).contains("manifest.json"));
}

#[test]
fn attachment_ciphertext_is_committed_but_local_state_is_not() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    init_store(dir.path(), &[]).unwrap();

    // Stand in for what an attachment writes: a manifest, a chunk object,
    // and the local-only revision map.
    std::fs::create_dir_all(dir.path().join(".attachments/objects/ab")).unwrap();
    std::fs::create_dir_all(dir.path().join("Taxes")).unwrap();
    std::fs::write(dir.path().join("Taxes/w2.osattach"), b"sealed manifest").unwrap();
    std::fs::write(
        dir.path().join(".attachments/objects/ab/abcd.oschunk"),
        b"sealed chunk",
    )
    .unwrap();
    std::fs::write(
        dir.path().join(".opensesame-attachment-revisions.json"),
        b"{}",
    )
    .unwrap();

    auto_commit(dir.path(), crate::store::COMMIT_ATTACH).unwrap();
    let tracked = tracked_files(dir.path());
    assert!(tracked.contains("Taxes/w2.osattach"), "{tracked}");
    assert!(tracked.contains("abcd.oschunk"), "{tracked}");
    assert!(
        !tracked.contains("attachment-revisions"),
        "anti-rollback state is local-only: {tracked}"
    );
}

#[test]
fn remote_round_trip_and_autopush_flag() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    assert!(remote_url(dir.path()).is_none());
    set_remote(dir.path(), "https://github.com/example/store.git").unwrap();
    assert_eq!(
        remote_url(dir.path()).as_deref(),
        Some("https://github.com/example/store.git")
    );
    // set-url path
    set_remote(dir.path(), "https://github.com/example/other.git").unwrap();
    assert_eq!(
        remote_url(dir.path()).as_deref(),
        Some("https://github.com/example/other.git")
    );
    assert!(!auto_push_enabled(dir.path()));
    set_auto_push(dir.path(), true).unwrap();
    assert!(auto_push_enabled(dir.path()));
    set_auto_push(dir.path(), false).unwrap();
    assert!(!auto_push_enabled(dir.path()));
}

#[test]
fn push_backup_to_local_bare_remote() {
    let store = tempfile::tempdir().unwrap();
    let bare = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "--bare"])
        .current_dir(bare.path())
        .status()
        .unwrap()
        .success());
    git_init(store.path());
    let root = init_store(store.path(), &[]).unwrap();
    let key = ItemDataKey([2u8; 32]);
    root.insert(
        "b",
        &Entry {
            secret: "y".into(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .unwrap();
    set_remote(store.path(), bare.path().to_str().unwrap()).unwrap();
    push_backup(store.path(), None).unwrap();
    let log = Command::new("git")
        .args(["log", "-1", "--pretty=%s"])
        .current_dir(bare.path())
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains(crate::store::COMMIT_ADD));
}

#[test]
fn push_backup_without_remote_names_the_fix() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    let err = push_backup(dir.path(), None).unwrap_err();
    assert!(err.to_string().contains("--remote"));
}
