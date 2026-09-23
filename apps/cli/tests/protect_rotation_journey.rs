//! `opensesame pass protect root-rotate | rewrap` driven through the real
//! binary: after a rotation the store still opens with its passphrase, and the
//! key file as git history keeps it no longer opens anything in the store.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const PASSPHRASE: &str = "correct horse battery staple";

fn run_with(store: &Path, password: &str, args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(args)
        .arg("--path")
        .arg(store)
        .env("OPENSESAME_STORE_PASSWORD", password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to run the opensesame binary");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn run(store: &Path, args: &[&str]) -> Output {
    run_with(store, PASSPHRASE, args, "")
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn payload() -> Vec<u8> {
    (0..1_048_600usize)
        .map(|i| u8::try_from(i % 251).unwrap())
        .collect()
}

struct Fixture {
    dir: tempfile::TempDir,
    store: PathBuf,
}

fn given_a_store_with_an_entry_and_a_document() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    assert!(run(&store, &["pass", "init"]).status.success());
    let added = run_with(
        &store,
        PASSPHRASE,
        &["pass", "insert", "Dev/token"],
        "hunter2\n",
    );
    assert!(added.status.success(), "{}", text(&added));
    let source = dir.path().join("w2.pdf");
    std::fs::write(&source, payload()).unwrap();
    let attached = run(
        &store,
        &[
            "pass",
            "attach",
            "add",
            "Taxes/w2",
            source.to_str().unwrap(),
        ],
    );
    assert!(attached.status.success(), "{}", text(&attached));
    Fixture { dir, store }
}

fn shows(store: &Path, password: &str) -> Option<String> {
    let out = run_with(
        store,
        password,
        &["pass", "show", "Dev/token", "--reveal"],
        "",
    );
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn document(store: &Path, password: &str, out: &Path) -> Option<Vec<u8>> {
    let got = run_with(
        store,
        password,
        &[
            "pass",
            "attach",
            "get",
            "Taxes/w2",
            "--reveal",
            "--out",
            out.to_str().unwrap(),
        ],
        "",
    );
    got.status.success().then(|| std::fs::read(out).unwrap())
}

/// The store as it would come back with the pre-rotation key file restored
/// from git history.
fn with_old_key_file(f: &Fixture, old_key_file: &[u8]) -> PathBuf {
    let copy = f.dir.path().join("history");
    std::fs::create_dir_all(&copy).unwrap();
    let status = Command::new("cp")
        .arg("-a")
        .arg(format!("{}/.", f.store.display()))
        .arg(&copy)
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::write(copy.join(".opensesame-key"), old_key_file).unwrap();
    copy
}

#[test]
fn root_rotate_keeps_the_store_readable_and_retires_the_old_root() {
    let f = given_a_store_with_an_entry_and_a_document();
    let old_key_file = std::fs::read(f.store.join(".opensesame-key")).unwrap();

    let rotated = run(&f.store, &["pass", "protect", "root-rotate", "--yes"]);
    assert!(rotated.status.success(), "{}", text(&rotated));
    assert!(text(&rotated).contains("re-encrypted 1 entries and 1 attachments"));

    assert_eq!(shows(&f.store, PASSPHRASE).as_deref(), Some("hunter2\n"));
    let out = f.dir.path().join("recovered.pdf");
    assert_eq!(document(&f.store, PASSPHRASE, &out), Some(payload()));

    let history = with_old_key_file(&f, &old_key_file);
    assert_eq!(shows(&history, PASSPHRASE), None);
    let stolen = f.dir.path().join("stolen.pdf");
    assert_eq!(document(&history, PASSPHRASE, &stolen), None);
}

#[test]
fn rewrap_revokes_the_old_passphrase_unless_told_not_to() {
    let f = given_a_store_with_an_entry_and_a_document();
    let old_key_file = std::fs::read(f.store.join(".opensesame-key")).unwrap();

    let kept = run_with(
        &f.store,
        PASSPHRASE,
        &["pass", "protect", "rewrap", "--yes", "--no-rotate"],
        "",
    );
    assert!(kept.status.success(), "{}", text(&kept));
    assert!(text(&kept).contains("NOT rotated"), "{}", text(&kept));

    // OPENSESAME_STORE_PASSWORD answers every prompt, so the "new" passphrase
    // is the same string; what changes is the root under it.
    let rewrapped = run(&f.store, &["pass", "protect", "rewrap", "--yes"]);
    assert!(rewrapped.status.success(), "{}", text(&rewrapped));
    assert_eq!(shows(&f.store, PASSPHRASE).as_deref(), Some("hunter2\n"));
    let history = with_old_key_file(&f, &old_key_file);
    assert_eq!(shows(&history, PASSPHRASE), None);
}

#[test]
fn removing_the_last_passphrase_is_refused() {
    let f = given_a_store_with_an_entry_and_a_document();
    let added = run(&f.store, &["pass", "protect", "recovery", "add", "--yes"]);
    assert!(added.status.success(), "{}", text(&added));
    let listed = run(&f.store, &["pass", "protect", "list"]);
    let password_id = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .find(|line| line.contains("\tpassword\t"))
        .and_then(|line| line.split('\t').next())
        .unwrap()
        .to_string();

    let refused = run(
        &f.store,
        &["pass", "protect", "remove", &password_id, "--yes"],
    );
    assert!(!refused.status.success());
    assert!(
        text(&refused).contains("last verified unlock path"),
        "{}",
        text(&refused)
    );
    assert_eq!(shows(&f.store, PASSPHRASE).as_deref(), Some("hunter2\n"));
}
