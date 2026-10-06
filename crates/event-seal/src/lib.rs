//! Event and audit rows, sealed at rest (ADR 0157).
//!
//! The Host's `SQLite` file holds what happened: the outbox, security deliveries,
//! connection events, signing events, approval comments, runner steps and
//! receipts. Anyone who can read the file (a backup, a snapshot, a copied
//! volume) would read it whole. Each such value is sealed before it is written,
//! under a key derived from the Host sealing key, with the table and column in
//! the associated data so a value moved to another column does not open.
//!
//! New values use `osev2.` envelopes: a random data key encrypts each value,
//! and a purpose- and customer-derived key wraps that data key. The base64url
//! body is wrap nonce (24), wrapped DEK (48), data nonce (24), ciphertext/tag.
//! Both AEAD operations authenticate the customer and column/record context. Legacy
//! `osev1.` values remain readable. The default process sealer serves deployment
//! events; customer vault events should use an explicit customer sealer.
//!
//! Without an installed sealer, writes remain plaintext for development and
//! legacy plaintext reads remain supported. Recognized sealed values fail closed.

use std::sync::{Arc, PoisonError, RwLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// Every sealed value starts with this.
pub const PREFIX: &str = "osev2.";
const LEGACY_PREFIX: &str = "osev1.";
const ENVELOPE_INFO: &[u8] = b"opensesame:event-seal:kek:v2";
const WRAPPED_KEY_LEN: usize = 48;
const KEY_INFO: &[u8] = b"opensesame:event-seal:v1";
const NONCE_LEN: usize = 24;

/// A sealed value that does not open: the wrong key, or a value that was altered.
#[derive(Debug, PartialEq, Eq)]
pub struct Unreadable {
    pub column: String,
}

impl std::fmt::Display for Unreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a sealed {} value could not be opened", self.column)
    }
}

impl std::error::Error for Unreadable {}

/// The key events are sealed under, derived from the Host sealing key.
pub struct EventSealer {
    root: Zeroizing<[u8; 32]>,
    key: Zeroizing<[u8; 32]>,
    wrapping_key: Zeroizing<[u8; 32]>,
    context: Vec<u8>,
}

impl EventSealer {
    /// # Panics
    ///
    /// Never: HKDF-SHA256 can always produce 32 bytes.
    #[must_use]
    pub fn from_host_key(host_key: &[u8; 32]) -> Self {
        let mut derived = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, host_key)
            .expand(KEY_INFO, derived.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        Self::with_context(host_key, derived, b"deployment")
    }

    /// Build a sealer for a trusted customer identifier and its root key.
    ///
    /// Distinct customer roots permit independent key custody and revocation.
    /// Sharing a root derives distinct customer KEKs but retains shared root custody.
    /// Legacy deployment values are deliberately refused by customer sealers.
    ///
    /// # Panics
    ///
    /// Never: HKDF-SHA256 can always produce 32 bytes.
    #[must_use]
    pub fn from_customer_key(customer_key: &[u8; 32], customer_id: &str) -> Self {
        let mut context = b"customer:".to_vec();
        context.extend_from_slice(customer_id.as_bytes());
        Self::with_context(customer_key, Zeroizing::new([0; 32]), &context)
    }

