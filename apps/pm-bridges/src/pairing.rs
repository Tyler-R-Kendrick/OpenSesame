//! On-disk pairing state for bridges that authenticate a *client identity*.
//!
//! # What is stored, and what is not
//!
//! Constitution C5: pairing state on disk contains **public keys and metadata
//! only**. An [`Association`] is a client's public identification key, the
//! human-visible name it was paired under, and when that happened. There is
//! no field for a secret, and [`ASSOCIATION_FIELDS`] pins that shape so a
//! future field cannot quietly widen it — `pairing_file_persists_only_public_material`
//! fails the build if it does.
//!
//! Files live under `~/.config/opensesame/bridges/` (XDG on Linux,
//! `~/Library/Application Support` on macOS), overridable with
//! [`ENV_BRIDGES_DIR`] so tests never touch a real profile.
//!
//! # The pairing window
//!
//! [`PairingWindow`] is the C2 approval ceremony, expressed as a small file
//! that two processes share: `opensesame bridge keepassxc pair` opens it on a
//! TTY, the bridge records the fingerprint of an incoming identification key
//! into it, the human confirms or rejects on the TTY, and the bridge reads
//! the verdict back. A closed or expired window means `associate` is refused
//! — there is no path that pairs a client without a person saying yes.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::BridgeError;

/// Override for the bridges config directory (tests, and unusual profiles).
pub const ENV_BRIDGES_DIR: &str = "OPENSESAME_BRIDGES_DIR";

/// Every field an [`Association`] may ever carry. Public material only.
pub const ASSOCIATION_FIELDS: [&str; 4] = ["id", "name", "id_key", "created_at"];

/// Directory holding bridge pairing files.
pub fn bridges_dir() -> Result<PathBuf, BridgeError> {
    if let Some(dir) = std::env::var_os(ENV_BRIDGES_DIR).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let base = directories::BaseDirs::new()
        .ok_or(BridgeError::Unconfigured("HOME"))?
        .config_dir()
        .to_path_buf();
    Ok(base.join("opensesame").join("bridges"))
}

/// A paired client.
///
/// `id_key` is the **public** half of the client's persistent identification
/// keypair, base64 as the client sent it. Nothing here decrypts anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Association {
    /// Identifier the client quotes back on later requests.
    pub id: String,
    /// Human-visible name shown during the pairing ceremony.
    pub name: String,
    /// Base64 public identification key.
    pub id_key: String,
    /// RFC-3339-ish UTC timestamp (seconds since epoch, as a string).
    pub created_at: String,
}

impl Association {
    /// Short, human-comparable fingerprint of the public identification key.
    pub fn fingerprint(&self) -> String {
        key_fingerprint(&self.id_key)
    }
}

/// The persisted pairing file for one bridge.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingFile {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub associations: Vec<Association>,
}

fn one() -> u32 {
    1
}

impl PairingFile {
    pub fn find(&self, id: &str, id_key: &str) -> Option<&Association> {
        self.associations
            .iter()
            .find(|a| a.id == id && a.id_key == id_key)
    }

    pub fn find_by_key(&self, id_key: &str) -> Option<&Association> {
        self.associations.iter().find(|a| a.id_key == id_key)
    }

    /// Insert, replacing any association carrying the same key or id.
    pub fn upsert(&mut self, association: Association) {
        self.associations
            .retain(|a| a.id_key != association.id_key && a.id != association.id);
        self.associations.push(association);
    }
}

/// Path of the pairing file for `bridge` (e.g. `"keepassxc"`).
pub fn pairing_path(bridge: &str) -> Result<PathBuf, BridgeError> {
    Ok(bridges_dir()?.join(format!("{bridge}.json")))
}

/// Read the pairing file; a missing file is an empty one.
pub fn load_pairings(bridge: &str) -> Result<PairingFile, BridgeError> {
    let path = pairing_path(bridge)?;
    if !path.exists() {
        return Ok(PairingFile {
            version: 1,
            associations: Vec::new(),
        });
    }
    let bytes = fs::read(&path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| BridgeError::Store(format!("malformed pairing file: {e}")))
}

