//! `opensesame dev run` reads the schema through the Node bridge, in the
//! process that may hold the store passphrase. The bridge gets a `node` that
//! only absolute, trusted `PATH` entries can supply and a minimal environment;
//! the child that finally runs gets what it always got.
//!
//! The `node` here is a shell script that records its environment and answers
//! with a one-item document, so the test needs no Node and no parser package.
#![cfg(unix)]

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Mutex, PoisonError};

const BIN: &str = env!("CARGO_BIN_EXE_opensesame");
const PASSPHRASE: &str = "store-passphrase-for-tests";
const DOCUMENT: &str = r#"{"schema_path":"s","parser":"stand-in","items":[{"key":"API_URL","sensitive":false,"required":false,"public":true,"value":"http://localhost:3000","resolver":null,"decorators":[]}]}"#;

/// Held while a script is written and while a run is started: a process forked
/// on one thread while another has a script open for writing keeps that
/// descriptor until it execs, and running the script meanwhile fails with
/// `Text file busy`.
static WRITING_OR_FORKING: Mutex<()> = Mutex::new(());

struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for (name, mode) in [("work/bin", 0o700), ("trusted", 0o700), ("out", 0o700)] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        std::fs::write(dir.path().join("work/x.env.schema"), "# stand-in\n").unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// A `node` in `dir` that writes its environment to `out/<label>.env`.
    fn plant(&self, dir: &str, label: &str) {
        let script = format!(
            "#!/bin/sh\n/usr/bin/env > '{}'\nprintf '%s' '{DOCUMENT}'\n",
            self.path("out").join(format!("{label}.env")).display()
        );
        let node = self.path(dir).join("node");
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        std::fs::write(&node, script).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn recorded(&self, label: &str) -> Option<String> {
        std::fs::read_to_string(self.path("out").join(format!("{label}.env"))).ok()
    }

    /// `dev [--agent] run -- sh -c 'env > out/child.env'`, in `work/`, from a
    /// process that holds the passphrase and a spread of other secrets, with
    /// `path` as its `PATH`.
    fn run(&self, agent: bool, path: &str) -> Output {
        let mut command = Command::new(BIN);
        command.arg("dev");
        if agent {
            command.arg("--agent");
        }
        command
            .arg("--schema")
            .arg(self.path("work/x.env.schema"))
            .args(["run", "--", "sh", "-c", "env > \"$1\"", "sh"])
            .arg(self.path("out/child.env"))
            .env_clear()
            .current_dir(self.path("work"))
            .env("PATH", path)
            .env("HOME", self.path("home"))
            .env("LANG", "C.UTF-8")
            .env("OPENSESAME_ENV_PARSE", self.path("work/parse.mjs"))
            .env("OPENSESAME_PLUGINS_FILE", self.path("plugins.json"))
            .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE)
            .env("OPENSESAME_OPERATOR_TOKEN", "operator-token-for-tests")
            .env("NODE_PATH", "/nonexistent/modules")
            .env("GITHUB_TOKEN", "ghp_dummy_marker_0123456789abcdef")
            .env(
                "HTTPS_PROXY",
                "http://user:dummy-proxy-pass@proxy.invalid:3128",
            );
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        command.output().unwrap()
    }
}

fn names(recorded: &str) -> BTreeSet<String> {
    // The shell the recording `node` runs under adds a few of its own.
    const SHELL_OWN: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];
    recorded
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name.to_owned()))
        .filter(|name| !SHELL_OWN.contains(&name.as_str()))
        .collect()
}

fn said(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// The bridge's whole environment, as `names` reads it.
fn bridge_names(sandbox: &Sandbox) -> BTreeSet<String> {
    let seen = sandbox.recorded("bridge").expect("the trusted node ran");
    assert!(!seen.contains(PASSPHRASE), "the bridge saw:\n{seen}");
    names(&seen)
}

fn allowed() -> BTreeSet<String> {
    ["HOME", "LANG", "PATH"].map(String::from).into()
}

#[test]
fn the_bridge_gets_a_minimal_environment_and_the_child_gets_what_it_always_got() {
    let sandbox = Sandbox::new();
    sandbox.plant("trusted", "bridge");
    let trusted = sandbox.path("trusted").display().to_string();
    let path = format!("{trusted}:/usr/bin:/bin");
    let output = sandbox.run(false, &path);
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());

    let child = std::fs::read_to_string(sandbox.path("out/child.env")).unwrap();
    for line in [
        format!("PATH={path}"),
        format!("OPENSESAME_STORE_PASSWORD={PASSPHRASE}"),
        "OPENSESAME_OPERATOR_TOKEN=operator-token-for-tests".to_owned(),
        "NODE_PATH=/nonexistent/modules".to_owned(),
        "GITHUB_TOKEN=ghp_dummy_marker_0123456789abcdef".to_owned(),
        "HTTPS_PROXY=http://user:dummy-proxy-pass@proxy.invalid:3128".to_owned(),
        "API_URL=http://localhost:3000".to_owned(),
    ] {
        assert!(child.lines().any(|l| l == line), "missing {line}:\n{child}");
    }
}

#[test]
fn an_agent_child_loses_only_the_store_passphrase_as_before() {
    let sandbox = Sandbox::new();
    sandbox.plant("trusted", "bridge");
    let path = format!("{}:/usr/bin:/bin", sandbox.path("trusted").display());
    let output = sandbox.run(true, &path);
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());

    let child = std::fs::read_to_string(sandbox.path("out/child.env")).unwrap();
    assert!(!child.contains("OPENSESAME_STORE_PASSWORD"), "{child}");
    assert!(!child.contains(PASSPHRASE), "{child}");
    for line in [
        "OPENSESAME_OPERATOR_TOKEN=operator-token-for-tests",
        "GITHUB_TOKEN=ghp_dummy_marker_0123456789abcdef",
        "NODE_PATH=/nonexistent/modules",
        "API_URL=http://localhost:3000",
    ] {
        assert!(child.lines().any(|l| l == line), "missing {line}:\n{child}");
    }
}

#[test]
fn a_node_planted_where_an_empty_or_relative_path_entry_points_never_runs() {
    let sandbox = Sandbox::new();
    sandbox.plant("trusted", "bridge");
    sandbox.plant("work", "in-cwd");
    sandbox.plant("work/bin", "relative");
    let path = format!(
        ":./bin:.:{}:/usr/bin:/bin",
        sandbox.path("trusted").display()
    );
    let output = sandbox.run(true, &path);
    assert!(output.status.success(), "{}", said(&output));
    for label in ["in-cwd", "relative"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the node planted as `{label}` ran, and saw:\n{seen}");
        }
    }
    assert_eq!(bridge_names(&sandbox), allowed());
}

#[test]
fn with_no_trusted_node_the_run_stops_before_the_child_and_says_so() {
    let sandbox = Sandbox::new();
    sandbox.plant("work", "in-cwd");
    sandbox.plant("work/bin", "relative");
    let output = sandbox.run(true, ":./bin:.:/nonexistent:");
    let said = said(&output);
    assert!(!output.status.success(), "{said}");
    assert!(said.contains("env-spec parse failed"), "{said}");
    assert!(said.contains("no usable `node`"), "{said}");
    for label in ["in-cwd", "relative"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the node planted as `{label}` ran, and saw:\n{seen}");
        }
    }
    assert!(
        !sandbox.path("out/child.env").exists(),
        "the child ran without a schema"
    );
}
