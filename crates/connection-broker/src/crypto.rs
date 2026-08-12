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

fn associated_data(connection_id: &str, organization_id: &str) -> Vec<u8> {
    format!("opensesame:connection:v1:{connection_id}:{organization_id}").into_bytes()
}

fn digest(aad: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(aad);
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn seal(
    key: &[u8; 32],
    connection_id: &str,
    organization_id: &str,
    plaintext: &[u8],
) -> Result<SealedBlob> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let aad = associated_data(connection_id, organization_id);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| BrokerError::SealUnavailable("sealing failed".into()))?;
    Ok(SealedBlob {
        ciphertext,
        nonce: nonce.to_vec(),
        aad_digest: digest(&aad),
    })
}

pub fn open(
    key: &[u8; 32],
    connection_id: &str,
    organization_id: &str,
    blob: &SealedBlob,
) -> Result<Vec<u8>> {
    if blob.nonce.len() != 24 {
        return Err(BrokerError::SealUnavailable("nonce length".into()));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let aad = associated_data(connection_id, organization_id);
    cipher
        .decrypt(
            XNonce::from_slice(&blob.nonce),
            Payload {
                msg: &blob.ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| BrokerError::SealUnavailable("credential could not be opened".into()))
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

    #[test]
    fn aad_digest_binds_both_ids() {
        let a = seal(&KEY, CID, ORG, b"x").unwrap();
        let b = seal(&KEY, CID, "org:2", b"x").unwrap();
        assert_ne!(a.aad_digest, b.aad_digest);
        assert_eq!(a.aad_digest.len(), 64);
    }
}
