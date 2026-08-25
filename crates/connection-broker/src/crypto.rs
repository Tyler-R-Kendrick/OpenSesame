//! Credential sealing (ADR 0032 §7).
//!
//! XChaCha20-Poly1305 with the connection and organization ids as associated
//! data, so a ciphertext lifted into another tenant's row does not open.

use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng, Payload},
    AeadCore, XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};

use crate::error::{BrokerError, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedBlob {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    /// Digest of the associated data, stored so a row can be audited without
    /// being decrypted.
    pub aad_digest: String,
}

fn associated_data(scope: &str, record_id: &str, organization_id: &str) -> Vec<u8> {
    format!("opensesame:{scope}:v1:{record_id}:{organization_id}").into_bytes()
}

/// Associated data for a project-config secret value (ADR 0052). Binds the
/// full scope — organization, project, config, key name, and version — so a
/// ciphertext transplanted to another key, config, tenant, or version slot
/// does not open. Rollback therefore re-seals: old bytes are never copied
/// into a new version slot.
#[must_use]
pub fn config_value_ad(
    organization_id: &str,
    project_id: &str,
    config_id: &str,
    key_name: &str,
    version: u64,
) -> Vec<u8> {
    format!(
        "org|{organization_id}|project|{project_id}|config|{config_id}|key|{key_name}|v|{version}"
    )
    .into_bytes()
}

fn digest(aad: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(aad);
    hex::encode(hasher.finalize())
}

/// # Errors
///
/// Returns an error when credential sealing fails.
pub fn seal(
    key: &[u8; 32],
    connection_id: &str,
    organization_id: &str,
    plaintext: &[u8],
) -> Result<SealedBlob> {
    seal_with_ad(
        key,
        &associated_data("connection", connection_id, organization_id),
        plaintext,
    )
}

/// Seal Host-only material under purpose-separated associated data.
/// `scope` must be a fixed code-owned label, never request input.
///
/// # Errors
///
/// Returns an error when material sealing fails.
pub fn seal_scoped(
    key: &[u8; 32],
    scope: &str,
    record_id: &str,
    organization_id: &str,
    plaintext: &[u8],
) -> Result<SealedBlob> {
    seal_with_ad(
        key,
        &associated_data(scope, record_id, organization_id),
        plaintext,
    )
}

/// # Errors
///
/// Returns an error when the credential cannot be authenticated or opened.
pub fn open(
    key: &[u8; 32],
    connection_id: &str,
    organization_id: &str,
    blob: &SealedBlob,
) -> Result<Vec<u8>> {
    open_with_ad(
        key,
        &associated_data("connection", connection_id, organization_id),
        blob,
    )
}

/// Seal under caller-supplied associated data. The AAD builder chosen by the
/// caller (connection vs config-value) is what scopes the ciphertext.
///
/// # Errors
///
/// Returns an error when credential sealing fails.
pub fn seal_with_ad(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<SealedBlob> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| BrokerError::SealUnavailable("sealing failed".into()))?;
    Ok(SealedBlob {
        ciphertext,
        nonce: nonce.to_vec(),
        aad_digest: digest(aad),
    })
}

/// # Errors
///
/// Returns an error when the nonce is invalid or authentication fails.
pub fn open_with_ad(key: &[u8; 32], aad: &[u8], blob: &SealedBlob) -> Result<Vec<u8>> {
    if blob.nonce.len() != 24 {
        return Err(BrokerError::SealUnavailable("nonce length".into()));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            XNonce::from_slice(&blob.nonce),
            Payload {
                msg: &blob.ciphertext,
                aad,
            },
        )
        .map_err(|_| BrokerError::SealUnavailable("credential could not be opened".into()))
}

