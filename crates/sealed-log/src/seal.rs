//! One line, sealed.
//!
//! `osl1.` + base64url(24-byte nonce ‖ XChaCha20-Poly1305 ciphertext and tag).
//! Each line stands alone: a torn write costs that line and no other, a reader
//! can start anywhere, and rotation needs no re-encryption. The associated data
//! names the format, so a sealed line from another store does not open here.

use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, XChaCha20Poly1305, XNonce};
use zeroize::Zeroize;

/// Every sealed line starts with this.
pub const LINE_PREFIX: &str = "osl1.";
const AAD: &[u8] = b"opensesame.log.v1";
const NONCE_LEN: usize = 24;

/// The key a log is sealed under. Zeroed on drop.
pub struct LogKey([u8; 32]);

impl Drop for LogKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for LogKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LogKey([REDACTED])")
    }
}

impl LogKey {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn generate() -> Self {
        Self(XChaCha20Poly1305::generate_key(&mut OsRng).into())
    }

    /// Read the key at `path`, or create it there (mode 0600, never
    /// overwriting) when it does not exist. A key file that exists but does not
    /// hold a key is an error: minting a new one over it would orphan every
    /// line already sealed.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read or created, or holds
    /// something that is not a 32-byte hex key.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        match Self::read(path) {
            Ok(key) => Ok(key),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let key = Self::generate();
                // Written whole to a private sibling, then linked into place: the
                // link fails if the key already exists, and a reader never sees
                // a key file that is created but not yet written.
                let staging = staging_path(path);
                let mut file = create_private(&staging)?;
                writeln!(file, "{}", hex::encode(key.0))?;
                file.sync_all()?;
                let linked = std::fs::hard_link(&staging, path);
                let _ = std::fs::remove_file(&staging);
                match linked {
                    Ok(()) => Ok(key),
                    // Another process published its key first: use that one.
                    Err(race) if race.kind() == io::ErrorKind::AlreadyExists => Self::read(path),
                    Err(other) => Err(other),
                }
            }
            Err(error) => Err(error),
        }
    }

    /// Read the key at `path` without creating one: what a reader of a log
    /// needs, so that asking for logs never mints a key nothing was sealed under.
    ///
    /// # Errors
    ///
    /// Returns an error when the file is missing or holds no 32-byte hex key.
    pub fn load(path: &Path) -> io::Result<Self> {
        Self::read(path)
    }

    fn read(path: &Path) -> io::Result<Self> {
        let mut text = String::new();
        std::fs::File::open(path)?.read_to_string(&mut text)?;
        let bytes = hex::decode(text.trim())
            .ok()
            .and_then(|raw| <[u8; 32]>::try_from(raw).ok())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{} does not hold a 32-byte hex log key", path.display()),
                )
            })?;
        Ok(Self(bytes))
    }
}

/// A sibling name no other process shares.
fn staging_path(path: &Path) -> std::path::PathBuf {
    let unique = hex::encode(XChaCha20Poly1305::generate_nonce(&mut OsRng));
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{unique}.tmp"));
    std::path::PathBuf::from(name)
}

/// Create a new file readable by its owner only.
pub(crate) fn create_private(path: &Path) -> io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Seal one line (without its newline).
///
/// # Panics
///
/// Never in practice: XChaCha20-Poly1305 encryption of a short buffer cannot fail.
#[must_use]
pub fn seal_line(key: &LogKey, line: &str) -> String {
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: line.as_bytes(),
                aad: AAD,
            },
        )
        .expect("XChaCha20-Poly1305 encryption of a log line");
    let mut packed = nonce.to_vec();
    packed.extend_from_slice(&ciphertext);
    format!("{LINE_PREFIX}{}", URL_SAFE_NO_PAD.encode(packed))
}

/// Open one sealed line, or `None` when it is not one, is torn, or was sealed
/// under another key.
#[must_use]
pub fn open_line(key: &LogKey, sealed: &str) -> Option<String> {
    let body = sealed.trim().strip_prefix(LINE_PREFIX)?;
    let packed = URL_SAFE_NO_PAD.decode(body).ok()?;
    if packed.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, ciphertext) = packed.split_at(NONCE_LEN);
    let plain = XChaCha20Poly1305::new((&key.0).into())
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: AAD,
            },
        )
        .ok()?;
    String::from_utf8(plain).ok()
}
