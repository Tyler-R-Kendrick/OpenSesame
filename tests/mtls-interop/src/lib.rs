//! SW-INTEROP: cross-runtime interoperability oracles for optional mTLS and
//! workload identity (ADR 0132).
//!
//! Nothing in this crate is production code. It exists to answer one question
//! the implementing swarms cannot answer about themselves: *does the entry
//! point they shipped enforce the policy when something they did not write
//! talks to it?* So every test here pairs two runtimes — rustls against
//! Node/OpenSSL, a Rust client against the Identity listener, `openssl
//! s_client` against the Host listener, a raw protocol client against the
//! pinned `nats-server` — and every certificate is minted by the system
//! `openssl` CLI rather than by the `rcgen` testkit the production verifiers
//! were developed against.
//!
//! ## Running
//!
//! Every test is `#[ignore]`d unless `OPENSESAME_MTLS_FIXTURES=1`, which is
//! the convention `scripts/mtls-integration-test.sh` drives:
//!
//! ```text
//! OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-mtls-interop -- --ignored
//! ```
//!
//! Pinned native binaries (`nats-server`, `bao`, `spire-server`,
//! `spire-agent`, `caddy`) are resolved through `scripts/mtls-fixtures.sh`,
//! which verifies a sha256 pin before anything is executed.
//!
//! ## What a passing test here does and does not prove
//!
//! A refusal observed by two independent stacks is strong evidence the
//! *certificate* was refused. It is not evidence about any deployment's real
//! trust configuration, and — for the browser harness — a fixture-provisioned
//! client certificate says nothing about how a real person's certificate gets
//! onto their device or gets chosen there.

pub mod node;
pub mod oracle;
pub mod pki;
pub mod proc;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};

/// Are the real-fixture suites enabled for this run?
#[must_use]
pub fn fixtures_enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").is_ok_and(|v| v == "1")
}

/// The repository root, from this crate's manifest directory.
#[must_use]
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default()
}

/// Resolve a pinned fixture binary.
///
/// `scripts/mtls-integration-test.sh` exports `OPENSESAME_MTLS_BIN_*` for
/// tools it has already fetched and verified; anything else goes through
/// `scripts/mtls-fixtures.sh path <tool>`, which re-checks the sha256 pin
/// before printing a path. A tool that cannot be verified is an error, never
/// a silent skip.
///
/// # Errors
///
/// The fixture script failed, or the binary is not executable.
pub fn fixture_binary(tool: &str) -> Result<PathBuf> {
    let env_name = format!(
        "OPENSESAME_MTLS_BIN_{}",
        tool.replace('-', "_").to_uppercase()
    );
    if let Ok(path) = std::env::var(&env_name) {
        if !path.is_empty() && PathBuf::from(&path).is_file() {
            return Ok(PathBuf::from(path));
        }
    }
    let script = repo_root().join("scripts/mtls-fixtures.sh");
    let (code, stdout, stderr) = proc::run_bounded(
        Command::new("/usr/bin/env")
            .arg("bash")
            .arg(&script)
            .arg("path")
            .arg(tool),
        Duration::from_secs(900),
    )
    .with_context(|| format!("mtls-fixtures.sh path {tool}"))?;
    if code != Some(0) {
        bail!("mtls-fixtures.sh path {tool} failed ({code:?}): {stderr}");
    }
    let path = PathBuf::from(stdout.trim());
    if !path.is_file() {
        bail!(
            "mtls-fixtures.sh printed a path that is not a file: {}",
            path.display()
        );
    }
    Ok(path)
}

/// The pinned version string of a fixture tool, for the evidence record.
///
/// # Errors
///
/// The fixture script failed.
pub fn fixture_version(tool: &str) -> Result<String> {
    let script = repo_root().join("scripts/mtls-fixtures.sh");
    let (code, stdout, stderr) = proc::run_bounded(
        Command::new("/usr/bin/env")
            .arg("bash")
            .arg(&script)
            .arg("version")
            .arg(tool),
        Duration::from_secs(30),
    )?;
    if code != Some(0) {
        bail!("mtls-fixtures.sh version {tool} failed: {stderr}");
    }
    Ok(stdout.trim().to_string())
}

/// Print a one-line, machine-greppable record of an executed scenario.
///
/// Keeps SW-TESTOPS' manifest able to attribute a result without this crate
/// depending on its format.
pub fn record(scenario: &str, runtimes: &str, detail: &str) {
    println!("IOP_SCENARIO {scenario} | {runtimes} | {detail}");
}
