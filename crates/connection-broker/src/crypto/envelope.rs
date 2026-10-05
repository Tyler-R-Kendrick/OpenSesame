//! Versioned authority envelopes. Customer context derives a KEK from the
//! operator root; each record receives an independent random data key.
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng, Payload},
    AeadCore, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::{digest, SealedBlob};
use crate::error::{BrokerError, Result};

const MAGIC: &[u8] = b"OSE-AUTH-ENVELOP!";
const VERSION: u8 = 1;
const WRAP_OFFSET: usize = MAGIC.len() + 1;
const KEY_OFFSET: usize = WRAP_OFFSET + 24;
const HEADER_LEN: usize = KEY_OFFSET + 48;

pub(super) fn is_envelope(blob: &SealedBlob) -> bool {
    blob.ciphertext.starts_with(MAGIC)
}

fn unavailable() -> BrokerError {
    BrokerError::SealUnavailable("credential envelope could not be opened".into())
}

fn kek(master: &[u8; 32], aad: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(b"opensesame-authority-envelope-kek-v1"), master)
        .expand(aad, key.as_mut())
        .map_err(|_| unavailable())?;
    Ok(key)
}

fn authenticated_context(aad: &[u8], nonce: &[u8]) -> Vec<u8> {
    let mut context = b"opensesame-authority-envelope-v1\0".to_vec();
    context.extend_from_slice(&(aad.len() as u64).to_be_bytes());
    context.extend_from_slice(aad);
    context.extend_from_slice(nonce);
    context
}

pub(super) fn seal(master: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<SealedBlob> {
    let key = kek(master, aad)?;
    let mut dek = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(dek.as_mut());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let wrap_nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let context = authenticated_context(aad, &nonce);
    let wrapped = XChaCha20Poly1305::new((&*key).into())
        .encrypt(
            &wrap_nonce,
            Payload {
                msg: dek.as_ref(),
                aad: &context,
            },
        )
        .map_err(|_| unavailable())?;
    let mut ciphertext = MAGIC.to_vec();
    ciphertext.push(VERSION);
    ciphertext.extend_from_slice(&wrap_nonce);
    ciphertext.extend_from_slice(&wrapped);
    let mut payload_ad = context;
    payload_ad.extend_from_slice(&ciphertext);
    ciphertext.extend_from_slice(
        &XChaCha20Poly1305::new((&*dek).into())
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &payload_ad,
                },
            )
            .map_err(|_| unavailable())?,
    );
    Ok(SealedBlob {
        ciphertext,
        nonce: nonce.to_vec(),
        aad_digest: digest(aad),
    })
}

pub(super) fn open(master: &[u8; 32], aad: &[u8], blob: &SealedBlob) -> Result<Vec<u8>> {
    if blob.nonce.len() != 24
        || blob.ciphertext.len() < HEADER_LEN + 16
        || blob.ciphertext.get(MAGIC.len()) != Some(&VERSION)
        || blob.aad_digest != digest(aad)
    {
        return Err(unavailable());
    }
    let key = kek(master, aad)?;
    let mut context = authenticated_context(aad, &blob.nonce);
    let dek = Zeroizing::new(
        XChaCha20Poly1305::new((&*key).into())
            .decrypt(
                XNonce::from_slice(&blob.ciphertext[WRAP_OFFSET..KEY_OFFSET]),
                Payload {
                    msg: &blob.ciphertext[KEY_OFFSET..HEADER_LEN],
                    aad: &context,
                },
            )
            .map_err(|_| unavailable())?,
    );
    if dek.len() != 32 {
        return Err(unavailable());
    }
    context.extend_from_slice(&blob.ciphertext[..HEADER_LEN]);
    XChaCha20Poly1305::new_from_slice(&dek)
        .map_err(|_| unavailable())?
        .decrypt(
            XNonce::from_slice(&blob.nonce),
            Payload {
                msg: &blob.ciphertext[HEADER_LEN..],
                aad: &context,
            },
        )
        .map_err(|_| unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_record_has_an_independent_data_key() {
        let master = [9; 32];
        let aad = b"customer-a/vault-a/password";
        let first = seal(&master, aad, b"value").unwrap();
        let second = seal(&master, aad, b"value").unwrap();
        let unwrap = |blob: &SealedBlob| {
            let key = kek(&master, aad).unwrap();
            XChaCha20Poly1305::new((&*key).into())
                .decrypt(
                    XNonce::from_slice(&blob.ciphertext[WRAP_OFFSET..KEY_OFFSET]),
                    Payload {
                        msg: &blob.ciphertext[KEY_OFFSET..HEADER_LEN],
                        aad: &authenticated_context(aad, &blob.nonce),
                    },
                )
                .unwrap()
        };
        assert_ne!(unwrap(&first), unwrap(&second));
        assert_ne!(
            *kek(&master, b"customer-a").unwrap(),
            *kek(&master, b"customer-b").unwrap()
        );
    }
}
