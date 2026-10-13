//! The Node bridge that reads a schema is started with a `node` this crate
//! found itself and with a minimal environment: the process that runs
//! `parse_schema_file` may hold the store passphrase, and the bridge is not
//! who it is kept from only when it never sees it.
//!
//! `parse_schema_file` reads the process it runs in (`PATH`, the working
//! directory, the environment), so each test starts this very test binary
//! again as a subject (`subject` below) with exactly the process state it
//! wants, and reads what the subject printed and what the `node` it started
//! left behind. The `node` here is a shell script that records its
//! environment and answers with an empty document; one test also runs the real
//! Node when there is one.
#![cfg(unix)]

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};

use opensesame_env_spec::parse_schema_file;

/// Set in the subject process only: the schema it parses.
const SUBJECT_SCHEMA: &str = "OPENSESAME_TEST_SUBJECT_SCHEMA";
const PASSPHRASE: &str = "store-passphrase-for-tests";
/// Held while a script is written and while a subject is started. A process
/// forked on one thread while another has a script open for writing keeps that
/// descriptor until it execs, and running the script meanwhile fails with
/// `Text file busy`.
static WRITING_OR_FORKING: Mutex<()> = Mutex::new(());
const EMPTY_DOCUMENT: &str = r#"{"schema_path":"s","parser":"stand-in","items":[]}"#;

/// The subject: parses the schema the parent named and says how it went. A
/// plain run of this test file has no schema named and does nothing.
#[test]
fn subject() {
    let Some(schema) = std::env::var_os(SUBJECT_SCHEMA) else {
        return;
    };
    match parse_schema_file(Path::new(&schema)) {
        Ok(doc) => println!("SUBJECT ok items={}", doc.items.len()),
        Err(e) => println!("SUBJECT err {e}"),
    }
}

struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        for (dir, mode) in [
            ("work/bin", 0o700),
            ("safe", 0o700),
            ("unsafe", 0o777),
            ("out", 0o700),
        ] {
            let path = root.path().join(dir);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        std::fs::write(root.path().join("work/x.env.schema"), "# stand-in\n").unwrap();
        std::fs::write(root.path().join("work/parse.mjs"), "// stand-in\n").unwrap();
        Self { root }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    /// A `node` that records the environment it was started with in
    /// `out/<label>.env`, then answers as the bridge would.
    fn plant(&self, dir: &str, label: &str) {
        let script = format!(
            "#!/bin/sh\n/usr/bin/env > '{}'\nprintf '%s' '{EMPTY_DOCUMENT}'\n",
            self.path("out").join(format!("{label}.env")).display()
        );
        let node = self.path(dir).join("node");
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        std::fs::write(&node, script).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// What `label`'s `node` recorded, or `None` when it never ran.
    fn recorded(&self, label: &str) -> Option<String> {
        std::fs::read_to_string(self.path("out").join(format!("{label}.env"))).ok()
    }

    /// Starts the subject in `work/`, holding the passphrase and a spread of
    /// other variables, with `path` as its `PATH`. Returns what it printed.
    fn subject(&self, path: &str) -> String {
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "subject", "--nocapture", "--test-threads=1"])
            .env_clear()
            .current_dir(self.path("work"))
            .env("PATH", path)
            .env("HOME", "/home/dummy")
            .env("TMPDIR", "/tmp")
            .env("LANG", "C.UTF-8")
            .env("LC_ALL", "C")
            .env(SUBJECT_SCHEMA, self.path("work/x.env.schema"))
            .env("OPENSESAME_ENV_PARSE", self.path("work/parse.mjs"))
            .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE)
            .env("OPENSESAME_OPERATOR_TOKEN", "operator-token-for-tests")
            .env("NODE_PATH", "/nonexistent/modules")
            .env("NODE_OPTIONS", "--no-warnings")
            .env("npm_config_registry", "https://registry.invalid")
            .env("GITHUB_TOKEN", "ghp_dummy_marker_0123456789abcdef")
            .env("AWS_SECRET_ACCESS_KEY", "dummy-aws-secret")
            .env("DB_PASSWORD", "dummy-db-password")
            .env("SERVICE_API_KEY", "dummy-api-key")
            .env(
                "HTTPS_PROXY",
                "http://user:dummy-proxy-pass@proxy.invalid:3128",
            )
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        // libtest prints `test subject ... ` ahead of what the test printed.
        let said = stdout.lines().find_map(|line| {
            line.split_once("SUBJECT ")
                .map(|(_, said)| said.trim().to_owned())
        });
        said.unwrap_or_else(|| {
            panic!(
                "the subject did not report: {stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            )
        })
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

/// A `node` is planted where a bare `node` lookup would find it, ahead of the
/// only trusted one; it must never run, and the bridge must still parse.
fn planted_node_never_runs(path_template: &str, planted_in: &str) {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "trusted");
    sandbox.plant(planted_in, "planted");
    let path = path_template.replace("{safe}", &sandbox.path("safe").display().to_string());
    let path = path.replace("{unsafe}", &sandbox.path("unsafe").display().to_string());
    let said = sandbox.subject(&path);
    if let Some(seen) = sandbox.recorded("planted") {
        panic!(
            "a node planted in `{planted_in}` ran with PATH={path}, and saw:\n{seen}\n(subject: {said})"
        );
    }
    assert_eq!(said, "ok items=0", "PATH={path}");
    assert!(
        sandbox.recorded("trusted").is_some(),
        "the trusted node did not run (PATH={path})"
    );
}

