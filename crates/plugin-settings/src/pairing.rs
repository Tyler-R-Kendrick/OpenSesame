//! Pairing one browser origin with the daemon's plugin settings (ADR 0150 §7).
//!
//! A person at the daemon's terminal runs `opensesame plugins pair --origin
//! <origin>`. That records a one-time code for exactly that origin and prints
//! it once, wrapped with the daemon's address as a pairing code
//! (`opensesame-plugins:v1:…`). The page at that origin trades the code, once,
//! for a bearer that opens the `/v1/plugins` routes and nothing else, and only
//! when the request's `Origin` is the one named at pair time.
//!
//! The file beside `plugins.json` keeps a SHA-256 of each code and each
//! bearer, never either value. A code lives [`CODE_TTL_SECS`]; a code
//! presented from any other origin is spent on the spot, because a code that
//! reached the wrong page has leaked. `opensesame plugins unpair` removes
//! bearers, and the next request that presents one is refused.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pairing_code::{
    digest_hex, find_digest, is_pairable_origin, is_secret_shaped, pairing_id, same, secret,
};

/// The file beside the settings file.
pub const PAIRINGS_FILE: &str = "plugin-pairings.json";
/// How long a code may wait to be traded.
pub const CODE_TTL_SECS: u64 = 300;
/// Codes waiting at once; more is a flood, not a person.
pub const MAX_PENDING: usize = 8;
/// Paired pages at once; one per browser profile is the expected case.
pub const MAX_PAIRED: usize = 16;
const FILE_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error(
        "an origin is https://host[:port] or http://localhost:port, exactly as a browser sends it"
    )]
    InvalidOrigin,
    #[error("too many plugin pairings; unpair one first")]
    Full,
    #[error("no such pairing code")]
    Unknown,
    #[error("the pairing code expired")]
    Expired,
    #[error("the pairing code was issued for another origin, and is now spent")]
    WrongOrigin,
    #[error("plugin pairings are unreadable: {0}")]
    Unreadable(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    code_sha256: String,
    origin: String,
    expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PairedPage {
    id: String,
    token_sha256: String,
    origin: String,
    paired_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PairingFile {
    v: u32,
    #[serde(default)]
    pending: Vec<Pending>,
    #[serde(default)]
    paired: Vec<PairedPage>,
}

impl Default for PairingFile {
    fn default() -> Self {
        Self {
            v: FILE_VERSION,
            pending: Vec::new(),
            paired: Vec::new(),
        }
    }
}

/// A paired page as the operator sees it: no digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairedView {
    pub id: String,
    pub origin: String,
    pub paired_at: u64,
}

/// A code still waiting, as the operator sees it: no digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingView {
    pub origin: String,
    pub expires_at: u64,
}

/// A bearer handed back once by [`PluginPairings::exchange`]; never stored.
pub struct Issued {
    pub id: String,
    pub origin: String,
    pub token: String,
}

impl std::fmt::Debug for Issued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Issued")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// The pairings file, read and written whole on every call so the CLI and
/// the daemon see each other's changes without a restart.
#[derive(Clone, Debug)]
pub struct PluginPairings {
    path: PathBuf,
}

