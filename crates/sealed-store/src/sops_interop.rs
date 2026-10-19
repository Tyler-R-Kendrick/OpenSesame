//! Optional SOPS YAML/JSON encrypt/decrypt (INTEROP-A/B start).
//!
//! Resolves the binary **only** from absolute `OPENSESAME_SOPS_BIN`, by the
//! same rule as every other override (`opensesame_trusted_exec::named`): after
//! symlinks a regular file with an execute bit. There is no `PATH` search.
//! Core vault tests do not require SOPS.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SopsFormat {
    Yaml,
    Json,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SopsError {
    #[error("sops unavailable: set OPENSESAME_SOPS_BIN to an absolute path")]
    Unavailable,
    #[error("{0}")]
    InvalidBinaryPath(String),
    #[error("sops failed: {0}")]
    Failed(String),
    #[error("io: {0}")]
    Io(String),
}

/// The variable that names the SOPS binary; there is no other way to find it.
const SOPS_BIN: &str = "OPENSESAME_SOPS_BIN";

/// Resolve the pinned SOPS binary from `OPENSESAME_SOPS_BIN` only.
///
/// # Errors
///
/// Returns `Unavailable` when unset; `InvalidBinaryPath`, with the reason
/// (`OPENSESAME_SOPS_BIN must be an absolute path …`, `… is not executable`),
/// when it is not an absolute path to a regular file (after symlinks) the
/// caller can run.
pub fn resolve_sops_bin() -> Result<PathBuf, SopsError> {
    let Some(raw) = std::env::var_os(SOPS_BIN) else {
        return Err(SopsError::Unavailable);
    };
    opensesame_trusted_exec::named(SOPS_BIN, &raw)
        .map_err(|why| SopsError::InvalidBinaryPath(why.to_string()))
}

/// Encrypt structured document bytes with the pinned SOPS binary.
///
/// # Errors
///
/// Returns `Unavailable` when SOPS is not configured, or subprocess failures.
pub fn sops_encrypt(
    plaintext: &[u8],
    format: SopsFormat,
    age_recipients: &[String],
) -> Result<Vec<u8>, SopsError> {
    let bin = resolve_sops_bin()?;
    if age_recipients.is_empty() {
        return Err(SopsError::Failed("no age recipients".into()));
    }
    let mut cmd = confined_sops_command(&bin);
    cmd.arg("--encrypt");
    cmd.arg("--input-type").arg(format_flag(format));
    cmd.arg("--output-type").arg(format_flag(format));
    for recipient in age_recipients {
        cmd.arg("--age").arg(recipient);
    }
    cmd.arg("/dev/stdin");
    run_with_stdin(&mut cmd, plaintext)
}

/// Decrypt a SOPS document with the pinned binary.
///
/// # Errors
///
/// Returns `Unavailable` when SOPS is not configured, or subprocess failures.
pub fn sops_decrypt(ciphertext: &[u8], format: SopsFormat) -> Result<Vec<u8>, SopsError> {
    let bin = resolve_sops_bin()?;
    let mut cmd = confined_sops_command(&bin);
    cmd.arg("--decrypt");
    cmd.arg("--input-type").arg(format_flag(format));
    cmd.arg("--output-type").arg(format_flag(format));
    cmd.arg("/dev/stdin");
    run_with_stdin(&mut cmd, ciphertext)
}

fn format_flag(format: SopsFormat) -> &'static str {
    match format {
        SopsFormat::Yaml => "yaml",
        SopsFormat::Json => "json",
    }
}

/// SOPS from an empty environment, with nothing but what this confined call
/// decides: the `C` locale, `PATH` holding only the binary's own directory, and
/// `SOPS_AGE_KEY_FILE` emptied so no operator key file is read. No `HOME`, no
/// proxy, no CA bundle: encryption to `--age` recipients and decryption from
/// stdin reach no network and read no `.sops.yaml`.
fn confined_sops_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.env_clear();
    cmd.env("LANG", "C");
    cmd.env("LC_ALL", "C");
    if let Some(dir) = bin.parent() {
        cmd.env("PATH", dir);
    }
    cmd.env("SOPS_AGE_KEY_FILE", "");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

fn run_with_stdin(cmd: &mut Command, stdin: &[u8]) -> Result<Vec<u8>, SopsError> {
    let mut child = cmd.spawn().map_err(|e| SopsError::Io(e.to_string()))?;
    if let Some(mut input) = child.stdin.take() {
        use std::io::Write;
        input
            .write_all(stdin)
            .map_err(|e| SopsError::Io(e.to_string()))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| SopsError::Io(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(SopsError::Failed(if err.is_empty() {
            format!("exit {}", output.status)
        } else {
            err
        }));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_sops_bin_is_unavailable() {
        // Ensure the typed path is hit when unset in this process thread.
        // Other tests must not rely on SOPS being installed.
        let before = std::env::var_os("OPENSESAME_SOPS_BIN");
        std::env::remove_var("OPENSESAME_SOPS_BIN");
        let err = resolve_sops_bin().unwrap_err();
        assert_eq!(err, SopsError::Unavailable);
        match before {
            Some(v) => std::env::set_var("OPENSESAME_SOPS_BIN", v),
            None => std::env::remove_var("OPENSESAME_SOPS_BIN"),
        }
    }

    #[test]
    fn relative_sops_bin_rejected() {
        let before = std::env::var_os("OPENSESAME_SOPS_BIN");
        std::env::set_var("OPENSESAME_SOPS_BIN", "sops");
        let err = resolve_sops_bin().unwrap_err();
        assert!(
            matches!(&err, SopsError::InvalidBinaryPath(why)
                if why.starts_with("OPENSESAME_SOPS_BIN must be an absolute path")),
            "{err:?}"
        );
        match before {
            Some(v) => std::env::set_var("OPENSESAME_SOPS_BIN", v),
            None => std::env::remove_var("OPENSESAME_SOPS_BIN"),
        }
    }
}
