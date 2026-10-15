//! Sealed trust store for the enrolled daemon root trust key.
//!
//! The enrolled record is loaded through the root-owned
//! [`opensesame_cli_trust_guard`] when its socket is present (or required).
//! Legacy user-state seals remain for tests only when the guard is not
//! configured. Startup calls `mark_root_key_enrolled`. A missing store leaves
//! the key unenrolled. An unreadable store fails closed.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use opensesame_cli_app_integration::{CliAppIntegrationHost, RootTrustRecord};
use opensesame_cli_trust_guard::{
    guard_required, open_via_guard, seal_via_guard, socket_path_from_env, GuardError, GuardOpen,
    DEFAULT_SOCKET_PATH,
};
use opensesame_sealed_store::{open_osseal, seal_osseal, ItemDataKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

const STORE_DIR: &str = "cli-app-integration";
const SEAL_NAME: &str = "root-trust.osseal";
const KEY_NAME: &str = "root-trust.key";
const ENTRY_NAME: &str = "root-trust";
const FILE_VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const MAX_SEAL_BYTES: usize = 8 * 1024;

/// Where the daemon looks for state: `OPENSESAME_STATE_DIR`, else the usual
/// per-user state directory (the same fallback fill uses).
pub(crate) fn daemon_state_dir() -> Option<PathBuf> {
    let explicit = env_path("OPENSESAME_STATE_DIR");
    let xdg = env_path("XDG_STATE_HOME");
    let local = env_path("LOCALAPPDATA");
    let home = env_path("HOME");
    resolve_state_dir(&StateLocation {
        explicit: explicit.as_deref(),
        xdg_state_home: xdg.as_deref(),
        local_app_data: local.as_deref(),
        home: home.as_deref(),
    })
}

#[derive(Clone, Copy)]
struct StateLocation<'a> {
    explicit: Option<&'a Path>,
    xdg_state_home: Option<&'a Path>,
    local_app_data: Option<&'a Path>,
    home: Option<&'a Path>,
}

fn resolve_state_dir(loc: &StateLocation<'_>) -> Option<PathBuf> {
    if let Some(dir) = loc.explicit {
        return Some(dir.to_path_buf());
    }
    if let Some(state) = loc.xdg_state_home {
        return Some(state.join("opensesame"));
    }
    if let Some(local) = loc.local_app_data {
        return Some(local.join("OpenSesame"));
    }
    loc.home.map(|home| home.join(".local/state/opensesame"))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[derive(Debug)]
pub(crate) enum TrustStoreError {
    Unreadable,
    Io(io::Error),
}

impl std::fmt::Display for TrustStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => f.write_str("cli root trust store is unreadable"),
            Self::Io(err) => write!(f, "cli root trust store: {err}"),
        }
    }
}

impl std::error::Error for TrustStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Unreadable => None,
        }
    }
}

impl From<io::Error> for TrustStoreError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

pub(crate) enum LoadOutcome {
    Absent,
    Enrolled(RootTrustRecord),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RootTrustBody {
    v: u32,
    spki_fingerprint: String,
    enrollment_epoch: u64,
}

fn trust_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(STORE_DIR)
}

/// Load the enrolled root trust record. A missing seal is [`LoadOutcome::Absent`].
///
/// # Errors
///
/// Returns [`TrustStoreError`] when the seal or key cannot be opened, or the
/// plaintext is not a version-1 record bound to the seal revision.
pub(crate) fn effective_guard_socket() -> Option<PathBuf> {
    socket_path_from_env().or_else(|| {
        let path = PathBuf::from(DEFAULT_SOCKET_PATH);
        path.exists().then_some(path)
    })
}

pub(crate) fn load(state_dir: &Path) -> Result<LoadOutcome, TrustStoreError> {
    if let Some(socket) = effective_guard_socket() {
        return match open_via_guard(&socket) {
            Ok(GuardOpen::Absent) => Ok(LoadOutcome::Absent),
            Ok(GuardOpen::Enrolled(record)) => Ok(LoadOutcome::Enrolled(record)),
            Err(GuardError::Unavailable | GuardError::Unreadable | GuardError::Conflict) => {
                Err(TrustStoreError::Unreadable)
            }
            Err(GuardError::Invalid) => Err(TrustStoreError::Unreadable),
        };
    }
    if guard_required() {
        return Err(TrustStoreError::Unreadable);
    }
    load_legacy(state_dir)
}

fn load_legacy(state_dir: &Path) -> Result<LoadOutcome, TrustStoreError> {
    let dir = trust_dir(state_dir);
    let seal_path = dir.join(SEAL_NAME);
    if !seal_path.is_file() {
        return Ok(LoadOutcome::Absent);
    }
    let key = read_key(&dir.join(KEY_NAME))?;
    let blob = read_seal(&seal_path)?;
    let mut opened =
        open_osseal(&blob, &key, ENTRY_NAME, None).map_err(|_| TrustStoreError::Unreadable)?;
    let record = record_from_parts(&opened.plaintext, opened.revision);
    opened.plaintext.zeroize();
    record.map(LoadOutcome::Enrolled)
}

