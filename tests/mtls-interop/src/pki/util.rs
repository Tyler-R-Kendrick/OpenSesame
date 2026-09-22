//! The `openssl` invocation and the small file helpers the issuer uses.
//!
//! Split out so `pki/mod.rs` stays inside the 400-line module budget
//! (ADR 0093).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context as _, Result};

pub(super) fn openssl(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new("/usr/bin/openssl")
        .current_dir(dir)
        .args(args)
        .output()
        .with_context(|| format!("spawn openssl {}", args.join(" ")))?;
    if !out.status.success() {
        bail!(
            "openssl {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(out.stdout)
}

pub(super) fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

pub(super) fn concat(dir: &Path, name: &str, parts: &[&Path]) -> Result<PathBuf> {
    let mut buf = Vec::new();
    for part in parts {
        buf.extend_from_slice(&std::fs::read(part).with_context(|| format!("{}", part.display()))?);
        if !buf.ends_with(b"\n") {
            buf.push(b'\n');
        }
    }
    let path = dir.join(name);
    write(&path, &buf)?;
    Ok(path)
}

pub(super) fn thumbprint_of(dir: &Path, cert: &Path) -> Result<String> {
    let out = openssl(
        dir,
        &[
            "x509",
            "-in",
            &cert.to_string_lossy(),
            "-outform",
            "DER",
            "-fingerprint",
            "-sha256",
            "-noout",
        ],
    )?;
    let text = String::from_utf8_lossy(&out);
    let hex = text
        .split('=')
        .nth(1)
        .context("openssl fingerprint had no value")?;
    Ok(hex.trim().replace(':', "").to_lowercase())
}
