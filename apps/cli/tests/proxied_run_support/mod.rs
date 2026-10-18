//! Harness for `proxied_run_e2e.rs`: a hermetic home, the real `opensesame`
//! binary, the TEST build of the surrogate-proxy plugin installed through
//! `opensesame plugins install` with its sha256 pin, a sealed store written by
//! `opensesame pass`, and an agent child that goes through the run's proxy.
//!
//! Nothing here reads the developer's own configuration: every call runs with
//! a cleared environment and a home inside the sandbox. A shipped build of
//! `opensesame` honours no variable for the plugin settings path, so the
//! sandbox moves it with `HOME` and `XDG_*`, exactly as a person's would be.

#![allow(dead_code)] // each test uses a different subset

pub mod common;
pub mod live;
pub mod run;
pub mod sweep;
pub mod upstream;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use opensesame_plugin_settings::sha256_file;
use serde_json::Value;

pub const BIN: &str = env!("CARGO_BIN_EXE_opensesame");
/// The test build of the plugin (`--features upstream-override`), built and
/// named by `scripts/test/proxied-run-test.sh`.
pub const PLUGIN_ENV: &str = "OPENSESAME_E2E_PLUGIN_BIN";
/// An `@env-spec/parser` bridge that can resolve its module; unset, the
/// repository's own `packages/env-spec-bridge` is used.
pub const PARSER_ENV: &str = "OPENSESAME_E2E_ENV_PARSE";

pub const HOST: &str = "api.vercel.com";
pub const CONNECTION_ENTRY: &str = "connections/acme/vercel";
pub const STORE_PASSPHRASE: &str = "store-passphrase-for-tests";
/// What a refused child is told, whatever fence it hit.
pub const GENERIC_REFUSAL: &str = "request refused by the credential broker";
pub const SCOPED_LINE: &str = "VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, \
     projection=legacy-token, paths=\"/v2/user\", methods=\"GET\")";

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

pub struct Sandbox {
    pub root: tempfile::TempDir,
    /// This sandbox's dummy token; no other sandbox shares it.
    pub token: String,
    plugin: PathBuf,
    parser: Option<PathBuf>,
    /// Where `plugins install` put the plugin.
    installed: Mutex<Option<PathBuf>>,
    /// Everything every command printed, for the "no log line" sweep.
    transcript: Mutex<Vec<String>>,
}

