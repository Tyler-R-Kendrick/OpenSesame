//! One line, sealed.
//!
//! `osl2.` envelopes wrap a fresh data key for each line under a purpose-derived
//! key. A loaded key binds its trusted local key-path namespace. Legacy `osl1.`
//! direct-encryption values remain readable for migration.
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
use opensesame_event_seal::{EventSealer, PREFIX};
use zeroize::{Zeroize, Zeroizing};

/// Every sealed line starts with this.
pub const LINE_PREFIX: &str = "osl2.";
const LEGACY_PREFIX: &str = "osl1.";
const PURPOSE: &str = "sealed-log.line";
const MAX_SEALED_LEN: usize = 32 * 1024 * 1024;
const AAD: &[u8] = b"opensesame.log.v1";
const NONCE_LEN: usize = 24;

/// The key a log is sealed under. Zeroed on drop.
pub struct LogKey {
    bytes: [u8; 32],
    namespace: String,
}

impl Drop for LogKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
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
        Self {
            bytes,
            namespace: String::new(),
        }
    }

    #[must_use]
    pub fn generate() -> Self {
        Self::from_bytes(XChaCha20Poly1305::generate_key(&mut OsRng).into())
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
                let mut key = Self::generate();
                key.namespace = key_namespace(path)?;
                // Written whole to a private sibling, then linked into place: the
                // link fails if the key already exists, and a reader never sees
                // a key file that is created but not yet written.
                let staging = staging_path(path);
                let mut file = create_private(&staging)?;
                let encoded = Zeroizing::new(hex::encode(key.bytes));
                writeln!(file, "{}", encoded.as_str())?;
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

    /// Seal a managed value under trusted namespace and purpose context.
    /// The local key path remains a separate bootstrap custody input.
    #[must_use]
    pub fn seal_value(&self, namespace: &str, purpose: &str, value: &str) -> String {
        self.value_sealer(namespace).seal(purpose, value)
    }

    /// Open only a current envelope; plaintext and unknown formats are refused.
    ///
    /// # Errors
    /// Returns invalid-data when format, key or trusted context does not match.
    pub fn open_value(&self, namespace: &str, purpose: &str, value: &str) -> io::Result<String> {
        if !value.starts_with(PREFIX) || value.len() > MAX_SEALED_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unreadable managed envelope",
            ));
        }
        self.value_sealer(namespace)
            .open(purpose, value)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "unreadable managed envelope"))
    }

    fn value_sealer(&self, namespace: &str) -> EventSealer {
        let context = format!("{}:{}{}", self.namespace.len(), self.namespace, namespace);
        EventSealer::from_customer_key(&self.bytes, &context)
    }

    fn log_sealer(&self) -> EventSealer {
        EventSealer::from_customer_key(&self.bytes, &self.namespace)
    }

    fn read(path: &Path) -> io::Result<Self> {
        let mut text = Zeroizing::new(String::new());
        std::fs::File::open(path)?.read_to_string(&mut text)?;
        let mut bytes = Zeroizing::new([0u8; 32]);
        hex::decode_to_slice(text.trim(), bytes.as_mut()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid 32-byte hex log key")
        })?;
        Ok(Self {
            bytes: *bytes,
            namespace: key_namespace(path)?,
        })
    }
}

/// The caller's known key path, never a namespace supplied by stored ciphertext.
fn key_namespace(path: &Path) -> io::Result<String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let canonical =
        std::fs::canonicalize(parent)?.join(path.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "key path has no filename")
        })?);
    Ok(format!(
        "local-key:{}",
        URL_SAFE_NO_PAD.encode(canonical.as_os_str().as_encoded_bytes())
    ))
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
    let value = key.log_sealer().seal(PURPOSE, line);
    format!(
        "{LINE_PREFIX}{}",
        value.strip_prefix(PREFIX).expect("current event envelope")
    )
}

/// Open a current envelope or a strictly validated legacy line.
#[must_use]
pub fn open_line(key: &LogKey, sealed: &str) -> Option<String> {
    let text = sealed.trim();
    if text.len() > MAX_SEALED_LEN {
        return None;
    }
    if let Some(body) = text.strip_prefix(LINE_PREFIX) {
        return key
            .log_sealer()
            .open(PURPOSE, &format!("{PREFIX}{body}"))
            .ok();
    }
    let body = text.strip_prefix(LEGACY_PREFIX)?;
    let packed = URL_SAFE_NO_PAD.decode(body).ok()?;
    if packed.len() < NONCE_LEN + 16 {
        return None;
    }
    let (nonce, ciphertext) = packed.split_at(NONCE_LEN);
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new((&key.bytes).into())
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: AAD,
                },
            )
            .ok()?,
    );
    String::from_utf8(plain.to_vec()).ok()
}

/// A reserved sealed-log marker, including unsupported numeric versions.
#[must_use]
pub fn is_sealed_line(value: &str) -> bool {
    value
        .strip_prefix("osl")
        .and_then(|rest| rest.split_once('.'))
        .is_some_and(|(version, _)| {
            !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit())
        })
}
