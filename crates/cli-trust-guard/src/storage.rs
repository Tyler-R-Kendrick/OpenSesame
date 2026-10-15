//! Per-UID root-owned seal and sealing key on disk (helper process only).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use opensesame_cli_app_integration::RootTrustRecord;
use opensesame_sealed_store::{open_osseal, seal_osseal, ItemDataKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

const KEY_LEN: usize = 32;
const ENTRY_NAME: &str = "root-trust";
const FILE_VERSION: u32 = 1;
const MAX_SEAL_BYTES: usize = 8 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RootTrustBody {
    v: u32,
    spki_fingerprint: String,
    enrollment_epoch: u64,
}

pub struct UidStore {
    dir: PathBuf,
}

impl UidStore {
    pub fn for_uid(state_root: &Path, uid: u32) -> Self {
        Self {
            dir: state_root.join(uid.to_string()),
        }
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("root-trust.key")
    }

    fn seal_path(&self) -> PathBuf {
        self.dir.join("root-trust.osseal")
    }

    pub fn open_record(&self) -> Result<OpenOutcome, StoreError> {
        let seal_path = self.seal_path();
        if !seal_path.is_file() {
            return Ok(OpenOutcome::Absent);
        }
        let key = self.read_key()?;
        let blob = read_bounded(&seal_path)?;
        let mut opened = open_osseal(&blob, &key, ENTRY_NAME, None).map_err(|_| StoreError::Unreadable)?;
        let record = record_from_plaintext(&opened.plaintext, opened.revision)?;
        opened.plaintext.zeroize();
        Ok(OpenOutcome::Enrolled(record))
    }

    pub fn seal_record(
        &self,
        fingerprint: &str,
        epoch: u64,
        expected_epoch: u64,
    ) -> Result<(), StoreError> {
        let record = RootTrustRecord::new(fingerprint, epoch).map_err(|_| StoreError::Invalid)?;
        let current = match self.open_record() {
            Ok(OpenOutcome::Absent) => None,
            Ok(OpenOutcome::Enrolled(r)) => Some(r),
            Err(err) => return Err(err),
        };
        match current {
            None if expected_epoch != 0 => return Err(StoreError::Conflict),
            Some(existing) if existing.enrollment_epoch() != expected_epoch => {
                return Err(StoreError::Conflict);
            }
            Some(existing) if epoch != existing.enrollment_epoch() + 1 => {
                return Err(StoreError::Conflict);
            }
            None if epoch != 1 => return Err(StoreError::Conflict),
            _ => {}
        }
        std::fs::create_dir_all(&self.dir).map_err(|_| StoreError::Unreadable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| StoreError::Unreadable)?;
        }
        let key = self.load_or_create_key()?;
        let body = RootTrustBody {
            v: FILE_VERSION,
            spki_fingerprint: record.spki_fingerprint().to_string(),
            enrollment_epoch: record.enrollment_epoch(),
        };
        let plaintext = serde_json::to_vec(&body).map_err(|_| StoreError::Unreadable)?;
        let blob = seal_osseal(&plaintext, &key, ENTRY_NAME, record.enrollment_epoch())
            .map_err(|_| StoreError::Unreadable)?;
        write_private(&self.seal_path(), &blob)?;
        Ok(())
    }

    fn load_or_create_key(&self) -> Result<ItemDataKey, StoreError> {
        let path = self.key_path();
        if path.is_file() {
            return self.read_key();
        }
        let mut raw = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut raw);
        write_private(&path, &raw)?;
        Ok(ItemDataKey(raw))
    }

    fn read_key(&self) -> Result<ItemDataKey, StoreError> {
        let path = self.key_path();
        let bytes = read_bounded(&path)?;
        if bytes.len() != KEY_LEN {
            return Err(StoreError::Unreadable);
        }
        let mut raw = [0u8; KEY_LEN];
        raw.copy_from_slice(&bytes);
        Ok(ItemDataKey(raw))
    }
}

pub enum OpenOutcome {
    Absent,
    Enrolled(RootTrustRecord),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    Unreadable,
    Invalid,
    Conflict,
}

fn record_from_plaintext(plaintext: &[u8], revision: u64) -> Result<RootTrustRecord, StoreError> {
    let body: RootTrustBody =
        serde_json::from_slice(plaintext).map_err(|_| StoreError::Unreadable)?;
    if body.v != FILE_VERSION || body.enrollment_epoch != revision {
        return Err(StoreError::Unreadable);
    }
    RootTrustRecord::new(body.spki_fingerprint, body.enrollment_epoch)
        .map_err(|_| StoreError::Unreadable)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, StoreError> {
    let meta = std::fs::metadata(path).map_err(|_| StoreError::Unreadable)?;
    let len = usize::try_from(meta.len()).map_err(|_| StoreError::Unreadable)?;
    if len > MAX_SEAL_BYTES && path.extension().is_some_and(|e| e == "osseal") {
        return Err(StoreError::Unreadable);
    }
    if path.extension().is_none() && len != KEY_LEN {
        return Err(StoreError::Unreadable);
    }
    std::fs::read(path).map_err(|_| StoreError::Unreadable)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path.parent().ok_or(StoreError::Unreadable)?;
    std::fs::create_dir_all(parent).map_err(|_| StoreError::Unreadable)?;
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|_| StoreError::Unreadable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o400))
            .map_err(|_| StoreError::Unreadable)?;
    }
    file.write_all(bytes).map_err(|_| StoreError::Unreadable)?;
    file.sync_all().map_err(|_| StoreError::Unreadable)?;
    std::fs::rename(tmp, path).map_err(|_| StoreError::Unreadable)?;
    Ok(())
}
