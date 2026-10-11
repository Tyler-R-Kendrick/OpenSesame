//! One HPKE context: the key schedule of RFC 9180 section 5.1, sealing and
//! opening with the sequence-numbered nonce, and the secret exporter.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes128Gcm,
};
use chacha20poly1305::ChaCha20Poly1305;

use super::kdf::{hpke_suite, labeled_expand, labeled_extract};
use super::{HpkeAead, HpkeError};
use crate::secret::Secret;

const NONCE_LENGTH: usize = 12;
const HASH_LENGTH: usize = 32;
const MODE_BASE: u8 = 0;

/// The sender's or recipient's side of one HPKE context.
pub struct Context {
    aead: HpkeAead,
    key: Secret,
    base_nonce: Vec<u8>,
    exporter_secret: Secret,
    shared_secret: Secret,
    sequence: u64,
}

impl std::fmt::Debug for Context {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Context")
            .field("aead", &self.aead)
            .field("key", &"[REDACTED]")
            .field("sequence", &self.sequence)
            .finish_non_exhaustive()
    }
}

impl Context {
    /// `KeySchedule(base, shared_secret, info)`, RFC 9180 section 5.1.
    ///
    /// # Errors
    /// [`HpkeError::Length`] if HKDF refuses a length (it does not for these).
    pub fn new(aead: HpkeAead, shared_secret: Secret, info: &[u8]) -> Result<Self, HpkeError> {
        let suite = hpke_suite(aead);
        let psk_id_hash = labeled_extract(&suite, &[], "psk_id_hash", &[]);
        let info_hash = labeled_extract(&suite, &[], "info_hash", info);
        let mut context = vec![MODE_BASE];
        context.extend_from_slice(psk_id_hash.expose());
        context.extend_from_slice(info_hash.expose());
        let secret = labeled_extract(&suite, shared_secret.expose(), "secret", &[]);
        let secret = secret.expose();
        Ok(Self {
            aead,
            key: labeled_expand(&suite, secret, "key", &context, aead.key_length())?,
            base_nonce: labeled_expand(&suite, secret, "base_nonce", &context, NONCE_LENGTH)?
                .expose()
                .to_vec(),
            exporter_secret: labeled_expand(&suite, secret, "exp", &context, HASH_LENGTH)?,
            shared_secret,
            sequence: 0,
        })
    }

    /// The shared secret the context was set up from.
    #[must_use]
    pub fn shared_secret(&self) -> &[u8] {
        self.shared_secret.expose()
    }

    /// The AEAD key.
    #[must_use]
    pub fn key(&self) -> &[u8] {
        self.key.expose()
    }

    /// The base nonce.
    #[must_use]
    pub fn base_nonce(&self) -> &[u8] {
        &self.base_nonce
    }

    /// The exporter secret.
    #[must_use]
    pub fn exporter_secret(&self) -> &[u8] {
        self.exporter_secret.expose()
    }

    /// The nonce for message number `sequence`: `base_nonce XOR I2OSP(seq, Nn)`.
    #[must_use]
    pub fn nonce_at(&self, sequence: u64) -> Vec<u8> {
        let counter = sequence.to_be_bytes();
        let mut nonce = self.base_nonce.clone();
        let offset = NONCE_LENGTH - counter.len();
        for (byte, count) in nonce[offset..].iter_mut().zip(counter) {
            *byte ^= count;
        }
        nonce
    }

    /// `Context.Export(exporter_context, L)`, RFC 9180 section 5.3.
    ///
    /// # Errors
    /// [`HpkeError::Length`] for `length` above 255 hash blocks.
    pub fn export(&self, exporter_context: &[u8], length: usize) -> Result<Secret, HpkeError> {
        labeled_expand(
            &hpke_suite(self.aead),
            self.exporter_secret.expose(),
            "sec",
            exporter_context,
            length,
        )
    }

    fn crypt(&self, aad: &[u8], input: &[u8], encrypt: bool) -> Result<Vec<u8>, HpkeError> {
        let nonce = self.nonce_at(self.sequence);
        let payload = Payload { msg: input, aad };
        let nonce = aes_gcm::Nonce::from_slice(&nonce);
        let out = match self.aead {
            HpkeAead::Aes128Gcm => {
                let cipher =
                    Aes128Gcm::new_from_slice(self.key.expose()).map_err(|_| HpkeError::Length)?;
                if encrypt {
                    cipher.encrypt(nonce, payload)
                } else {
                    cipher.decrypt(nonce, payload)
                }
            }
            HpkeAead::ChaCha20Poly1305 => {
                let cipher = ChaCha20Poly1305::new_from_slice(self.key.expose())
                    .map_err(|_| HpkeError::Length)?;
                if encrypt {
                    cipher.encrypt(nonce, payload)
                } else {
                    cipher.decrypt(nonce, payload)
                }
            }
        };
        out.map_err(|_| HpkeError::Authentication)
    }

    fn advance(&mut self) -> Result<(), HpkeError> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(HpkeError::MessageLimit)?;
        Ok(())
    }

    /// Seal the next message; each call uses the next nonce.
    ///
    /// # Errors
    /// [`HpkeError`] if the sequence would wrap.
    pub fn seal(&mut self, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, HpkeError> {
        let sealed = self.crypt(aad, plaintext, true)?;
        self.advance()?;
        Ok(sealed)
    }

    /// Open the next message. Messages must be opened in the order they were sealed.
    ///
    /// # Errors
    /// [`HpkeError::Authentication`] for anything that does not authenticate.
    pub fn open(&mut self, aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, HpkeError> {
        let opened = self.crypt(aad, ciphertext, false)?;
        self.advance()?;
        Ok(opened)
    }
}