#[test]
fn a_node_in_the_working_directory_behind_an_empty_path_entry_never_runs() {
    planted_node_never_runs(":{safe}", "work");
}

#[test]
fn a_node_in_the_working_directory_behind_a_dot_path_entry_never_runs() {
    planted_node_never_runs(".:{safe}", "work");
}

#[test]
fn a_node_behind_a_relative_path_entry_never_runs() {
    planted_node_never_runs("./bin:{safe}", "work/bin");
}

#[test]
fn a_node_in_a_directory_others_can_write_never_runs() {
    planted_node_never_runs("{unsafe}:{safe}", "unsafe");
}

#[test]
fn with_no_trusted_node_the_error_says_so_and_nothing_is_run() {
    let sandbox = Sandbox::new();
    sandbox.plant("work", "cwd");
    sandbox.plant("work/bin", "relative");
    sandbox.plant("unsafe", "unsafe");
    let path = format!(":./bin:.:{}:", sandbox.path("unsafe").display());
    let said = sandbox.subject(&path);
    for label in ["cwd", "relative", "unsafe"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the `{label}` node ran with PATH={path}, and saw:\n{seen}\n(subject: {said})");
        }
    }
    assert!(said.starts_with("err "), "expected an error, got: {said}");
    assert!(said.contains("no usable `node`"), "{said}");
}

#[test]
fn the_bridge_sees_only_the_allowlisted_environment() {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "trusted");
    let trusted = sandbox.path("safe").display().to_string();
    let unsafe_dir = sandbox.path("unsafe").display().to_string();
    let said = sandbox.subject(&format!(":./bin:{trusted}:/nonexistent:{unsafe_dir}"));
    assert_eq!(said, "ok items=0");
    let seen = sandbox.recorded("trusted").expect("the trusted node ran");
    let expected: BTreeSet<String> = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]
        .map(String::from)
        .into();
    assert_eq!(names(&seen), expected, "the bridge was handed:\n{seen}");
    // Values too: the passphrase appears nowhere, and PATH is the one trusted
    // directory, not what was inherited.
    for secret in [PASSPHRASE, "operator-token-for-tests", "dummy-proxy-pass"] {
        assert!(!seen.contains(secret), "the bridge saw {secret}:\n{seen}");
    }
    assert!(
        seen.lines().any(|line| line == format!("PATH={trusted}")),
        "{seen}"
    );
}

#[test]
fn a_real_node_still_parses_under_the_reduced_environment() {
    let Some(real) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("node"))
            .find(|node| dir_is_absolute_and_has(node))
    }) else {
        eprintln!("skip: no node on PATH");
        return;
    };
    let sandbox = Sandbox::new();
    std::os::unix::fs::symlink(&real, sandbox.path("safe").join("node")).unwrap();
    let dump = sandbox.path("out/real-node-env.json");
    std::fs::write(
        sandbox.path("work/parse.mjs"),
        format!(
            "import {{ writeFileSync }} from 'node:fs';\n\
             writeFileSync({dump:?}, JSON.stringify(Object.keys(process.env)));\n\
             process.stdout.write({EMPTY_DOCUMENT:?});\n",
            dump = dump.display().to_string()
        ),
    )
    .unwrap();
    let said = sandbox.subject(&format!(":./bin:{}", sandbox.path("safe").display()));
    assert_eq!(said, "ok items=0");
    let keys: BTreeSet<String> = serde_json::from_str(&std::fs::read_to_string(&dump).unwrap())
        .expect("the stand-in bridge wrote its environment's names");
    let allowed: BTreeSet<String> = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]
        .map(String::from)
        .into();
    assert_eq!(keys, allowed);
}

fn dir_is_absolute_and_has(node: &Path) -> bool {
    node.is_absolute() && node.is_file()
}
