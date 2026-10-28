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

fn fixture_github_token() -> String {
    "T".repeat(33)
}

struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for (name, mode) in [
            ("work/bin", 0o700),
            ("trusted", 0o700),
            ("open", 0o777),
            ("out", 0o700),
        ] {
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
        self.run_with(agent, path, &[])
    }

    /// [`Sandbox::run`] with more variables in the process that runs it.
    fn run_with(&self, agent: bool, path: &str, extra: &[(&str, String)]) -> Output {
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
            .env("GITHUB_TOKEN", fixture_github_token())
            .env(
                "HTTPS_PROXY",
                "http://user:dummy-proxy-pass@proxy.invalid:3128",
            );
        command.envs(extra.iter().map(|(name, value)| (name, value)));
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
        format!("GITHUB_TOKEN={}", fixture_github_token()),
        "HTTPS_PROXY=http://user:dummy-proxy-pass@proxy.invalid:3128".to_owned(),
        "API_URL=http://localhost:3000".to_owned(),
    ] {
        assert!(child.lines().any(|l| l == line), "missing {line}:\n{child}");
    }
}

/// A CI image's layout: the only `node` sits in an absolute directory this user
/// owns that its own group can write (`umask 002`, or a runner's tool cache).
#[test]
fn a_directory_its_own_group_can_write_supplies_the_node() {
    let sandbox = Sandbox::new();
    std::fs::set_permissions(
        sandbox.path("trusted"),
        std::fs::Permissions::from_mode(0o775),
    )
    .unwrap();
    sandbox.plant("trusted", "bridge");
    sandbox.plant("work", "in-cwd");
    let path = format!(":./bin:{}:/usr/bin:/bin", sandbox.path("trusted").display());
    let output = sandbox.run(true, &path);
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());
    assert!(sandbox.recorded("in-cwd").is_none());
}

/// `OPENSESAME_NODE` names the exact file, so it is used wherever it is, even
/// when no `PATH` entry could supply a `node`, and it is not forwarded to the
/// bridge.
#[test]
fn an_operator_named_node_is_used_in_a_directory_anyone_can_write() {
    let sandbox = Sandbox::new();
    sandbox.plant("open", "bridge");
    std::fs::set_permissions(
        sandbox.path("open/node"),
        std::fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let chosen = sandbox.path("open/node").display().to_string();
    let output = sandbox.run_with(
        true,
        ":./bin:.:/usr/bin:/bin",
        &[("OPENSESAME_NODE", chosen)],
    );
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(bridge_names(&sandbox), allowed());
}

#[test]
fn an_operator_named_node_wins_over_a_trusted_one_on_path() {
    let sandbox = Sandbox::new();
    sandbox.plant("trusted", "on-path");
    sandbox.plant("open", "bridge");
    let chosen = sandbox.path("open/node").display().to_string();
    let path = format!("{}:/usr/bin:/bin", sandbox.path("trusted").display());
    let output = sandbox.run_with(true, &path, &[("OPENSESAME_NODE", chosen)]);
    assert!(output.status.success(), "{}", said(&output));
    assert!(sandbox.recorded("on-path").is_none(), "PATH's node ran");
    assert_eq!(bridge_names(&sandbox), allowed());
}

#[test]
fn a_bad_operator_value_stops_the_run_by_name_and_never_falls_back_to_path() {
    for value in ["", "node", "./node", "/nonexistent/node"] {
        let sandbox = Sandbox::new();
        sandbox.plant("trusted", "on-path");
        let path = format!("{}:/usr/bin:/bin", sandbox.path("trusted").display());
        let output = sandbox.run_with(true, &path, &[("OPENSESAME_NODE", value.to_owned())]);
        let said = said(&output);
        assert!(!output.status.success(), "{value:?}: {said}");
        assert!(said.contains("OPENSESAME_NODE"), "{value:?}: {said}");
        assert!(
            sandbox.recorded("on-path").is_none(),
            "{value:?}: PATH's node ran after a bad OPENSESAME_NODE"
        );
        assert!(
            !sandbox.path("out/child.env").exists(),
            "{value:?}: the child ran"
        );
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
    let github_line = format!("GITHUB_TOKEN={}", fixture_github_token());
    for line in [
        "OPENSESAME_OPERATOR_TOKEN=operator-token-for-tests",
        github_line.as_str(),
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
