//! Production binary must not honor the legacy app-integration seam env var.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[cfg(unix)]
mod terminal_person;

const PASSPHRASE: &str = "correct horse battery staple";

fn command(store: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .args(args)
        .arg("--path")
        .arg(store)
        .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE);
    command
}

fn given_a_store_with_an_entry() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    let init = command(&store, &["pass", "init"]).output().expect("init");
    assert!(init.status.success());
    let mut insert = command(&store, &["pass", "insert", "Dev/token"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("insert");
    insert
        .stdin
        .take()
        .unwrap()
        .write_all(b"hunter2\n")
        .unwrap();
    assert!(insert
        .wait_with_output()
        .expect("insert wait")
        .status
        .success());
    (dir, store)
}

fn legacy_seam(store: &Path) -> Command {
    let mut command = command(store, &["pass", "show", "Dev/token", "--reveal"]);
    command
        .env("OPENSESAME_CLI_APP_INTEGRATION_SEAM", "approve")
        .env("OPENSESAME_DAEMON_API", "http://127.0.0.1:1")
        .env_remove("OPENSESAME_DAEMON_LISTEN");
    command
}

fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[cfg(unix)]
#[test]
fn seam_env_without_daemon_is_refused_after_terminal_gate() {
    let (_dir, store) = given_a_store_with_an_entry();
    let output = terminal_person::run(legacy_seam(&store));
    let combined = combined(&output);
    assert!(!output.status.success(), "combined output:\n{combined}");
    assert!(
        combined.contains("OpenSesame is not running") || combined.contains("Unlock OpenSesame"),
        "expected app-unavailable copy, got:\n{combined}"
    );
}

#[test]
fn piped_legacy_approval_cannot_bypass_the_terminal_gate() {
    let (_dir, store) = given_a_store_with_an_entry();
    let output = legacy_seam(&store).output().expect("piped reveal");
    let combined = combined(&output);
    assert!(!output.status.success(), "combined output:\n{combined}");
    assert!(combined.contains("interactive terminals"), "{combined}");
    assert!(
        !combined.contains("hunter2"),
        "refusal must not output the secret"
    );
}