/// Write the pairing file, creating the directory if needed.
pub fn save_pairings(bridge: &str, file: &PairingFile) -> Result<(), BridgeError> {
    let path = pairing_path(bridge)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(file)
        .map_err(|e| BridgeError::Store(format!("unserializable pairing file: {e}")))?;
    fs::write(&path, json)?;
    restrict_permissions(&path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// Short fingerprint of a base64 public key, for a human to compare.
///
/// `A1B2:C3D4:E5F6:0708` — eight bytes of SHA-256, which is plenty for a
/// person eyeballing a one-time pairing prompt.
pub fn key_fingerprint(key_b64: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(key_b64.trim().as_bytes());
    let digest = hasher.finalize();
    digest[..8]
        .chunks(2)
        .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
        .collect::<Vec<_>>()
        .join(":")
}

// ——— Pairing window ————————————————————————————————————————————————

/// Default lifetime of a pairing window.
pub const DEFAULT_WINDOW_SECS: u64 = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WindowFile {
    /// `open` | `requested` | `confirmed` | `rejected`
    state: String,
    expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    name: Option<String>,
}

/// Observable state of the pairing window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowState {
    /// No window file: nobody asked to pair.
    Closed,
    /// A human opened a window; no client has knocked yet.
    Open { expires_at: u64 },
    /// A client presented a key; the human has not decided.
    Requested {
        expires_at: u64,
        fingerprint: String,
        name: String,
    },
    /// The human said yes.
    Confirmed { fingerprint: String, name: String },
    /// The human said no.
    Rejected,
    /// The window aged out before a decision.
    Expired,
}

/// The shared pairing-window file for one bridge.
#[derive(Debug, Clone)]
pub struct PairingWindow {
    path: PathBuf,
}

impl PairingWindow {
    pub fn for_bridge(bridge: &str) -> Result<Self, BridgeError> {
        Ok(Self {
            path: bridges_dir()?.join(format!("{bridge}-pairing.json")),
        })
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<Option<WindowFile>, BridgeError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| BridgeError::Store(format!("malformed pairing window: {e}")))
    }

    fn write(&self, file: &WindowFile) -> Result<(), BridgeError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(file)
            .map_err(|e| BridgeError::Store(format!("unserializable pairing window: {e}")))?;
        fs::write(&self.path, json)?;
        restrict_permissions(&self.path);
        Ok(())
    }

    /// Open a window valid for `ttl_secs` from `now`. Overwrites any leftover
    /// state — a new ceremony always starts clean.
    pub fn open(&self, now: u64, ttl_secs: u64) -> Result<(), BridgeError> {
        self.write(&WindowFile {
            state: "open".into(),
            expires_at: now.saturating_add(ttl_secs),
            fingerprint: None,
            name: None,
        })
    }

    /// Record an incoming client key. Only legal while a window is open.
    pub fn request(&self, now: u64, fingerprint: &str, name: &str) -> Result<(), BridgeError> {
        match self.state(now)? {
            WindowState::Open { expires_at } => self.write(&WindowFile {
                state: "requested".into(),
                expires_at,
                fingerprint: Some(fingerprint.to_string()),
                name: Some(name.to_string()),
            }),
            _ => Err(BridgeError::Denied("no pairing window is open")),
        }
    }

    /// The human confirms the pending request.
    pub fn confirm(&self, now: u64) -> Result<(), BridgeError> {
        match self.state(now)? {
            WindowState::Requested {
                fingerprint, name, ..
            } => self.write(&WindowFile {
                state: "confirmed".into(),
                // A confirmed verdict does not age out: the bridge is already
                // waiting on it and consumes it immediately.
                expires_at: u64::MAX,
                fingerprint: Some(fingerprint),
                name: Some(name),
            }),
            _ => Err(BridgeError::Denied("no pairing request is pending")),
        }
    }

    /// The human rejects the pending request (or closes the window early).
    pub fn reject(&self) -> Result<(), BridgeError> {
        self.write(&WindowFile {
            state: "rejected".into(),
            expires_at: u64::MAX,
            fingerprint: None,
            name: None,
        })
    }

    /// Remove the window file entirely.
    pub fn close(&self) -> Result<(), BridgeError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(BridgeError::Io(e)),
        }
    }

    /// Current state, applying expiry at `now`.
    pub fn state(&self, now: u64) -> Result<WindowState, BridgeError> {
        let Some(file) = self.read()? else {
            return Ok(WindowState::Closed);
        };
        if now > file.expires_at {
            return Ok(WindowState::Expired);
        }
        Ok(match file.state.as_str() {
            "open" => WindowState::Open {
                expires_at: file.expires_at,
            },
            "requested" => WindowState::Requested {
                expires_at: file.expires_at,
                fingerprint: file.fingerprint.unwrap_or_default(),
                name: file.name.unwrap_or_default(),
            },
            "confirmed" => WindowState::Confirmed {
                fingerprint: file.fingerprint.unwrap_or_default(),
                name: file.name.unwrap_or_default(),
            },
            "rejected" => WindowState::Rejected,
            _ => WindowState::Closed,
        })
    }
}

