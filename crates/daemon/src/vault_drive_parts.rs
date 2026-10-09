//! File parts beside a slot's snapshot (ADR 0144).
//!
//! An attachment in a vault is a manifest inside the sealed body — which the
//! snapshot carries — and encrypted parts of at most a MiB each, which it does
//! not. A device puts each part here under the key its manifest names and a
//! device that lacks one reads it back; the key to open it never leaves the
//! manifest, so the drive holds ciphertext it cannot read, as with snapshots.
//!
//! Parts are immutable: a key names one part forever, so a second put of the
//! same key is a no-op rather than a replacement, and nothing a device sends
//! can change a part another device already relies on. The drive cannot tell
//! which parts a vault still uses, so it never deletes one on its own; closing
//! the slot removes them all, and a per-slot quota bounds what one can hold.
use super::{write_private, DriveError, DriveStore};
use std::{fs, io, path::PathBuf};

/// A part is at most a MiB of ciphertext and its GCM tag.
pub const MAX_PART_BYTES: usize = 1024 * 1024 + 1024;
/// What one slot's parts may add up to.
pub const MAX_PARTS_BYTES_PER_SLOT: u64 = 4 * 1024 * 1024 * 1024;

/// A part key as `file-parts.ts` mints one: 16 URL-safe base64 characters.
#[must_use]
pub fn valid_part(part: &str) -> bool {
    part.len() == 16
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl DriveStore {
    pub(crate) fn parts_dir(&self, slot: &str) -> PathBuf {
        self.dir.join(format!("{slot}.parts"))
    }

    /// Store a part. A part already held under `part` is left as it is.
    pub fn put_part(
        &self,
        slot: &str,
        key: &str,
        part: &str,
        bytes: &[u8],
    ) -> Result<(), DriveError> {
        if !valid_part(part) {
            return Err(DriveError::Invalid("bad_part_key"));
        }
        if bytes.is_empty() || bytes.len() > MAX_PART_BYTES {
            return Err(DriveError::TooLarge);
        }
        let _guard = self.guard();
        let mut meta = self.authorized(slot, key)?;
        let path = self.parts_dir(slot).join(part);
        if path.exists() {
            return Ok(());
        }
        let size = bytes.len() as u64;
        if meta.parts_bytes.saturating_add(size) > MAX_PARTS_BYTES_PER_SLOT {
            return Err(DriveError::PartsFull);
        }
        self.ensure_dir()?;
        fs::create_dir_all(self.parts_dir(slot))?;
        write_private(&path, bytes)?;
        meta.parts_bytes += size;
        self.save(&meta)?;
        Ok(())
    }

    /// A part's bytes, or `None` when the slot holds no such part.
    pub fn get_part(
        &self,
        slot: &str,
        key: &str,
        part: &str,
    ) -> Result<Option<Vec<u8>>, DriveError> {
        if !valid_part(part) {
            return Err(DriveError::Invalid("bad_part_key"));
        }
        let _guard = self.guard();
        self.authorized(slot, key)?;
        match fs::read(self.parts_dir(slot).join(part)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Every part key the slot holds, sorted.
    pub fn list_parts(&self, slot: &str, key: &str) -> Result<Vec<String>, DriveError> {
        let _guard = self.guard();
        self.authorized(slot, key)?;
        let entries = match fs::read_dir(self.parts_dir(slot)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut parts: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| valid_part(name))
            .collect();
        parts.sort();
        Ok(parts)
    }
}

#[cfg(test)]
#[path = "vault_drive_parts_tests.rs"]
mod tests;
