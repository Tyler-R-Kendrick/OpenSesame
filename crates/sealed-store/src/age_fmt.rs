use std::fs;
use std::io::Write;
use std::path::Path;
use std::str::FromStr;

use age::decrypt;
use age::x25519::{Identity, Recipient};

use crate::StoreError;

const AGE_RECIPIENTS: &str = ".age-recipients";

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn read_age_recipients(root: &Path) -> Result<Vec<String>, StoreError> {
    let path = root.join(AGE_RECIPIENTS);
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

/// Encrypt to every recipient listed, so any one matching identity can open
/// the file — `pass` multi-key parity, not just the first line.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn encrypt_age_file(
    path: &Path,
    plaintext: &[u8],
    recipient_lines: &[String],
) -> Result<(), StoreError> {
    let ciphertext = encrypt_age(plaintext, recipient_lines)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, ciphertext)?;
    Ok(())
}

pub(crate) fn encrypt_age(
    plaintext: &[u8],
    recipient_lines: &[String],
) -> Result<Vec<u8>, StoreError> {
    if recipient_lines.is_empty() {
        return Err(StoreError::Age("no age recipients".into()));
    }
    let recipients: Vec<Recipient> = recipient_lines
        .iter()
        .map(|line| Recipient::from_str(line.trim()).map_err(|e| StoreError::Age(e.to_string())))
        .collect::<Result<_, _>>()?;
    let encryptor =
        age::Encryptor::with_recipients(recipients.iter().map(|r| r as &dyn age::Recipient))
            .map_err(|e| StoreError::Age(e.to_string()))?;
    let mut ciphertext = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut ciphertext)
        .map_err(|e| StoreError::Age(e.to_string()))?;
    writer
        .write_all(plaintext)
        .and_then(|()| writer.finish().map(drop))
        .map_err(|e| StoreError::Age(e.to_string()))?;
    Ok(ciphertext)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn decrypt_age_file(path: &Path, identity_pem_or_key: &str) -> Result<Vec<u8>, StoreError> {
    decrypt_age(&fs::read(path)?, identity_pem_or_key)
}

pub(crate) fn decrypt_age(
    ciphertext: &[u8],
    identity_pem_or_key: &str,
) -> Result<Vec<u8>, StoreError> {
    let identity = Identity::from_str(identity_pem_or_key.trim())
        .map_err(|e| StoreError::Age(e.to_string()))?;
    decrypt(&identity, ciphertext).map_err(|e| StoreError::Age(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use age::secrecy::ExposeSecret;

    #[test]
    fn age_encrypts_to_every_recipient() {
        let dir = tempfile::tempdir().unwrap();
        let first = Identity::generate();
        let second = Identity::generate();
        let path = dir.path().join("multi.age");
        encrypt_age_file(
            &path,
            b"shared",
            &[
                first.to_public().to_string(),
                second.to_public().to_string(),
            ],
        )
        .unwrap();
        for id in [&first, &second] {
            let key = id.to_string().expose_secret().to_string();
            assert_eq!(decrypt_age_file(&path, &key).unwrap(), b"shared");
        }
    }

    #[test]
    fn age_round_trip_file() {
        let dir = tempfile::tempdir().unwrap();
        let id = Identity::generate();
        let recip = id.to_public().to_string();
        let path = dir.path().join("secret.age");
        encrypt_age_file(&path, b"hello-age", &[recip]).unwrap();
        let id_str = {
            use age::secrecy::ExposeSecret;
            id.to_string().expose_secret().to_string()
        };
        let pt = decrypt_age_file(&path, &id_str).unwrap();
        assert_eq!(pt, b"hello-age");
    }
}