impl PluginPairings {
    /// `<dir of plugins.json>/plugin-pairings.json`.
    #[must_use]
    pub fn beside(settings_path: &Path) -> Self {
        let dir = settings_path.parent().unwrap_or_else(|| Path::new("."));
        Self {
            path: dir.join(PAIRINGS_FILE),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> Result<PairingFile, PairingError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PairingFile::default())
            }
            Err(error) => return Err(error.into()),
        };
        let file: PairingFile = serde_json::from_slice(&bytes)
            .map_err(|error| PairingError::Unreadable(error.to_string()))?;
        if file.v != FILE_VERSION {
            return Err(PairingError::Unreadable(format!("version {}", file.v)));
        }
        Ok(file)
    }

    fn save(&self, file: &PairingFile) -> Result<(), PairingError> {
        let bytes = serde_json::to_vec_pretty(file)
            .map_err(|error| PairingError::Unreadable(error.to_string()))?;
        crate::settings::write_atomic(&self.path, "json.tmp", &bytes)?;
        Ok(())
    }

    /// Record a one-time code for `origin`; the code is returned once.
    ///
    /// # Errors
    ///
    /// `InvalidOrigin`, `Full` with [`MAX_PENDING`] codes waiting, or a file
    /// error.
    pub fn issue(&self, origin: &str, now: u64) -> Result<(String, u64), PairingError> {
        if !is_pairable_origin(origin) {
            return Err(PairingError::InvalidOrigin);
        }
        let mut file = self.load()?;
        file.pending.retain(|p| p.expires_at > now);
        if file.pending.len() >= MAX_PENDING {
            return Err(PairingError::Full);
        }
        let code = secret();
        let expires_at = now + CODE_TTL_SECS;
        file.pending.push(Pending {
            code_sha256: digest_hex(&code),
            origin: origin.to_string(),
            expires_at,
        });
        self.save(&file)?;
        Ok((code, expires_at))
    }

    /// Trade `code`, presented from `origin`, for a bearer. The code is spent
    /// whether it was expired, sent from another origin, or traded.
    ///
    /// # Errors
    ///
    /// `Unknown`, `Expired`, `WrongOrigin`, `Full` (the code stays), or a
    /// file error.
    pub fn exchange(&self, code: &str, origin: &str, now: u64) -> Result<Issued, PairingError> {
        let mut file = self.load()?;
        let digest = digest_hex(code);
        let found = find_digest(file.pending.iter().map(|p| p.code_sha256.as_str()), &digest);
        let Some(index) = found.filter(|_| is_secret_shaped(code)) else {
            return Err(PairingError::Unknown);
        };
        if file.pending[index].expires_at > now
            && file.pending[index].origin == origin
            && file.paired.len() >= MAX_PAIRED
        {
            return Err(PairingError::Full);
        }
        let pending = file.pending.remove(index);
        file.pending.retain(|p| p.expires_at > now);
        let outcome = if pending.expires_at <= now {
            Err(PairingError::Expired)
        } else if pending.origin != origin {
            Err(PairingError::WrongOrigin)
        } else {
            let issued = Issued {
                id: pairing_id(),
                origin: pending.origin,
                token: secret(),
            };
            file.paired.push(PairedPage {
                id: issued.id.clone(),
                token_sha256: digest_hex(&issued.token),
                origin: issued.origin.clone(),
                paired_at: now,
            });
            Ok(issued)
        };
        self.save(&file)?;
        outcome
    }

    /// Whether `token`, presented from `origin`, is a paired bearer. An
    /// unreadable file pairs nobody.
    #[must_use]
    pub fn authorizes(&self, token: &str, origin: &str) -> bool {
        if !is_secret_shaped(token) {
            return false;
        }
        let Ok(file) = self.load() else {
            return false;
        };
        let digest = digest_hex(token);
        file.paired.iter().fold(false, |hit, paired| {
            let matches = same(&paired.token_sha256, &digest);
            hit | (matches && paired.origin == origin)
        })
    }

    /// Whether a browser at `origin` may be answered at all: it holds a
    /// bearer, or a code for it is still waiting.
    #[must_use]
    pub fn admits_origin(&self, origin: &str, now: u64) -> bool {
        let Ok(file) = self.load() else {
            return false;
        };
        file.paired.iter().any(|p| p.origin == origin)
            || file
                .pending
                .iter()
                .any(|p| p.origin == origin && p.expires_at > now)
    }

    /// Remove the bearer `token` presented from `origin`; false when it was
    /// not one.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn revoke(&self, token: &str, origin: &str) -> Result<bool, PairingError> {
        if !self.authorizes(token, origin) {
            return Ok(false);
        }
        let mut file = self.load()?;
        let digest = digest_hex(token);
        file.paired
            .retain(|p| !(same(&p.token_sha256, &digest) && p.origin == origin));
        self.save(&file)?;
        Ok(true)
    }

    /// Remove every bearer and waiting code for `origin`, or for every origin
    /// with `None`. Returns how many bearers were removed.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn unpair(&self, origin: Option<&str>) -> Result<usize, PairingError> {
        let mut file = self.load()?;
        let before = file.paired.len();
        let keep = |o: &str| origin.is_some_and(|target| target != o);
        file.paired.retain(|p| keep(&p.origin));
        file.pending.retain(|p| keep(&p.origin));
        let removed = before - file.paired.len();
        self.save(&file)?;
        Ok(removed)
    }

    /// Paired pages and waiting codes, for the operator. Digests stay here.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn list(&self, now: u64) -> Result<(Vec<PairedView>, Vec<PendingView>), PairingError> {
        let file = self.load()?;
        let paired = file
            .paired
            .iter()
            .map(|p| PairedView {
                id: p.id.clone(),
                origin: p.origin.clone(),
                paired_at: p.paired_at,
            })
            .collect();
        let pending = file
            .pending
            .iter()
            .filter(|p| p.expires_at > now)
            .map(|p| PendingView {
                origin: p.origin.clone(),
                expires_at: p.expires_at,
            })
            .collect();
        Ok((paired, pending))
    }
}

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod tests;