/// Open Host-only material under purpose-separated associated data.
///
/// # Errors
///
/// Returns an error when the nonce or authentication tag is invalid.
pub fn open_scoped(
    key: &[u8; 32],
    scope: &str,
    record_id: &str,
    organization_id: &str,
    blob: &SealedBlob,
) -> Result<Vec<u8>> {
    open_with_ad(
        key,
        &associated_data(scope, record_id, organization_id),
        blob,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [9u8; 32];
    const CID: &str = "connection:1";
    const ORG: &str = "org:1";

    #[test]
    fn roundtrip() {
        let blob = seal(&KEY, CID, ORG, b"token-material").unwrap();
        assert_ne!(blob.ciphertext, b"token-material");
        assert_eq!(open(&KEY, CID, ORG, &blob).unwrap(), b"token-material");
    }

    #[test]
    fn each_seal_uses_a_fresh_nonce() {
        let a = seal(&KEY, CID, ORG, b"x").unwrap();
        let b = seal(&KEY, CID, ORG, b"x").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn tampered_ciphertext_does_not_open() {
        let mut blob = seal(&KEY, CID, ORG, b"token-material").unwrap();
        blob.ciphertext[0] ^= 0x01;
        assert!(open(&KEY, CID, ORG, &blob).is_err());
    }

    #[test]
    fn tampered_nonce_does_not_open() {
        let mut blob = seal(&KEY, CID, ORG, b"token-material").unwrap();
        blob.nonce[0] ^= 0x01;
        assert!(open(&KEY, CID, ORG, &blob).is_err());
        blob.nonce.truncate(12);
        assert!(open(&KEY, CID, ORG, &blob).is_err());
    }

    /// The point of the AAD: a row moved between tenants is unreadable.
    #[test]
    fn a_row_moved_between_tenants_does_not_open() {
        let blob = seal(&KEY, CID, ORG, b"token-material").unwrap();
        assert!(open(&KEY, CID, "org:2", &blob).is_err());
        assert!(open(&KEY, "connection:2", ORG, &blob).is_err());
    }

    #[test]
    fn another_key_does_not_open() {
        let blob = seal(&KEY, CID, ORG, b"token-material").unwrap();
        assert!(open(&[8u8; 32], CID, ORG, &blob).is_err());
    }

    /// §4.2 of the parity spec: a config-value ciphertext moved to another
    /// key, config, or version slot must not open.
    #[test]
    fn config_value_ciphertext_does_not_transplant() {
        let ad = config_value_ad("org:1", "proj:1", "cfg:1", "API_KEY", 3);
        let blob = seal_with_ad(&KEY, &ad, b"value").unwrap();
        assert_eq!(open_with_ad(&KEY, &ad, &blob).unwrap(), b"value");
        for other in [
            config_value_ad("org:2", "proj:1", "cfg:1", "API_KEY", 3),
            config_value_ad("org:1", "proj:2", "cfg:1", "API_KEY", 3),
            config_value_ad("org:1", "proj:1", "cfg:2", "API_KEY", 3),
            config_value_ad("org:1", "proj:1", "cfg:1", "OTHER_KEY", 3),
            config_value_ad("org:1", "proj:1", "cfg:1", "API_KEY", 4),
        ] {
            assert!(open_with_ad(&KEY, &other, &blob).is_err());
        }
    }

    #[test]
    fn config_value_ad_is_deterministic_and_version_scoped() {
        let a = config_value_ad("o", "p", "c", "K", 1);
        let b = config_value_ad("o", "p", "c", "K", 1);
        assert_eq!(a, b);
        assert_ne!(a, config_value_ad("o", "p", "c", "K", 2));
    }

    #[test]
    fn aad_digest_binds_both_ids() {
        let a = seal(&KEY, CID, ORG, b"x").unwrap();
        let b = seal(&KEY, CID, "org:2", b"x").unwrap();
        assert_ne!(a.aad_digest, b.aad_digest);
        assert_eq!(a.aad_digest.len(), 64);
    }

    #[test]
    fn purpose_separation_rejects_cross_subsystem_open() {
        let blob = seal_scoped(&KEY, "certificate_authority", CID, ORG, b"ca-key").unwrap();
        assert!(open_scoped(&KEY, "certificate_authority", CID, ORG, &blob).is_ok());
        assert!(open_scoped(&KEY, "certificate_delivery", CID, ORG, &blob).is_err());
        assert!(open(&KEY, CID, ORG, &blob).is_err());
    }
}
