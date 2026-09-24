//! `opensesame vault verify|ls` as a person runs it, on the refusal paths:
//! the master password comes from a terminal only — no argument, pipe or
//! environment variable opens a vault — and an envelope §7 refuses is
//! refused before any password is asked for. Opening the golden vectors is
//! proved by `src/vault_file_tests.rs` and `crates/human-vault`'s
//! `pages_vault_vectors`, which drive the same reader without a terminal.

use std::{
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const VECTORS: &str = include_str!("../../../spec/conformance/vault-vectors.json");

fn vector(name: &str) -> serde_json::Value {
    let fixture: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    serde_json::from_str(fixture["vectors"][name]["file"].as_str().unwrap()).unwrap()
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn run(args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env_clear()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().expect("opensesame runs")
}

fn refused(output: &Output, needle: &str) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "must fail: {stderr}");
    assert!(stderr.contains(needle), "{needle:?} not in {stderr}");
    assert!(output.stdout.is_empty(), "nothing is listed on a refusal");
}

#[test]
fn vault_lists_verify_and_ls() {
    let help = run(&["vault", "--help"], &[]);
    let text = String::from_utf8_lossy(&help.stdout);
    assert!(help.status.success());
    assert!(text.contains("verify") && text.contains("ls"), "{text}");
}

#[test]
fn the_master_password_comes_from_a_terminal_only() {
    let dir = tempfile::tempdir().unwrap();
    let file = write(
        dir.path(),
        "export.json",
        &vector("export-personal").to_string(),
    );
    let file = file.to_str().unwrap();
    let fixture: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let password = fixture["password"].as_str().unwrap();
    for verb in ["verify", "ls"] {
        // No terminal on stdin: refused, even with the password in every
        // environment variable the sealed store's own prompts honour.
        let output = run(
            &["vault", verb, file],
            &[
                ("OPENSESAME_STORE_PASSWORD", password),
                ("OPENSESAME_VAULT_PASSWORD", password),
            ],
        );
        refused(&output, "from a terminal only");
        // And no flag carries it.
        let flag = run(&["vault", verb, "--password", password, file], &[]);
        refused(&flag, "--password");
    }
}

#[test]
fn an_envelope_section_7_refuses_is_refused_before_the_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let mut sealed = vector("backup-personal");
    sealed["deploymentSealUsed"] = serde_json::json!(true);
    let mut no_tomb = vector("export-personal");
    no_tomb.as_object_mut().unwrap().remove("tomb");
    let cases = [
        (
            "not-json.json",
            "not a vault file".to_owned(),
            "Refused: not a vault file",
        ),
        ("empty.json", "{}".to_owned(), "Refused: not a vault file"),
        (
            "sealed.json",
            sealed.to_string(),
            "Refused: the backup claims a deployment seal wrap",
        ),
        (
            "no-tomb.json",
            no_tomb.to_string(),
            "Refused: the export names no tomb",
        ),
    ];
    for (name, text, needle) in cases {
        let path = write(dir.path(), name, &text);
        let output = run(&["vault", "ls", path.to_str().unwrap()], &[]);
        refused(&output, needle);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.contains("terminal"), "{name}: asked for a password");
    }
}

#[test]
fn a_missing_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.json");
    refused(
        &run(&["vault", "verify", missing.to_str().unwrap()], &[]),
        "cannot read",
    );
}
