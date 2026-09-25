//! The tailnet vault drive (ADR 0144): Enpass's Wi-Fi Sync Server, reached over
//! Tailscale instead of the local Wi-Fi, and dumber still.
//!
//! A slot holds one opaque snapshot and a generation counter. Devices read it
//! and replace it by compare-and-set, holding the slot's access key; the
//! operator of this machine opens and closes slots. The daemon never sees a
//! vault key and never parses a snapshot beyond checking it claims to be one,
//! so the worst a compromised drive can do is refuse, lose or replay a
//! snapshot — and the merge on each device makes a replay harmless.
//!
//! Only a SHA-256 of each access key is kept. Files are written whole and
//! renamed into place, so a crash leaves the previous generation, never half
//! of the next.
use base64::Engine as _;
use rand_core::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Largest snapshot a slot accepts — a sealed body is kilobytes to a few MiB.
pub const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
/// Slots one daemon keeps; each is a device family's vault, not a device.
pub const MAX_SLOTS: usize = 64;
pub const SNAPSHOT_FORMAT: &str = "opensesame-vault-drive-snapshot";
pub const ENV_DIR: &str = "OPENSESAME_VAULT_DRIVE_DIR";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SlotMeta {
    slot: String,
    label: String,
    key_sha256: String,
    generation: u64,
    created_at: String,
    updated_at: Option<String>,
    bytes: u64,
}

/// What an operator may see about a slot: never its key or its contents.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SlotView {
    pub slot: String,
    pub label: String,
    pub generation: u64,
    pub bytes: u64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

impl From<&SlotMeta> for SlotView {
    fn from(meta: &SlotMeta) -> Self {
        Self {
            slot: meta.slot.clone(),
            label: meta.label.clone(),
            generation: meta.generation,
            bytes: meta.bytes,
            created_at: meta.created_at.clone(),
            updated_at: meta.updated_at.clone(),
        }
    }
}

#[derive(Debug)]
pub enum DriveError {
    /// Unknown slot or wrong key — deliberately indistinguishable.
    Unauthorized,
    /// Someone replaced the snapshot first; carries the current generation.
    Conflict(u64),
    TooLarge,
    Full,
    Invalid(&'static str),
    Io(io::Error),
}

impl From<io::Error> for DriveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub struct DriveStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

/// Where slots live: `$OPENSESAME_VAULT_DRIVE_DIR`, else the user's state dir.
#[must_use]
pub fn default_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(ENV_DIR).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if let Some(state) = std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(state).join("opensesame/vault-drive"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(local).join("OpenSesame").join("vault-drive"));
    }
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(|home| PathBuf::from(home).join(".local/state/opensesame/vault-drive"))
}

/// A slot id this store could have minted: lowercase, hyphens, no path.
#[must_use]
pub fn valid_slot(slot: &str) -> bool {
    (8..=64).contains(&slot.len())
        && slot
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slot.starts_with('-')
}

fn digest_hex(key: &str) -> String {
    use std::fmt::Write as _;
    Sha256::digest(key.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        })
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    {
        let mut file = options.open(&tmp)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)
}

impl DriveStore {
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    fn meta_path(&self, slot: &str) -> PathBuf {
        self.dir.join(format!("{slot}.meta.json"))
    }

    fn snapshot_path(&self, slot: &str) -> PathBuf {
        self.dir.join(format!("{slot}.snapshot.json"))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ensure_dir(&self) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn load(&self, slot: &str) -> Option<SlotMeta> {
        if !valid_slot(slot) {
            return None;
        }
        let bytes = fs::read(self.meta_path(slot)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn save(&self, meta: &SlotMeta) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(meta).map_err(io::Error::other)?;
        write_private(&self.meta_path(&meta.slot), &bytes)
    }

    fn authorized(&self, slot: &str, key: &str) -> Result<SlotMeta, DriveError> {
        let meta = self.load(slot).ok_or(DriveError::Unauthorized)?;
        if same(&meta.key_sha256, &digest_hex(key)) {
            Ok(meta)
        } else {
            Err(DriveError::Unauthorized)
        }
    }

    /// Every slot, newest first, without keys or contents.
    pub fn list(&self) -> io::Result<Vec<SlotView>> {
        let _guard = self.guard();
        let mut views = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(views),
            Err(error) => return Err(error),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(meta) = name.strip_suffix(".meta.json").and_then(|s| self.load(s)) {
                views.push(SlotView::from(&meta));
            }
        }
        views.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(views)
    }

    /// Open a slot; the access key is returned once and never stored.
    pub fn create(&self, label: &str) -> Result<(SlotView, String), DriveError> {
        let label: String = label.trim().chars().take(80).collect();
        if self.list()?.len() >= MAX_SLOTS {
            return Err(DriveError::Full);
        }
        let _guard = self.guard();
        self.ensure_dir()?;
        let mut raw = [0u8; 32];
        rand_core::OsRng.fill_bytes(&mut raw);
        let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        let meta = SlotMeta {
            slot: uuid::Uuid::new_v4().to_string(),
            label,
            key_sha256: digest_hex(&key),
            generation: 0,
            created_at: now(),
            updated_at: None,
            bytes: 0,
        };
        self.save(&meta)?;
        Ok((SlotView::from(&meta), key))
    }

    /// Close a slot and discard its snapshot. False when there was none.
    pub fn remove(&self, slot: &str) -> io::Result<bool> {
        let _guard = self.guard();
        if self.load(slot).is_none() {
            return Ok(false);
        }
        let _ = fs::remove_file(self.snapshot_path(slot));
        fs::remove_file(self.meta_path(slot))?;
        Ok(true)
    }

    /// The slot's generation and snapshot bytes (`None` before the first write).
    pub fn read(&self, slot: &str, key: &str) -> Result<(u64, Option<Vec<u8>>), DriveError> {
        let _guard = self.guard();
        let meta = self.authorized(slot, key)?;
        if meta.generation == 0 {
            return Ok((0, None));
        }
        Ok((meta.generation, Some(fs::read(self.snapshot_path(slot))?)))
    }

    /// Replace the snapshot if nobody else has since `expected`.
    pub fn write(
        &self,
        slot: &str,
        key: &str,
        expected: u64,
        snapshot: &[u8],
    ) -> Result<u64, DriveError> {
        if snapshot.len() > MAX_SNAPSHOT_BYTES {
            return Err(DriveError::TooLarge);
        }
        let _guard = self.guard();
        let mut meta = self.authorized(slot, key)?;
        if meta.generation != expected {
            return Err(DriveError::Conflict(meta.generation));
        }
        write_private(&self.snapshot_path(slot), snapshot)?;
        meta.generation += 1;
        meta.bytes = snapshot.len() as u64;
        meta.updated_at = Some(now());
        self.save(&meta)?;
        Ok(meta.generation)
    }
}

#[cfg(test)]
#[path = "vault_drive_tests.rs"]
mod tests;
