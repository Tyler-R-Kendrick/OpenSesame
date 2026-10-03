//! `opensesame dev run --agent` as a person runs it, with the surrogate-proxy
//! plugin installed and switched on (ADR 0150 §6.2, §6.3). The plugin is a
//! stand-in script pinned like the real one; the schema comes from a stand-in
//! env-spec parser; the sealed store is real.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use opensesame_plugin_settings::{sha256_file, PluginSettings};
use opensesame_sealed_store::{init_store, init_store_key, Entry, StoreRoot};

const BIN: &str = env!("CARGO_BIN_EXE_opensesame");
const SECRET: &str = "hunter2 & correct=horse";
const STORE_PASSWORD: &str = "store-passphrase-for-tests";

struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// A stand-in `@env-spec` parser that prints `items` as the document.
    fn schema(&self, items: &serde_json::Value) {
        let doc = serde_json::json!({
            "schema_path": "x.env.schema",
            "parser": "stand-in",
            "items": items,
        });
        let script = format!(
            "process.stdout.write({});\n",
            serde_json::to_string(&doc.to_string()).unwrap()
        );
        std::fs::write(self.path("parse.mjs"), script).unwrap();
        std::fs::write(self.path("x.env.schema"), "# stand-in\n").unwrap();
    }

    /// The plugin, installed from `script`, pinned and switched on.
    fn plugin(&self, script: &str) {
        let bin = self.path("opensesame-surrogate-proxy");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut settings = PluginSettings::default();
        let pin = sha256_file(&bin).unwrap();
        settings
            .record_install("surrogate-proxy", "0.1.0", &pin, bin.to_str().unwrap())
            .unwrap();
        settings.set_enabled("surrogate-proxy", true).unwrap();
        settings.save(&self.path("plugins.json")).unwrap();
    }

    /// A real sealed store holding the login at `Web/app`.
    fn store(&self) {
        let root = self.path("store");
        init_store(&root, &[]).unwrap();
        let key = init_store_key(&root, STORE_PASSWORD.as_bytes()).unwrap();
        StoreRoot::open(&root)
            .unwrap()
            .insert(
                "Web/app",
                &Entry {
                    secret: SECRET.into(),
                    trailer: "login: alice\nurl: https://app.example/login\n".into(),
                    otp: None,
                },
                &key,
            )
            .unwrap();
    }

    fn run(&self, child: &[&str]) -> (Output, Duration) {
        let started = Instant::now();
        let output = Command::new(BIN)
            .args(["dev", "--agent", "--schema"])
            .arg(self.path("x.env.schema"))
            .arg("run")
            .arg("--")
            .args(child)
            .env("OPENSESAME_PLUGINS_FILE", self.path("plugins.json"))
            .env("OPENSESAME_ENV_PARSE", self.path("parse.mjs"))
            .env("OPENSESAME_STORE_DIR", self.path("store"))
            .env("OPENSESAME_STORE_PASSWORD", STORE_PASSWORD)
            .env("OPENSESAME_TOMBS_CONFIG", self.path("tombs.json"))
            .env_remove("OPENSESAME_PLUGIN_SURROGATE_PROXY")
            .output()
            .unwrap();
        (output, started.elapsed())
    }
}

/// Every file under `dir`, read lossily, as `(path, text)`.
fn every_file(dir: &std::path::Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(every_file(&path));
        } else if let Ok(bytes) = std::fs::read(&path) {
            found.push((
                path.display().to_string(),
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
    }
    found
}

fn github_item() -> serde_json::Value {
    serde_json::json!({
        "key": "GITHUB_TOKEN",
        "sensitive": true,
        "required": true,
        "resolver": {
            "fn": "opensesameConnection",
            "args": [{"value": "conn://demo/github"}, {"key": "projection", "value": "legacy-token"}]
        }
    })
}

/// Answers the spec, then reports a misdirected surrogate — as the real
/// plugin does once it has revoked the run — and marks when its stdin closes.
const TRIPPING_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
IFS= read -r line
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"GITHUB_TOKEN":"osr_00000000000000000000000000000000"},"unserved":[]}'
sleep 0.5
printf '%s\n' '{"event":"tripwire","run_id":"r","fence":"surrogate.misdirected","verdict":"park","revoked":1}'
cat > /dev/null
: > "$here/ended"
"#;