/// Run `f` with [`ENV_BRIDGES_DIR`] pointed at a fresh tempdir.
///
/// The env var is process-global, so every test that touches the pairing
/// directory serializes on one lock rather than racing.
#[cfg(test)]
pub(crate) fn with_bridges_dir<T>(f: impl FnOnce() -> T) -> T {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var(ENV_BRIDGES_DIR, dir.path());
    let out = f();
    std::env::remove_var(ENV_BRIDGES_DIR);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> (tempfile::TempDir, PairingWindow) {
        let dir = tempfile::tempdir().unwrap();
        let w = PairingWindow::at(dir.path().join("keepassxc-pairing.json"));
        (dir, w)
    }

    #[test]
    fn window_starts_closed() {
        let (_d, w) = window();
        assert_eq!(w.state(100).unwrap(), WindowState::Closed);
    }

    #[test]
    fn open_then_expire() {
        let (_d, w) = window();
        w.open(100, 60).unwrap();
        assert_eq!(w.state(120).unwrap(), WindowState::Open { expires_at: 160 });
        assert_eq!(w.state(161).unwrap(), WindowState::Expired);
    }

    #[test]
    fn open_request_confirm() {
        let (_d, w) = window();
        w.open(100, 60).unwrap();
        w.request(110, "AAAA:BBBB:CCCC:DDDD", "firefox").unwrap();
        assert_eq!(
            w.state(120).unwrap(),
            WindowState::Requested {
                expires_at: 160,
                fingerprint: "AAAA:BBBB:CCCC:DDDD".into(),
                name: "firefox".into(),
            }
        );
        w.confirm(120).unwrap();
        assert_eq!(
            w.state(9_999_999).unwrap(),
            WindowState::Confirmed {
                fingerprint: "AAAA:BBBB:CCCC:DDDD".into(),
                name: "firefox".into(),
            }
        );
    }

    #[test]
    fn open_request_reject() {
        let (_d, w) = window();
        w.open(100, 60).unwrap();
        w.request(110, "F", "chrome").unwrap();
        w.reject().unwrap();
        assert_eq!(w.state(120).unwrap(), WindowState::Rejected);
    }

    #[test]
    fn request_without_an_open_window_is_denied() {
        let (_d, w) = window();
        assert!(matches!(
            w.request(100, "F", "n"),
            Err(BridgeError::Denied(_))
        ));
        w.open(100, 60).unwrap();
        assert!(matches!(
            w.request(200, "F", "n"),
            Err(BridgeError::Denied(_))
        ));
    }

    #[test]
    fn confirm_without_a_request_is_denied() {
        let (_d, w) = window();
        assert!(matches!(w.confirm(100), Err(BridgeError::Denied(_))));
        w.open(100, 60).unwrap();
        assert!(matches!(w.confirm(110), Err(BridgeError::Denied(_))));
    }

    #[test]
    fn a_second_request_after_confirm_is_denied() {
        let (_d, w) = window();
        w.open(100, 60).unwrap();
        w.request(110, "F1", "a").unwrap();
        w.confirm(115).unwrap();
        // The window is spent: a second client cannot ride the same yes.
        assert!(matches!(
            w.request(120, "F2", "b"),
            Err(BridgeError::Denied(_))
        ));
    }

    #[test]
    fn close_is_idempotent() {
        let (_d, w) = window();
        w.close().unwrap();
        w.open(100, 60).unwrap();
        w.close().unwrap();
        assert_eq!(w.state(100).unwrap(), WindowState::Closed);
    }

    #[test]
    fn malformed_window_file_is_an_error_not_a_panic() {
        let (dir, w) = window();
        fs::write(dir.path().join("keepassxc-pairing.json"), b"{oops").unwrap();
        assert!(w.state(100).is_err());
    }

    // ——— pairing file ————————————————————————————————————————————

    fn sample() -> Association {
        Association {
            id: "opensesame-1".into(),
            name: "firefox".into(),
            id_key: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=".into(), // gitleaks:allow -- decodes to "1234...32", test pairing fixture
            created_at: "1750000000".into(),
        }
    }

    #[test]
    fn pairing_file_round_trips() {
        with_bridges_dir(|| {
            assert!(load_pairings("keepassxc").unwrap().associations.is_empty());
            let mut file = load_pairings("keepassxc").unwrap();
            file.upsert(sample());
            save_pairings("keepassxc", &file).unwrap();

            let back = load_pairings("keepassxc").unwrap();
            assert_eq!(back.associations, vec![sample()]);
            assert!(back.find("opensesame-1", &sample().id_key).is_some());
            assert!(back.find("opensesame-1", "other-key").is_none());
            assert!(back.find_by_key(&sample().id_key).is_some());
        });
    }

    #[test]
    fn upsert_replaces_a_matching_id_or_key() {
        let mut file = PairingFile::default();
        file.upsert(sample());
        let mut renamed = sample();
        renamed.name = "chrome".into();
        file.upsert(renamed.clone());
        assert_eq!(file.associations, vec![renamed]);
    }

    #[test]
    fn pairing_file_persists_only_public_material() {
        with_bridges_dir(|| {
            let mut file = PairingFile::default();
            file.upsert(sample());
            save_pairings("keepassxc", &file).unwrap();

            let raw = fs::read_to_string(pairing_path("keepassxc").unwrap()).unwrap();
            let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let entry = &value["associations"][0];
            let keys: Vec<&str> = entry.as_object().unwrap().keys().map(|k| k.as_str()).collect();
            for key in &keys {
                assert!(
                    ASSOCIATION_FIELDS.contains(key),
                    "pairing file gained a non-public field: {key}"
                );
            }
            // Belt and braces: nothing that smells like secret material.
            let lowered = raw.to_lowercase();
            for banned in ["secret", "password", "passphrase", "private", "seed"] {
                assert!(!lowered.contains(banned), "pairing file mentions {banned}");
            }
        });
    }

    #[test]
    fn malformed_pairing_file_is_an_error_not_a_panic() {
        with_bridges_dir(|| {
            let path = pairing_path("keepassxc").unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"[]not json").unwrap();
            assert!(load_pairings("keepassxc").is_err());
        });
    }

    #[test]
    fn fingerprints_are_stable_short_and_key_scoped() {
        let a = key_fingerprint("AAAA");
        assert_eq!(a, key_fingerprint(" AAAA "));
        assert_ne!(a, key_fingerprint("BBBB"));
        assert_eq!(a.len(), 19);
        assert_eq!(sample().fingerprint(), key_fingerprint(&sample().id_key));
    }
}
