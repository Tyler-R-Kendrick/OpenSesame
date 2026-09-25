//! A driver for the official Bitwarden CLI, the oracle.
//!
//! `OPENSESAME_BW_CLI` names the `bw` binary (`pnpm test:bitwarden-oracle`
//! installs a pinned `@bitwarden/cli` and sets it). Each `Bw` has its own
//! data directory, trusts only the harness's test CA, and bypasses any proxy
//! so it talks to the loopback server and nothing else.

use std::path::PathBuf;
use std::process::Output;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::Value;

use super::Harness;

const PROXY_VARIABLES: &[&str] = &[
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "GLOBAL_AGENT_HTTP_PROXY",
    "GLOBAL_AGENT_HTTPS_PROXY",
    "npm_config_https_proxy",
    "npm_config_proxy",
];

pub struct Bw {
    bin: PathBuf,
    home: tempfile::TempDir,
    ca: PathBuf,
    pub session: Option<String>,
}

impl Bw {
    /// A fresh `bw` pointed at the harness's HTTPS URL. Panics — fails, never
    /// skips — when the oracle binary is not configured.
    pub async fn new(harness: &Harness) -> Self {
        let bin = std::env::var_os("OPENSESAME_BW_CLI").map(PathBuf::from).expect(
            "OPENSESAME_BW_CLI must name the official `bw` binary; run `pnpm test:bitwarden-oracle`",
        );
        let home = tempfile::tempdir().unwrap();
        let ca = home.path().join("ca.pem");
        std::fs::write(&ca, &harness.ca_pem).unwrap();
        let bw = Self {
            bin,
            home,
            ca,
            session: None,
        };
        bw.ok(&["config", "server", &harness.https_url]).await;
        bw
    }

    pub async fn run(&self, args: &[&str]) -> Output {
        let mut command = tokio::process::Command::new(&self.bin);
        command
            .args(args)
            .env("BITWARDENCLI_APPDATA_DIR", self.home.path())
            .env("NODE_EXTRA_CA_CERTS", &self.ca)
            .env("BW_NOINTERACTION", "true")
            .env("NODE_NO_WARNINGS", "1")
            .kill_on_drop(true);
        for variable in PROXY_VARIABLES {
            command.env_remove(variable);
        }
        match &self.session {
            Some(session) => command.env("BW_SESSION", session),
            None => command.env_remove("BW_SESSION"),
        };
        command.output().await.unwrap()
    }

    /// Run and require success; stdout, trimmed.
    pub async fn ok(&self, args: &[&str]) -> String {
        let output = self.run(args).await;
        assert!(
            output.status.success(),
            "bw {args:?} failed:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    /// Run and require failure; stdout and stderr together.
    pub async fn fails(&self, args: &[&str]) -> String {
        let output = self.run(args).await;
        assert!(
            !output.status.success(),
            "bw {args:?} unexpectedly succeeded"
        );
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    }

    pub async fn json(&self, args: &[&str]) -> Value {
        let out = self.ok(args).await;
        serde_json::from_str(&out).unwrap_or_else(|e| panic!("bw {args:?}: {e}: {out}"))
    }

    pub async fn login(&mut self, email: &str, password: &str) {
        let session = self.ok(&["login", email, password, "--raw"]).await;
        assert!(!session.is_empty(), "bw login returned no session key");
        self.session = Some(session);
    }

    /// `bw create <object> <base64 json>`, returning the created object.
    pub async fn create(&self, object: &str, value: &Value) -> Value {
        let encoded = B64.encode(value.to_string());
        self.json(&["create", object, &encoded]).await
    }

    /// `bw edit <object> <id> <base64 json>`.
    pub async fn edit(&self, object: &str, id: &str, value: &Value) -> Value {
        let encoded = B64.encode(value.to_string());
        self.json(&["edit", object, id, &encoded]).await
    }

    pub fn home(&self) -> &std::path::Path {
        self.home.path()
    }
}
