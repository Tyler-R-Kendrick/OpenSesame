//! `opensesame pass protect root-rotate | rewrap` driven through the real
//! binary: after a rotation the store still opens with its passphrase, and the
//! key file as git history keeps it no longer opens anything in the store.

use opensesame_sealed_store::{unlock_store_key, StoreError, StoreRoot};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

mod cli_app_integration_mock;
#[cfg(unix)]
mod terminal_person;

const PASSPHRASE: &str = "correct horse battery staple";

fn run_with(store: &Path, password: &str, args: &[&str], stdin: &str) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .args(args)
        .arg("--path")
        .arg(store)
        .env("OPENSESAME_STORE_PASSWORD", password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env(
            "OPENSESAME_DAEMON_API",
            cli_app_integration_mock::shared_daemon_base().as_str(),
        );
    let mut child = command
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

#[cfg(unix)]
fn person_command(store: &Path, password: &str, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .args(args)
        .arg("--path")
        .arg(store)
        .env("OPENSESAME_STORE_PASSWORD", password)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env(
            "OPENSESAME_DAEMON_API",
            cli_app_integration_mock::shared_daemon_base().as_str(),
        );
    command
}

/// Portable stored-data checks; these do not certify Windows terminal reveal.
fn stored_entry(store: &Path, password: &str) -> Result<String, StoreError> {
    let key = unlock_store_key(store, password.as_bytes())?;
    StoreRoot::open(store)?
        .show("Dev/token", &key)
        .map(|entry| entry.render())
}

fn stored_document(store: &Path, password: &str) -> Result<Vec<u8>, StoreError> {
    let key = unlock_store_key(store, password.as_bytes())?;
    let mut bytes = Vec::new();
    StoreRoot::open(store)?.attach_get("Taxes/w2", &mut bytes, &key)?;
    Ok(bytes)
}

fn shows(store: &Path, password: &str) -> Option<String> {
    let stored = stored_entry(store, password).ok();
    #[cfg(unix)]
    {
        let out = terminal_person::run(person_command(
            store,
            password,
            &["pass", "show", "Dev/token", "--reveal"],
        ));
        let shown = out.status.success().then(|| {
            String::from_utf8_lossy(&out.stdout)
                .replace("\r\n", "\n")
                .replace('\r', "")
        });
        assert_eq!(
            shown, stored,
            "terminal reveal must match independent stored entry"
        );
    }
    stored
}

fn document(store: &Path, password: &str, out: &Path) -> Option<Vec<u8>> {
    let stored = stored_document(store, password).ok();
    #[cfg(unix)]
    {
        let got = terminal_person::run(person_command(
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
        ));
        let revealed = got.status.success().then(|| std::fs::read(out).unwrap());
        assert_eq!(
            revealed, stored,
            "terminal reveal must match independent stored attachment"
        );
    }
    #[cfg(not(unix))]
    let _ = out;
    stored
}

/// Only copies the owned fixture, including dot files; no links or special files.
fn copy_fixture(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_fixture(&entry.path(), &target);
        } else {
            assert!(
                kind.is_file(),
                "unexpected fixture file type: {}",
                entry.path().display()
            );
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The store as it would come back with the pre-rotation key file restored
/// from git history.
fn with_old_key_file(f: &Fixture, old_key_file: &[u8]) -> PathBuf {
    let copy = f.dir.path().join("history");
    copy_fixture(&f.store, &copy);
    std::fs::write(copy.join(".opensesame-key"), old_key_file).unwrap();
    // The historical passphrase still unwraps the old root; ciphertext must reject it.
    unlock_store_key(&copy, PASSPHRASE.as_bytes()).expect("historical wrapper remains unlockable");
    assert!(matches!(
        stored_entry(&copy, PASSPHRASE),
        Err(StoreError::Crypto(_))
    ));
    assert!(matches!(
        stored_document(&copy, PASSPHRASE),
        Err(StoreError::Crypto(_))
    ));
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

    // OPENSESAME_STORE_PASSWORD answers only the current-passphrase prompt; the
    // new one is typed (here: piped), so it cannot silently be the same string.
    let kept = run_with(
        &f.store,
        PASSPHRASE,
        &["pass", "protect", "rewrap", "--yes", "--no-rotate"],
        "second passphrase\nsecond passphrase\n",
    );
    assert!(kept.status.success(), "{}", text(&kept));
    assert!(text(&kept).contains("NOT rotated"), "{}", text(&kept));
    assert_eq!(shows(&f.store, PASSPHRASE), None);

    let rewrapped = run_with(
        &f.store,
        "second passphrase",
        &["pass", "protect", "rewrap", "--yes"],
        "third passphrase\nthird passphrase\n",
    );
    assert!(rewrapped.status.success(), "{}", text(&rewrapped));
    assert_eq!(
        shows(&f.store, "third passphrase").as_deref(),
        Some("hunter2\n")
    );
    assert_eq!(shows(&f.store, "second passphrase"), None);
    let history = with_old_key_file(&f, &old_key_file);
    assert_eq!(shows(&history, PASSPHRASE), None);
}

#[test]
fn rewrap_takes_the_new_passphrase_from_the_prompt_not_the_environment() {
    let f = given_a_store_with_an_entry_and_a_document();

    // The environment still holds the old passphrase; stdin carries the new.
    let rewrapped = run_with(
        &f.store,
        PASSPHRASE,
        &["pass", "protect", "rewrap", "--yes"],
        "a different passphrase\na different passphrase\n",
    );
    assert!(rewrapped.status.success(), "{}", text(&rewrapped));
    assert!(
        text(&rewrapped).contains("the previous passphrase no longer opens the store"),
        "{}",
        text(&rewrapped)
    );
    assert_eq!(shows(&f.store, PASSPHRASE), None);
    assert_eq!(
        shows(&f.store, "a different passphrase").as_deref(),
        Some("hunter2\n")
    );
}

#[test]
fn rewrapping_to_the_current_passphrase_is_refused() {
    let f = given_a_store_with_an_entry_and_a_document();
    let key_file = std::fs::read(f.store.join(".opensesame-key")).unwrap();
    for extra in [&[][..], &["--no-rotate"][..]] {
        let mut args = vec!["pass", "protect", "rewrap", "--yes"];
        args.extend_from_slice(extra);
        let same = format!("{PASSPHRASE}\n{PASSPHRASE}\n");
        let refused = run_with(&f.store, PASSPHRASE, &args, &same);
        assert!(!refused.status.success(), "{}", text(&refused));
        assert!(
            text(&refused).contains("is the current one"),
            "{}",
            text(&refused)
        );
        // Nothing piped at all is an empty passphrase, never the env var.
        let empty = run_with(&f.store, PASSPHRASE, &args, "");
        assert!(!empty.status.success(), "{}", text(&empty));
    }
    assert_eq!(
        std::fs::read(f.store.join(".opensesame-key")).unwrap(),
        key_file
    );
    assert_eq!(shows(&f.store, PASSPHRASE).as_deref(), Some("hunter2\n"));
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
