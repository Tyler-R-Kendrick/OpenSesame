use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::StoreError;

const GPG_ID: &str = ".gpg-id";

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn read_gpg_id(root: &Path) -> Result<Vec<String>, StoreError> {
    let path = root.join(GPG_ID);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path)?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect())
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn decrypt_gpg_file(path: &Path) -> Result<Vec<u8>, StoreError> {
    decrypt_gpg(&fs::read(path)?)
}

pub(crate) fn decrypt_gpg(ciphertext: &[u8]) -> Result<Vec<u8>, StoreError> {
    let mut child = Command::new("gpg")
        .args(["--quiet", "--batch", "--decrypt"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| StoreError::Gpg("gpg stdin".into()))?
        .write_all(ciphertext)
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    let output = child
        .wait_with_output()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    if !output.status.success() {
        return Err(StoreError::Gpg(
            String::from_utf8_lossy(&output.stderr).into(),
        ));
    }
    Ok(output.stdout)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn encrypt_gpg_file(
    path: &Path,
    plaintext: &[u8],
    recipients: &[String],
) -> Result<(), StoreError> {
    let ciphertext = encrypt_gpg(plaintext, recipients)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, ciphertext)?;
    Ok(())
}

pub(crate) fn encrypt_gpg(plaintext: &[u8], recipients: &[String]) -> Result<Vec<u8>, StoreError> {
    if recipients.is_empty() {
        return Err(StoreError::Gpg("no .gpg-id recipients".into()));
    }
    let mut args = vec![
        "--quiet".into(),
        "--batch".into(),
        "--yes".into(),
        "--encrypt".into(),
    ];
    for r in recipients {
        args.push("--recipient".into());
        args.push(r.clone());
    }
    let mut child = Command::new("gpg")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| StoreError::Gpg("gpg stdin".into()))?;
        stdin
            .write_all(plaintext)
            .map_err(|e| StoreError::Gpg(e.to_string()))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    if !output.status.success() {
        return Err(StoreError::Gpg(
            String::from_utf8_lossy(&output.stderr).into(),
        ));
    }
    Ok(output.stdout)
}
