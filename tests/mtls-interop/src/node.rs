//! Running the Node harnesses that live in `tests/mtls-interop/harness/`.
//!
//! `NODE_OPTIONS` in this container is set to something Node refuses
//! (`--import tsx` outside a project that has it), so every invocation here
//! replaces it outright rather than inheriting it. A harness that cannot
//! start is an error, never a silent skip.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};

use crate::proc::run_bounded;
use crate::repo_root;

/// The harness directory shipped with this crate.
#[must_use]
pub fn harness_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("harness")
}

/// What the Node TLS client reported.
#[derive(Debug)]
pub struct NodeResult {
    /// The parsed JSON line.
    pub json: serde_json::Value,
    /// Everything Node wrote to stderr, for a failure message.
    pub stderr: String,
}

impl NodeResult {
    /// Did the TLS handshake complete and application data flow?
    #[must_use]
    pub fn handshake_ok(&self) -> bool {
        self.json
            .get("handshake")
            .and_then(serde_json::Value::as_str)
            == Some("ok")
    }

    /// The HTTP status, when there was one.
    #[must_use]
    pub fn status(&self) -> Option<u64> {
        self.json.get("status").and_then(serde_json::Value::as_u64)
    }

    /// Node's own error code for a refusal (`ERR_TLS_*`, `ECONNRESET`, …).
    #[must_use]
    pub fn code(&self) -> &str {
        self.json
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    }
}

/// Run `harness/tls-client.mjs` with `IOP_*` environment variables.
///
/// # Errors
///
/// Node could not be started, exited non-zero, or printed no JSON line.
pub fn tls_client(vars: &BTreeMap<String, String>) -> Result<NodeResult> {
    let script = harness_dir().join("tls-client.mjs");
    let mut command = Command::new("node");
    command
        .current_dir(repo_root())
        .arg(&script)
        .env("NODE_OPTIONS", "--max-old-space-size=8192");
    for (name, value) in vars {
        command.env(name, value);
    }
    let (code, stdout, stderr) =
        run_bounded(&mut command, Duration::from_secs(60)).context("node tls-client.mjs")?;
    if code != Some(0) {
        bail!("node tls-client.mjs exited {code:?}\nstdout: {stdout}\nstderr: {stderr}");
    }
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .with_context(|| format!("no JSON line from tls-client.mjs\nstdout: {stdout}"))?;
    Ok(NodeResult {
        json: serde_json::from_str(line)?,
        stderr,
    })
}

/// Build the `IOP_*` map for one dial.
#[must_use]
pub fn vars(port: u16, ca: &std::path::Path, servername: &str, path: &str) -> VarsBuilder {
    let mut map = BTreeMap::new();
    map.insert("IOP_PORT".to_string(), port.to_string());
    map.insert("IOP_CA_FILE".to_string(), ca.to_string_lossy().into_owned());
    map.insert("IOP_SERVERNAME".to_string(), servername.to_string());
    map.insert("IOP_PATH".to_string(), path.to_string());
    VarsBuilder { map }
}

/// Accumulates `IOP_*` variables.
pub struct VarsBuilder {
    map: BTreeMap<String, String>,
}

impl VarsBuilder {
    /// Present this client identity (leaf-first chain plus key).
    #[must_use]
    pub fn identity(mut self, chain: &std::path::Path, key: &std::path::Path) -> Self {
        self.map.insert(
            "IOP_CERT_FILE".to_string(),
            chain.to_string_lossy().into_owned(),
        );
        self.map.insert(
            "IOP_KEY_FILE".to_string(),
            key.to_string_lossy().into_owned(),
        );
        self
    }

    /// Relax only the reference-identity check (issuer verification stays on).
    #[must_use]
    pub fn skip_name_check(mut self) -> Self {
        self.map.insert(
            "IOP_CHECK_SERVER_IDENTITY".to_string(),
            "skip-name".to_string(),
        );
        self
    }

    /// Finish.
    #[must_use]
    pub fn build(self) -> BTreeMap<String, String> {
        self.map
    }
}