    fn with_context(root: &[u8; 32], key: Zeroizing<[u8; 32]>, context: &[u8]) -> Self {
        let mut wrapping_key = Zeroizing::new([0u8; 32]);
        let mut info = ENVELOPE_INFO.to_vec();
        info.extend_from_slice(context);
        Hkdf::<Sha256>::new(None, root)
            .expand(&info, wrapping_key.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        Self {
            root: Zeroizing::new(*root),
            key,
            wrapping_key,
            context: context.to_vec(),
        }
    }

    fn aad(&self, column: &str) -> Vec<u8> {
        let mut aad = ENVELOPE_INFO.to_vec();
        aad.extend_from_slice(&(self.context.len() as u64).to_be_bytes());
        aad.extend_from_slice(&self.context);
        aad.extend_from_slice(column.as_bytes());
        aad
    }

    fn wrapping_cipher(&self, column: &str) -> XChaCha20Poly1305 {
        let mut purpose_key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(ENVELOPE_INFO), self.wrapping_key.as_ref())
            .expand(column.as_bytes(), purpose_key.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        XChaCha20Poly1305::new(purpose_key.as_ref().into())
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(self.key.as_ref().into())
    }

    /// Seal `plaintext` for `column` (`table.column`).
    ///
    /// # Panics
    ///
    /// Never in practice: encrypting a buffer cannot fail.
    #[must_use]
    pub fn seal(&self, column: &str, plaintext: &str) -> String {
        let data_key = Zeroizing::new(<[u8; 32]>::from(XChaCha20Poly1305::generate_key(
            &mut OsRng,
        )));
        let wrap_nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let aad = self.aad(column);
        let wrapped_key = self
            .wrapping_cipher(column)
            .encrypt(
                &wrap_nonce,
                Payload {
                    msg: data_key.as_slice(),
                    aad: &aad,
                },
            )
            .expect("encryption of event data key");
        let ciphertext = XChaCha20Poly1305::new(data_key.as_ref().into())
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: &aad,
                },
            )
            .expect("encryption of event value");
        let mut packed = wrap_nonce.to_vec();
        packed.extend_from_slice(&wrapped_key);
        packed.extend_from_slice(&nonce);
        packed.extend_from_slice(&ciphertext);
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(packed))
    }

    /// Open a sealed value. A value that is not sealed is returned as it is.
    ///
    /// # Errors
    ///
    /// Returns [`Unreadable`] for a sealed value that does not authenticate.
    pub fn open(&self, column: &str, stored: &str) -> Result<String, Unreadable> {
        if let Some(body) = stored.strip_prefix(PREFIX) {
            return self.open_envelope(column, body);
        }
        let Some(body) = stored.strip_prefix(LEGACY_PREFIX) else {
            return if is_sealed(stored) {
                Err(Unreadable {
                    column: column.to_owned(),
                })
            } else {
                Ok(stored.to_owned())
            };
        };
        if self.context != b"deployment" {
            return Err(Unreadable {
                column: column.to_owned(),
            });
        }
        let unreadable = || Unreadable {
            column: column.to_owned(),
        };
        let packed = URL_SAFE_NO_PAD.decode(body).map_err(|_| unreadable())?;
        if packed.len() <= NONCE_LEN {
            return Err(unreadable());
        }
        let (nonce, ciphertext) = packed.split_at(NONCE_LEN);
        let plain = Zeroizing::new(
            self.cipher()
                .decrypt(
                    XNonce::from_slice(nonce),
                    Payload {
                        msg: ciphertext,
                        aad: column.as_bytes(),
                    },
                )
                .map_err(|_| unreadable())?,
        );
        String::from_utf8(plain.to_vec()).map_err(|_| unreadable())
    }

    fn open_envelope(&self, column: &str, body: &str) -> Result<String, Unreadable> {
        let unreadable = || Unreadable {
            column: column.to_owned(),
        };
        let packed = URL_SAFE_NO_PAD.decode(body).map_err(|_| unreadable())?;
        let header_len = NONCE_LEN + WRAPPED_KEY_LEN + NONCE_LEN;
        if packed.len() < header_len + 16 {
            return Err(unreadable());
        }
        let aad = self.aad(column);
        let data_key = Zeroizing::new(
            self.wrapping_cipher(column)
                .decrypt(
                    XNonce::from_slice(&packed[..NONCE_LEN]),
                    Payload {
                        msg: &packed[NONCE_LEN..NONCE_LEN + WRAPPED_KEY_LEN],
                        aad: &aad,
                    },
                )
                .map_err(|_| unreadable())?,
        );
        let plain = Zeroizing::new(
            XChaCha20Poly1305::new_from_slice(&data_key)
                .map_err(|_| unreadable())?
                .decrypt(
                    XNonce::from_slice(&packed[NONCE_LEN + WRAPPED_KEY_LEN..header_len]),
                    Payload {
                        msg: &packed[header_len..],
                        aad: &aad,
                    },
                )
                .map_err(|_| unreadable())?,
        );
        String::from_utf8(plain.to_vec()).map_err(|_| unreadable())
    }
}

