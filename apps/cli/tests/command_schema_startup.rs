//! Command help must reach the genuine process parser with its default stack.
use std::process::{Command, Output};

const PASS_COMMANDS: &[&str] = &[
    "init",
    "insert",
    "generate",
    "show",
    "ls",
    "find",
    "rm",
    "cp",
    "mv",
    "git",
    "seal",
    "import-kdbx",
    "export-kdbx",
    "backup",
    "attach",
    "otp",
    "update",
    "rotate",
    "history",
    "restore",
    "protect",
    "tomb",
    "open",
    "close",
];

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(args)
        .output()
        .expect("run the genuine CLI executable")
}

fn help(args: &[&str]) -> String {
    let output = run(args);
    assert!(output.status.success(), "{args:?}: {output:?}");
    assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
    let text = String::from_utf8(output.stdout).expect("help is UTF-8");
    assert!(text.contains("Usage:"), "{args:?}: {text}");
    text
}

#[test]
fn the_real_cli_renders_every_pass_command_and_attachment_help() {
    help(&["--help"]);
    help(&["vault", "--help"]);
    let canonical = help(&["vault", "pass", "--help"]);
    assert_eq!(canonical, help(&["pass", "--help"]));
    let mut last = 0;
    for name in PASS_COMMANDS {
        let marker = format!("  {name} ");
        let index = canonical
            .find(&marker)
            .expect("original command remains listed");
        assert!(index >= last, "original command order changed: {canonical}");
        last = index;
        help(&["vault", "pass", name, "--help"]);
    }
    for name in ["add", "get", "ls", "rm", "gc", "sync"] {
        help(&["pass", "attach", name, "--help"]);
    }
}

#[test]
fn missing_attachment_arguments_are_rejected_before_any_store_operation() {
    let directory = tempfile::tempdir().expect("isolated empty directory");
    let output = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass", "attach", "add", "--path"])
        .arg(directory.path())
        .current_dir(directory.path())
        .output()
        .expect("run the genuine CLI parser");
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    let error = String::from_utf8(output.stderr).expect("parse error is UTF-8");
    assert!(
        error.contains("<NAME>") && error.contains("<FILE>"),
        "{error}"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
