//! No-arg `opensesame` is an interactive session. A first run with no CLI
//! state folder runs the setup ceremony (ADR 0154) before the prompt.
//!
//! The state directory is `OPENSESAME_CLI_STATE`, not the working directory:
//! this repo's `.opensesame/` marketplace index must not count as a previous run.

use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn run(state: &Path, args: &[&str], stdin_text: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .env_clear()
        .env("OPENSESAME_CLI_STATE", state)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("opensesame spawns");
    {
        let mut stdin = child.stdin.take().expect("stdin");
        stdin.write_all(stdin_text.as_bytes()).expect("write stdin");
    }
    child.wait_with_output().expect("opensesame exits")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn has_line(output: &Output, line: &str) -> bool {
    stdout(output).lines().any(|item| item == line)
}

fn offers_choices(output: &Output) -> bool {
    has_line(output, "Minimal") && has_line(output, "Default") && has_line(output, "Custom")
}

fn plan(state: &Path) -> serde_json::Value {
    let raw =
        fs::read_to_string(state.join(".opensesame").join("plan.json")).expect("plan recorded");
    serde_json::from_str(&raw).expect("plan json")
}

fn verb_line(output: &Output) -> String {
    stdout(output)
        .lines()
        .find(|line| line.contains("\"format\":\"env-spec\""))
        .unwrap_or("")
        .to_string()
}

#[test]
fn no_arg_minimal_then_a_second_start_runs_the_verb() {
    let state = tempfile::tempdir().unwrap();
    let first = run(state.path(), &[], "Minimal\nconfig-files\nexit\n");
    assert!(
        first.status.success(),
        "first start failed\nstdout:\n{}\nstderr:\n{}",
        stdout(&first),
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        offers_choices(&first),
        "choices missing:\n{}",
        stdout(&first)
    );
    assert_eq!(plan(state.path())["plan"], "minimal");
    assert_eq!(plan(state.path())["optional"], serde_json::json!([]));

    let once = run(state.path(), &["config-files"], "");
    let second = run(state.path(), &[], "config-files\nexit\n");
    assert!(second.status.success(), "second start failed");
    assert!(
        !offers_choices(&second),
        "ceremony ran again:\n{}",
        stdout(&second)
    );
    assert_eq!(verb_line(&second), stdout(&once).trim());
}

#[test]
fn skip_records_skip_and_a_later_start_is_ordinary() {
    let state = tempfile::tempdir().unwrap();
    let first = run(state.path(), &[], "Skip\nexit\n");
    assert!(first.status.success(), "skip failed\n{}", stdout(&first));
    assert!(offers_choices(&first));
    assert_eq!(plan(state.path())["plan"], "skip");
    assert_ne!(plan(state.path())["plan"], "minimal");

    let second = run(state.path(), &[], "config-files\nexit\n");
    assert!(
        !offers_choices(&second),
        "ceremony ran again:\n{}",
        stdout(&second)
    );
    let once = run(state.path(), &["config-files"], "");
    assert_eq!(verb_line(&second), stdout(&once).trim());
}

#[test]
fn an_argv_verb_does_not_open_the_session_or_the_ceremony() {
    let state = tempfile::tempdir().unwrap();
    let output = run(state.path(), &["config-files"], "Minimal\nexit\n");
    assert!(output.status.success(), "verb failed\n{}", stdout(&output));
    assert!(
        !offers_choices(&output),
        "ceremony opened:\n{}",
        stdout(&output)
    );
    assert!(!stdout(&output).contains("opensesame>"), "session opened");
    assert!(!state.path().join(".opensesame").exists());
}

#[test]
fn default_selects_the_default_extensions() {
    let state = tempfile::tempdir().unwrap();
    let output = run(state.path(), &[], "Default\nexit\n");
    assert!(
        output.status.success(),
        "default failed\n{}",
        stdout(&output)
    );
    assert!(offers_choices(&output));
    let recorded = plan(state.path());
    assert_eq!(recorded["plan"], "default");
    let optional = recorded["optional"]
        .as_array()
        .expect("optional list")
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    for id in [
        "access.authority",
        "connectors.external",
        "identity.federation",
        "identity.local-iam",
        "identity.siop",
        "vault.certificate-records",
        "vault.derived-records",
        "vault.passkey-records",
    ] {
        assert!(optional.iter().any(|item| item == id), "missing {id}");
    }
}

#[test]
fn custom_opens_the_ceremony_minimal_road() {
    let state = tempfile::tempdir().unwrap();
    let output = run(
        state.path(),
        &[],
        "Custom\nUse the minimal configuration\nfinish\nexit\n",
    );
    assert!(
        output.status.success(),
        "custom failed\n{}",
        stdout(&output)
    );
    assert!(offers_choices(&output));
    assert!(
        has_line(&output, "Use the minimal configuration"),
        "minimal road missing:\n{}",
        stdout(&output)
    );
    let recorded = plan(state.path());
    assert_eq!(recorded["plan"], "custom");
    assert_eq!(recorded["road"], "minimal");
    assert_ne!(recorded["plan"], "minimal");

    let second = run(state.path(), &[], "exit\n");
    assert!(!offers_choices(&second));
}

#[test]
fn custom_customize_records_chosen_capability_ids() {
    let state = tempfile::tempdir().unwrap();
    let output = run(
        state.path(),
        &[],
        "Custom\nCustomize this installation\nidentity.ambient-sso\nwallet.spending\nfinish\nexit\n",
    );
    assert!(
        output.status.success(),
        "customize failed\nstdout:\n{}\nstderr:\n{}",
        stdout(&output),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(offers_choices(&output));
    assert!(
        has_line(&output, "Customize this installation"),
        "customize road missing:\n{}",
        stdout(&output)
    );
    assert!(has_line(&output, "Use the minimal configuration"));
    assert!(
        has_line(&output, "identity.ambient-sso"),
        "capability cards missing:\n{}",
        stdout(&output)
    );
    assert!(has_line(&output, "wallet.spending"));
    let recorded = plan(state.path());
    assert_eq!(recorded["plan"], "custom");
    assert_ne!(recorded["plan"], "minimal");
    assert_eq!(recorded["road"], "customize");
    assert_eq!(
        recorded["optional"],
        serde_json::json!(["identity.ambient-sso", "wallet.spending"])
    );

    let second = run(state.path(), &[], "exit\n");
    assert!(
        !offers_choices(&second),
        "ceremony ran again:\n{}",
        stdout(&second)
    );
}

#[test]
fn session_verb_is_listed_and_runs_the_same_entry() {
    let state = tempfile::tempdir().unwrap();
    let help = run(state.path(), &["--help"], "");
    assert!(help.status.success(), "help failed\n{}", stdout(&help));
    assert!(
        stdout(&help)
            .lines()
            .any(|line| line.split_whitespace().next() == Some("session")),
        "session missing from help:\n{}",
        stdout(&help)
    );
    let session_help = run(state.path(), &["session", "--help"], "");
    assert!(
        session_help.status.success(),
        "session --help failed\nstderr:\n{}",
        String::from_utf8_lossy(&session_help.stderr)
    );
    assert!(!state.path().join(".opensesame").exists());

    let first = run(state.path(), &["session"], "Minimal\nexit\n");
    assert!(
        first.status.success(),
        "session verb failed\nstderr:\n{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        offers_choices(&first),
        "choices missing:\n{}",
        stdout(&first)
    );
    assert_eq!(plan(state.path())["plan"], "minimal");

    let once = run(state.path(), &["config-files"], "");
    let second = run(state.path(), &["session"], "config-files\nexit\n");
    assert!(
        !offers_choices(&second),
        "ceremony ran again:\n{}",
        stdout(&second)
    );
    assert_eq!(verb_line(&second), stdout(&once).trim());
}

fn command_names(output: &Output) -> Vec<String> {
    stdout(output)
        .lines()
        .skip_while(|line| !line.starts_with("Commands:"))
        .skip(1)
        .take_while(|line| line.starts_with("  "))
        .filter_map(|line| line.split_whitespace().next().map(str::to_string))
        .collect()
}

#[test]
fn product_commands_match_the_app_and_old_verbs_still_parse() {
    let state = tempfile::tempdir().unwrap();
    let help = run(state.path(), &["--help"], "");
    assert!(
        help.status.success(),
        "help failed\n{}",
        String::from_utf8_lossy(&help.stderr)
    );
    let names = command_names(&help);
    for verb in ["vault", "access", "identity", "login", "logout", "session"] {
        assert!(
            names.iter().any(|name| name == verb),
            "{verb} missing from {names:?}"
        );
    }
    for verb in [
        "pass",
        "connect",
        "status",
        "whoami",
        "invoke",
        "provider",
        "secret",
        "sync",
        "crypto",
        "task",
        "lease",
        "cert",
        "lifecycle",
    ] {
        assert!(
            names.iter().all(|name| name != verb),
            "{verb} is still top-level: {names:?}"
        );
    }

    let access = command_names(&run(state.path(), &["access", "--help"], ""));
    for verb in ["grants", "sessions", "connectors", "resources"] {
        assert!(
            access.iter().any(|name| name == verb),
            "{verb} missing from {access:?}"
        );
    }
    let identity = command_names(&run(state.path(), &["identity", "--help"], ""));
    for verb in ["status", "whoami", "auth", "providers"] {
        assert!(
            identity.iter().any(|name| name == verb),
            "{verb} missing from {identity:?}"
        );
    }
    let vault = command_names(&run(state.path(), &["vault", "--help"], ""));
    for verb in [
        "verify", "ls", "inspect", "migrate", "pass", "secret", "sync", "crypto",
    ] {
        assert!(
            vault.iter().any(|name| name == verb),
            "{verb} missing from {vault:?}"
        );
    }

    let legacy = run(state.path(), &["--output", "json", "pass", "--help"], "");
    assert!(
        legacy.status.success(),
        "legacy pass help failed\n{}",
        String::from_utf8_lossy(&legacy.stderr)
    );
    let pass = command_names(&legacy);
    assert!(
        pass.iter().any(|name| name == "show"),
        "pass show missing from {pass:?}"
    );
    assert!(run(state.path(), &["connect", "--help"], "")
        .status
        .success());
    assert!(!state.path().join(".opensesame").exists());
}
