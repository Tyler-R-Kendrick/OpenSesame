use std::fs;
use std::path::Path;
use std::str::FromStr;

use age::x25519::{Identity, Recipient};
use age::{decrypt, encrypt};

use crate::StoreError;

const AGE_RECIPIENTS: &str = ".age-recipients";

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

pub fn encrypt_age_file(path: &Path, plaintext: &[u8], recipient_lines: &[String]) -> Result<(), StoreError> {
    if recipient_lines.is_empty() {
        return Err(StoreError::Age("no age recipients".into()));
    }
    // Encrypt to the first recipient for v1 file writes (multi-recipient via Encryptor later).
    let recipient =
        Recipient::from_str(recipient_lines[0].trim()).map_err(|e| StoreError::Age(e.to_string()))?;
    let ciphertext = encrypt(&recipient, plaintext).map_err(|e| StoreError::Age(e.to_string()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, ciphertext)?;
    Ok(())
}

pub fn decrypt_age_file(path: &Path, identity_pem_or_key: &str) -> Result<Vec<u8>, StoreError> {
    let identity = Identity::from_str(identity_pem_or_key.trim())
        .map_err(|e| StoreError::Age(e.to_string()))?;
    let ciphertext = fs::read(path)?;
    decrypt(&identity, &ciphertext).map_err(|e| StoreError::Age(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