/// Seal `record` under `state_dir`, reusing the existing key when one is present.
///
/// PAKE enrollment calls this after key confirmation. Startup loads the record
/// and marks the root key enrolled.
///
/// # Errors
///
/// Returns [`TrustStoreError`] when the directory or files cannot be written,
/// or the record cannot be sealed.
pub(crate) fn save(state_dir: &Path, record: &RootTrustRecord) -> Result<(), TrustStoreError> {
    if let Some(socket) = effective_guard_socket() {
        let expected = record
            .enrollment_epoch()
            .checked_sub(1)
            .unwrap_or(0);
        return match seal_via_guard(&socket, record, expected) {
            Ok(()) => Ok(()),
            Err(GuardError::Unavailable | GuardError::Unreadable | GuardError::Conflict) => {
                Err(TrustStoreError::Unreadable)
            }
            Err(GuardError::Invalid) => Err(TrustStoreError::Unreadable),
        };
    }
    if guard_required() {
        return Err(TrustStoreError::Unreadable);
    }
    save_legacy(state_dir, record)
}

fn save_legacy(state_dir: &Path, record: &RootTrustRecord) -> Result<(), TrustStoreError> {
    let dir = trust_dir(state_dir);
    ensure_private_dir(&dir)?;
    let key = load_or_create_key(&dir.join(KEY_NAME))?;
    let blob = seal_record(record, &key)?;
    write_private(&dir.join(SEAL_NAME), &blob)
}

/// Load the store and mark the host's root trust key enrolled when a record is present.
pub(crate) fn apply_at_startup(host: &mut CliAppIntegrationHost, state_dir: &Path) {
    match load(state_dir) {
        Ok(LoadOutcome::Enrolled(record)) => {
            let epoch = record.enrollment_epoch();
            host.pairings.mark_root_key_enrolled(record);
            tracing::info!(epoch, "cli root trust key enrolled from store");
        }
        Ok(LoadOutcome::Absent) => {}
        Err(err) => {
            tracing::warn!(%err, "cli root trust store unreadable; root key stays unenrolled");
        }
    }
}

fn record_from_parts(
    plaintext: &[u8],
    seal_revision: u64,
) -> Result<RootTrustRecord, TrustStoreError> {
    let body: RootTrustBody =
        serde_json::from_slice(plaintext).map_err(|_| TrustStoreError::Unreadable)?;
    if body.v != FILE_VERSION || body.enrollment_epoch != seal_revision {
        return Err(TrustStoreError::Unreadable);
    }
    RootTrustRecord::new(body.spki_fingerprint, body.enrollment_epoch)
        .map_err(|_| TrustStoreError::Unreadable)
}

fn seal_record(record: &RootTrustRecord, key: &ItemDataKey) -> Result<Vec<u8>, TrustStoreError> {
    let body = RootTrustBody {
        v: FILE_VERSION,
        spki_fingerprint: record.spki_fingerprint().to_string(),
        enrollment_epoch: record.enrollment_epoch(),
    };
    let plaintext = serde_json::to_vec(&body).map_err(|_| TrustStoreError::Unreadable)?;
    seal_osseal(&plaintext, key, ENTRY_NAME, record.enrollment_epoch())
        .map_err(|_| TrustStoreError::Unreadable)
}

fn ensure_private_dir(dir: &Path) -> Result<(), TrustStoreError> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn load_or_create_key(path: &Path) -> Result<ItemDataKey, TrustStoreError> {
    if path.exists() {
        return read_key(path);
    }
    let mut raw = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut raw);
    let written = write_private(path, &raw);
    let key = ItemDataKey(raw);
    raw.zeroize();
    written?;
    Ok(key)
}

fn read_key(path: &Path) -> Result<ItemDataKey, TrustStoreError> {
    let meta = std::fs::metadata(path)?;
    if usize::try_from(meta.len()).ok() != Some(KEY_LEN) {
        return Err(TrustStoreError::Unreadable);
    }
    let mut bytes = std::fs::read(path)?;
    if bytes.len() != KEY_LEN {
        bytes.zeroize();
        return Err(TrustStoreError::Unreadable);
    }
    let mut raw = [0u8; KEY_LEN];
    raw.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(ItemDataKey(raw))
}

fn read_seal(path: &Path) -> Result<Vec<u8>, TrustStoreError> {
    let meta = std::fs::metadata(path)?;
    let Ok(len) = usize::try_from(meta.len()) else {
        return Err(TrustStoreError::Unreadable);
    };
    if !seal_len_ok(len) {
        return Err(TrustStoreError::Unreadable);
    }
    let bytes = std::fs::read(path)?;
    if !seal_len_ok(bytes.len()) {
        return Err(TrustStoreError::Unreadable);
    }
    Ok(bytes)
}

fn seal_len_ok(len: usize) -> bool {
    (1..=MAX_SEAL_BYTES).contains(&len)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), TrustStoreError> {
    let tmp = temporary_path(path).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "trust store path has no file name",
        )
    })?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn temporary_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?;
    let mut tmp_name = name.to_os_string();
    tmp_name.push(".tmp");
    Some(path.with_file_name(tmp_name))
}

#[cfg(test)]
#[path = "root_trust_tests.rs"]
mod tests;