impl Sandbox {
    pub fn new() -> Self {
        let plugin = std::env::var_os(PLUGIN_ENV).map_or_else(
            || {
                panic!(
                    "{PLUGIN_ENV} names the test build of the plugin; \
                     scripts/test/proxied-run-test.sh builds it and sets it"
                )
            },
            PathBuf::from,
        );
        let root = tempfile::tempdir().unwrap();
        for dir in ["home", "work", "out"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Self {
            root,
            token: format!("vtok_dummy_marker_{:08x}{sequence:08x}", std::process::id()),
            plugin,
            parser: std::env::var_os(PARSER_ENV).map(PathBuf::from),
            installed: Mutex::new(None),
            transcript: Mutex::new(Vec::new()),
        }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    pub fn store(&self) -> PathBuf {
        self.path("store")
    }

    /// `opensesame`, as a person's shell would start it, in the sandbox.
    pub fn command(&self) -> Command {
        let home = self.path("home");
        let mut command = Command::new(BIN);
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_STATE_HOME", home.join(".local/state"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("OPENSESAME_STORE_DIR", self.store())
            .env("OPENSESAME_TOMBS_CONFIG", self.path("tombs.json"))
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .current_dir(self.path("work"))
            .stdin(Stdio::null());
        if let Some(parser) = &self.parser {
            command.env("OPENSESAME_ENV_PARSE", parser);
        }
        // The environment is cleared on purpose; the operator's choice of
        // `node` (a CI image's own sits where PATH is not trusted) is not part
        // of what is being kept out.
        if let Some(node) = std::env::var_os("OPENSESAME_NODE") {
            command.env("OPENSESAME_NODE", node);
        }
        // A person's terminal starts `opensesame` with the default action for
        // every signal. A test launched from a background job or under `nohup`
        // would hand it ignored ones, which an exec keeps: put them back.
        // SAFETY: only `signal`, which is async-signal-safe, runs between the
        // fork and the exec.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(&mut command, || {
                for signal in [libc::SIGINT, libc::SIGQUIT, libc::SIGHUP, libc::SIGTERM] {
                    libc::signal(signal, libc::SIG_DFL);
                }
                Ok(())
            });
        }
        command
    }

    /// Remember what `output` printed, under `label`.
    pub fn keep(&self, label: &str, output: &Output) {
        let text = format!(
            "{label}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        self.transcript.lock().unwrap().push(text);
    }

    /// Run `opensesame args…` to completion, kept in the transcript.
    pub fn cli(&self, args: &[&str]) -> Output {
        let output = self.command().args(args).output().unwrap();
        self.keep(&args.join(" "), &output);
        output
    }

    /// [`Sandbox::cli`] that must succeed; its stdout as JSON, or `Null`.
    pub fn cli_ok(&self, args: &[&str]) -> Value {
        let output = self.cli(args);
        assert!(
            output.status.success(),
            "opensesame {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
    }

    /// Install the plugin through the real path, pinned by the sha256 of the
    /// file, then switch it on. Returns where it was installed.
    pub fn install_plugin(&self) -> PathBuf {
        self.install_plugin_from(&self.plugin)
    }

    /// [`Sandbox::install_plugin`] for any executable, such as a stand-in
    /// plugin that answers slowly.
    pub fn install_plugin_from(&self, plugin: &Path) -> PathBuf {
        let pin = sha256_file(plugin).unwrap();
        let from = plugin.display().to_string();
        let installed = self.cli_ok(&[
            "plugins",
            "install",
            "surrogate-proxy",
            "--from",
            &from,
            "--sha256",
            &pin,
            "--version",
            "0.1.0",
        ]);
        assert_eq!(installed["installed"], "surrogate-proxy", "{installed}");
        assert_eq!(installed["verified_by"], "sha256", "{installed}");
        assert_eq!(installed["enabled"], false, "recorded off: {installed}");
        let state = self.cli_ok(&["plugins", "enable", "surrogate-proxy"]);
        assert_eq!(state["active"], true, "{state}");
        let location = PathBuf::from(installed["location"].as_str().unwrap());
        *self.installed.lock().unwrap() = Some(location.clone());
        location
    }

    /// Where the plugin was installed by [`Sandbox::install_plugin`].
    pub fn installed_plugin(&self) -> PathBuf {
        self.installed
            .lock()
            .unwrap()
            .clone()
            .expect("the plugin was installed")
    }

    /// `opensesame pass init`, unlocked non-interactively.
    pub fn init_store(&self) {
        let store = self.store().display().to_string();
        let output = self
            .command()
            .args(["pass", "init", "--path", &store])
            .env("OPENSESAME_STORE_PASSWORD", STORE_PASSPHRASE)
            .output()
            .unwrap();
        self.keep("pass init", &output);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// `opensesame pass insert <name>` with `secret` on stdin, as a pipe
    /// does it. The secret is never an argument.
    pub fn seal(&self, name: &str, secret: &str) {
        let mut child = self
            .command()
            .args(["pass", "insert", name])
            .env("OPENSESAME_STORE_PASSWORD", STORE_PASSPHRASE)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(child.stdin.take().unwrap(), "{secret}").unwrap();
        let output = child.wait_with_output().unwrap();
        self.keep(&format!("pass insert {name}"), &output);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// `.env.schema` in the working directory, one sensitive entry.
    pub fn write_schema(&self, line: &str) {
        let schema =
            format!("# @defaultSensitive=false\n# ---\n\n# @required @sensitive\n{line}\n");
        std::fs::write(self.path("work").join(".env.schema"), schema).unwrap();
    }

    /// The plugin's recorded notices, newest first.
    pub fn notices(&self) -> Vec<Value> {
        let listed = self.cli_ok(&["plugins", "notices", "surrogate-proxy"]);
        listed["notices"].as_array().cloned().unwrap_or_default()
    }

    /// Everything any command printed, joined.
    pub fn printed(&self) -> String {
        self.transcript.lock().unwrap().join("\n")
    }

    /// The directories of runs the plugin has not cleaned up: each live run
    /// has one (its CA file) and removes it when it ends.
    pub fn run_dirs(&self) -> Vec<PathBuf> {
        let Some(state) = find_dir(&self.path("home"), "plugin-state") else {
            return Vec::new();
        };
        std::fs::read_dir(state.join("surrogate-proxy/runs"))
            .map(|runs| runs.flatten().map(|run| run.path()).collect())
            .unwrap_or_default()
    }

    /// Whether `needle` is in anything printed or in any file under the
    /// sandbox (the sealed store included: ciphertext must not hold it).
    pub fn leaks(&self, needle: &str) -> Vec<String> {
        let mut leaks = Vec::new();
        if self.printed().contains(needle) {
            leaks.push("a command's output".to_owned());
        }
        leaks.extend(
            sweep::files_naming(self.root.path(), needle)
                .iter()
                .map(|path| path.display().to_string()),
        );
        leaks
    }
}

/// The first directory called `name` under `root`, breadth unspecified.
fn find_dir(root: &Path, name: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            if entry.file_name() == name {
                return Some(entry.path());
            }
            if entry.path().is_dir() {
                pending.push(entry.path());
            }
        }
    }
    None
}

/// The path of a file as the sandbox's child will see it.
pub fn display(path: &Path) -> String {
    path.display().to_string()
}
