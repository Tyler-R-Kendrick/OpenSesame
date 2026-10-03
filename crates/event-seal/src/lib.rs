//! Event and audit rows, sealed at rest (ADR 0156).
//!
//! The Host's `SQLite` file holds what happened: the outbox, security deliveries,
//! connection events, signing events, approval comments, runner steps and
//! receipts. Anyone who can read the file (a backup, a snapshot, a copied
//! volume) would read it whole. Each such value is sealed before it is written,
//! under a key derived from the Host sealing key, with the table and column in
//! the associated data so a value moved to another column does not open.
//!
//! A sealed value is a text string, `osev1.` + base64url(24-byte nonce ‖
//! XChaCha20-Poly1305 ciphertext and tag), so the schema, the migrations and
//! every query that does not read the value stay as they were.
//!
//! There is one sealer for the process, installed once at start-up
//! ([`install`]). Free functions inside transactions write these rows, and a
//! sealer plumbed through every call would ripple through all of them; the Host
//! is one process with one database and one key. With none installed (tests,
//! an in-memory development database) [`seal`] returns its input and [`open`]
//! accepts plaintext, which is also what lets a value an older build left in the
//! clear read as it is until [`is_sealed`] says the sweep has reached it.

use std::sync::{Arc, PoisonError, RwLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// Every sealed value starts with this.
pub const PREFIX: &str = "osev1.";
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
    key: Zeroizing<[u8; 32]>,
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
        Self { key: derived }
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
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher()
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: column.as_bytes(),
                },
            )
            .expect("XChaCha20-Poly1305 encryption of an event value");
        let mut packed = nonce.to_vec();
        packed.extend_from_slice(&ciphertext);
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(packed))
    }

    /// Open a sealed value. A value that is not sealed is returned as it is.
    ///
    /// # Errors
    ///
    /// Returns [`Unreadable`] for a sealed value that does not authenticate.
    pub fn open(&self, column: &str, stored: &str) -> Result<String, Unreadable> {
        let Some(body) = stored.strip_prefix(PREFIX) else {
            return Ok(stored.to_owned());
        };
        let unreadable = || Unreadable {
            column: column.to_owned(),
        };
        let packed = URL_SAFE_NO_PAD.decode(body).map_err(|_| unreadable())?;
        if packed.len() <= NONCE_LEN {
            return Err(unreadable());
        }
        let (nonce, ciphertext) = packed.split_at(NONCE_LEN);
        let plain = self
            .cipher()
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: column.as_bytes(),
                },
            )
            .map_err(|_| unreadable())?;
        String::from_utf8(plain).map_err(|_| unreadable())
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
    stored.starts_with(PREFIX)
}

/// Seal `plaintext` for `column`, or return it unchanged when no sealer is
/// installed.
#[must_use]
pub fn seal(column: &str, plaintext: &str) -> String {
    active().map_or_else(|| plaintext.to_owned(), |s| s.seal(column, plaintext))
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