#[test]
fn a_misdirected_surrogate_stops_the_run_and_the_cli_exits_non_zero() {
    let sandbox = Sandbox::new();
    sandbox.schema(&serde_json::json!([github_item()]));
    sandbox.plugin(TRIPPING_PLUGIN);
    let (output, took) = sandbox.run(&["sleep", "30"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(77), "{stderr}");
    assert!(
        took < Duration::from_secs(15),
        "the child was stopped: {took:?}"
    );
    assert!(stderr.contains("surrogate.misdirected"), "{stderr}");
    assert!(stderr.contains("revoked"), "{stderr}");
    assert!(!stderr.contains("osr_"), "{stderr}");
    assert!(sandbox.path("ended").exists(), "the plugin's run was ended");
}

/// Records the spec it was sent (a test-only copy; the real plugin writes
/// it nowhere), and how many arguments it was started with.
const LOGIN_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
printf '%s' "$#" > "$here/argc"
IFS= read -r line
printf '%s\n' "$line" > "$here/spec.json"
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"APP_PASSWORD":"osr_11111111111111111111111111111111"},"unserved":[]}'
cat > /dev/null
: > "$here/ended"
"#;

#[test]
fn a_web_login_is_read_from_the_store_by_the_cli_and_the_child_only_holds_a_surrogate() {
    let sandbox = Sandbox::new();
    sandbox.store();
    sandbox.schema(&serde_json::json!([{
        "key": "APP_PASSWORD",
        "sensitive": true,
        "required": true,
        "resolver": {
            "fn": "opensesameLogin",
            "args": [
                {"value": "Web/app"},
                {"key": "origin", "value": "https://app.example"},
                {"key": "action", "value": "/session"},
                {"key": "field", "value": "password"}
            ]
        }
    }]));
    sandbox.plugin(LOGIN_PLUGIN);
    let dump = sandbox.path("child.env");
    let (output, _) = sandbox.run(&["sh", "-c", &format!("env > '{}'", dump.display())]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");

    // The plugin got the password in its run spec, over its stdin, and no
    // argument at all.
    let spec: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(sandbox.path("spec.json")).unwrap()).unwrap();
    assert_eq!(spec["logins"][0]["secret"], SECRET);
    assert_eq!(spec["logins"][0]["env_var"], "APP_PASSWORD");
    assert_eq!(std::fs::read_to_string(sandbox.path("argc")).unwrap(), "0");

    // The child got the surrogate, never the password, and not the key to
    // the store either.
    let child_env = std::fs::read_to_string(&dump).unwrap();
    assert!(
        child_env.contains("APP_PASSWORD=osr_11111111111111111111111111111111"),
        "{child_env}"
    );
    assert!(!child_env.contains("hunter2"), "{child_env}");
    assert!(
        !child_env.contains("OPENSESAME_STORE_PASSWORD"),
        "{child_env}"
    );
    assert!(!child_env.contains(STORE_PASSWORD), "{child_env}");
    for said in [&stdout, &stderr] {
        assert!(!said.contains("hunter2"), "{said}");
    }
    assert!(sandbox.path("ended").exists());

    // Nothing the run left on disk carries it. The store is ciphertext, and
    // `spec.json` is the stand-in plugin's own copy of the line it was sent —
    // the one file that may, because the real plugin writes it nowhere.
    for (path, text) in every_file(sandbox.dir.path()) {
        if !path.ends_with("spec.json") {
            assert!(!text.contains("hunter2"), "{path} carries the password");
        }
    }
}

#[test]
fn with_the_plugin_off_a_web_login_delivers_nothing_and_reads_no_password() {
    let sandbox = Sandbox::new();
    sandbox.schema(&serde_json::json!([{
        "key": "APP_PASSWORD",
        "sensitive": true,
        "required": true,
        "resolver": {
            "fn": "opensesameLogin",
            "args": [
                {"value": "Web/app"},
                {"key": "origin", "value": "https://app.example"},
                {"key": "action", "value": "/session"},
                {"key": "field", "value": "password"}
            ]
        }
    }]));
    // No store exists: a run that tried to read one would fail.
    let dump = sandbox.path("child.env");
    let (output, _) = sandbox.run(&["sh", "-c", &format!("env > '{}'", dump.display())]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(
        stderr.contains("APP_PASSWORD delivered nothing"),
        "{stderr}"
    );
    let child_env = std::fs::read_to_string(&dump).unwrap();
    assert!(!child_env.contains("APP_PASSWORD="), "{child_env}");
}
