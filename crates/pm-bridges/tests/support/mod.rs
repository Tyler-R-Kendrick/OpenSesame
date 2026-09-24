//! Shared harness for the golden protocol tests.
//!
//! Each test drives a real bridge binary as a subprocess over a tempdir
//! store, exactly as a browser would: length-prefixed JSON in, length-prefixed
//! JSON out, stdin closed to end the conversation. Nothing here touches the
//! network or a real profile directory.

#![allow(dead_code)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

/// Encode a JSON value as a native-messaging frame.
pub fn frame(value: &Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(value).expect("serialize request");
    opensesame_pm_bridges::framing::encode_frame(&bytes).expect("fixture request fits frame cap")
}

/// Split a native-messaging stream into JSON values.
pub fn unframe(mut raw: &[u8]) -> Vec<Value> {
    let mut out = Vec::new();
    while raw.len() >= 4 {
        let len = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        assert!(raw.len() >= 4 + len, "truncated response frame");
        out.push(serde_json::from_slice(&raw[4..4 + len]).expect("parse response"));
        raw = &raw[4 + len..];
    }
    assert!(raw.is_empty(), "trailing bytes after the last frame");
    out
}

/// A fixture store plus the config dir the bridges should use.
pub struct Fixture {
    pub store: tempfile::TempDir,
    pub config: tempfile::TempDir,
}

impl Fixture {
    pub fn new() -> Self {
        let store = tempfile::tempdir().expect("store tempdir");
        opensesame_pm_bridges::testing::init_store_fixture(store.path());
        Self {
            store,
            config: tempfile::tempdir().expect("config tempdir"),
        }
    }

    pub fn store_path(&self) -> &Path {
        self.store.path()
    }

    /// Environment every bridge subprocess runs under.
    pub fn envs(&self) -> Vec<(&'static str, String)> {
        vec![
            (
                "OPENSESAME_STORE_PASSWORD",
                String::from_utf8(opensesame_pm_bridges::testing::FIXTURE_PASSPHRASE.to_vec())
                    .unwrap(),
            ),
            (
                "OPENSESAME_BRIDGE_STORE_DIR",
                self.store.path().to_string_lossy().to_string(),
            ),
            (
                "OPENSESAME_BRIDGES_DIR",
                self.config.path().to_string_lossy().to_string(),
            ),
        ]
    }
}

/// What a bridge subprocess said.
pub struct Run {
    pub responses: Vec<Value>,
    pub status: std::process::ExitStatus,
    pub stderr: String,
}

/// Run `bin` with `requests`, closing stdin afterwards.
pub fn run_host(bin: &str, fixture: &Fixture, requests: &[Value]) -> Run {
    let mut command = Command::new(bin);
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", fixture.config.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in fixture.envs() {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn bridge");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for request in requests {
            stdin.write_all(&frame(request)).expect("write request");
        }
        stdin.flush().expect("flush");
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait for bridge");
    Run {
        responses: unframe(&output.stdout),
        status: output.status,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}
