//! What the `vault circle` suites share: the committed fixture, a temp
//! directory holding its bundle, and the binary run with a clean environment.

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const FIXTURE: &str = include_str!("../../../../spec/conformance/quorum-recovery-fixture.json");

pub struct Circle {
    dir: tempfile::TempDir,
    pub fixture: serde_json::Value,
}

impl Circle {
    pub fn new() -> Self {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let circle = Self {
            dir: tempfile::tempdir().unwrap(),
            fixture,
        };
        std::fs::write(circle.bundle(), circle.fixture["bundle"].to_string()).unwrap();
        circle
    }

    pub fn bundle(&self) -> PathBuf {
        self.dir.path().join("bundle.json")
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// The mnemonics of these guardians, one per line.
    pub fn shares(&self, ids: &[&str]) -> String {
        let mut lines = String::new();
        for id in ids {
            let guardian = self.fixture["guardians"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["id"] == *id)
                .unwrap();
            lines.push_str(guardian["mnemonic"].as_str().unwrap());
            lines.push('\n');
        }
        lines
    }

    pub fn quorum(&self) -> Vec<&str> {
        self.fixture["quorum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect()
    }

    pub fn payload_text(&self) -> &str {
        self.fixture["payloadText"].as_str().unwrap()
    }

    /// Every mnemonic in the fixture, for the check that none is ever printed.
    pub fn leaks(&self, output: &Output) -> bool {
        let streams = [
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ];
        self.fixture["guardians"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["mnemonic"].as_str().unwrap())
            .any(|mnemonic| {
                let start: Vec<&str> = mnemonic.split(' ').take(4).collect();
                streams.iter().any(|s| s.contains(&start.join(" ")))
            })
    }
}

pub fn run(args: &[&str], stdin: Option<&str>) -> Output {
    run_with_env(args, stdin, &[])
}

pub fn run_with_env(args: &[&str], stdin: Option<&str>, env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env_clear()
        .envs(env.iter().copied())
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("opensesame runs");
    if let Some(text) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }
    child.wait_with_output().unwrap()
}

pub fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn path_str(path: &Path) -> &str {
    path.to_str().unwrap()
}