static ACTIVE: RwLock<Option<Arc<EventSealer>>> = RwLock::new(None);

fn active() -> Option<Arc<EventSealer>> {
    ACTIVE
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// Install the process's sealer. Events written from now on rest sealed.
pub fn install(host_key: &[u8; 32]) {
    *ACTIVE.write().unwrap_or_else(PoisonError::into_inner) =
        Some(Arc::new(EventSealer::from_host_key(host_key)));
}

/// Remove the sealer (tests).
pub fn clear() {
    *ACTIVE.write().unwrap_or_else(PoisonError::into_inner) = None;
}

/// Is events' sealing on in this process?
#[must_use]
pub fn is_active() -> bool {
    active().is_some()
}

/// Is `stored` already a sealed value?
#[must_use]
pub fn is_sealed(stored: &str) -> bool {
    stored.starts_with("osev")
}

/// Seal `plaintext` for `column`, or return it unchanged when no sealer is
/// installed.
#[must_use]
pub fn seal(column: &str, plaintext: &str) -> String {
    active().map_or_else(|| plaintext.to_owned(), |s| s.seal(column, plaintext))
}

/// Seal under the installed root's customer KEK, binding the trusted record ID.
/// Customer identity must come from authorization/storage context, never ciphertext.
#[must_use]
pub fn seal_in(customer: &str, column: &str, record: &str, plaintext: &str) -> String {
    active().map_or_else(
        || plaintext.to_owned(),
        |s| {
            let scoped = EventSealer::from_customer_key(&s.root, customer);
            scoped.seal(&scoped_column(column, record), plaintext)
        },
    )
}

fn scoped_column(column: &str, record: &str) -> String {
    format!("{}:{column}{record}", column.len())
}

/// Open a customer envelope using trusted customer and record context.
/// Legacy `osev1` values use the deployment key and column-only AAD for migration.
///
/// # Errors
/// Returns [`Unreadable`] when a sealed value fails authentication.
pub fn open_in(
    customer: &str,
    column: &str,
    record: &str,
    stored: &str,
) -> Result<String, Unreadable> {
    if !stored.starts_with(PREFIX) {
        return open(column, stored);
    }
    let sealer = active().ok_or_else(|| Unreadable {
        column: column.to_owned(),
    })?;
    EventSealer::from_customer_key(&sealer.root, customer)
        .open(&scoped_column(column, record), stored)
}

/// [`seal`] for a value that may be absent.
#[must_use]
pub fn seal_opt(column: &str, plaintext: Option<&str>) -> Option<String> {
    plaintext.map(|text| seal(column, text))
}

/// Open a stored value: plaintext (an older build's, or no sealer installed)
/// as it is, a sealed value opened.
///
/// # Errors
///
/// Returns [`Unreadable`] for a sealed value that does not open, or one found
/// when no sealer is installed to open it.
pub fn open(column: &str, stored: &str) -> Result<String, Unreadable> {
    if !is_sealed(stored) {
        return Ok(stored.to_owned());
    }
    match active() {
        Some(sealer) => sealer.open(column, stored),
        None => Err(Unreadable {
            column: column.to_owned(),
        }),
    }
}

/// [`open`] for a value that may be absent.
///
/// # Errors
///
/// As [`open`].
pub fn open_opt(column: &str, stored: Option<String>) -> Result<Option<String>, Unreadable> {
    stored.map(|text| open(column, &text)).transpose()
}

#[cfg(test)]
mod tests;
