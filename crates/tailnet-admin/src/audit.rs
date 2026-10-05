//! One line per change made through the tailnet routes (ADR 0168 §5).
//!
//! When, which pairing (id, label, origin), the action, the device or key id,
//! and the status that came back. Never a value: no key, no token, no name a
//! person typed. The file keeps its newest [`AUDIT_KEEP`] lines; a reader is
//! handed the newest [`AUDIT_READ`]. Each line rests sealed (`osl1.`, the
//! sealed-log format) under a key in its own 0600 file beside the trail, and
//! every write holds the lock the CLI's device verbs share (ADR 0157).

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use opensesame_sealed_log::{open_line, seal_line, LogKey};

use crate::paths::{create_private, ensure_private_dir, read_optional, write_private, FileLock};
use crate::{AdminError, Paired};

const AUDIT_FILE: &str = "tailnet-admin-audit.jsonl";
const AUDIT_KEY_FILE: &str = "tailnet-admin-audit.key";
/// Lines the file keeps.
pub const AUDIT_KEEP: usize = 2000;
/// Lines a reader is handed.
pub const AUDIT_READ: usize = 200;

/// One recorded change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub at: u64,
    pub pairing: String,
    pub label: String,
    pub origin: String,
    /// `device.authorize`, `key.create`, ….
    pub action: String,
    /// The device or key id the action named; empty when it named none.
    pub target: String,
    /// The status the page was answered with.
    pub status: u16,
}

impl AuditEntry {
    #[must_use]
    pub fn new(at: u64, by: &Paired, action: &str, target: &str, status: u16) -> Self {
        Self {
            at,
            pairing: by.id.clone(),
            label: by.label.clone(),
            origin: by.origin.clone(),
            action: action.to_string(),
            target: target.to_string(),
            status,
        }
    }
}

/// The audit file.
#[derive(Clone, Debug)]
pub struct AuditLog {
    path: PathBuf,
    key: PathBuf,
}

impl AuditLog {
    #[must_use]
    pub fn at(dir: &Path) -> Self {
        Self {
            path: dir.join(AUDIT_FILE),
            key: dir.join(AUDIT_KEY_FILE),
        }
    }

    /// Append one entry, trimming the file to its newest [`AUDIT_KEEP`]
    /// lines once it has grown past half again that.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn append(&self, entry: &AuditEntry) -> Result<(), AdminError> {
        let json = serde_json::to_string(entry)
            .map_err(|error| AdminError::Unreadable(error.to_string()))?;
        if let Some(dir) = self.path.parent() {
            ensure_private_dir(dir)?;
        }
        let _lock = FileLock::acquire(&self.path)?;
        let key = LogKey::load_or_create(&self.key)?;
        let line = format!("{}\n", seal_line(&key, &json));
        let exists = self.path.exists();
        let mut file = if exists {
            std::fs::OpenOptions::new().append(true).open(&self.path)?
        } else {
            create_private(&self.path)?
        };
        file.write_all(line.as_bytes())?;
        drop(file);
        self.trim()
    }

    /// The sealed lines as they rest, oldest first.
    fn lines(&self) -> Result<Vec<String>, AdminError> {
        let Some(bytes) = read_optional(&self.path)? else {
            return Ok(Vec::new());
        };
        Ok(String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_string)
            .collect())
    }

    fn trim(&self) -> Result<(), AdminError> {
        let lines = self.lines()?;
        if lines.len() <= AUDIT_KEEP + AUDIT_KEEP / 2 {
            return Ok(());
        }
        let kept = lines[lines.len() - AUDIT_KEEP..].join("\n") + "\n";
        write_private(&self.path, kept.as_bytes())?;
        Ok(())
    }

    /// The newest `limit` entries (at most [`AUDIT_READ`]), newest first. A
    /// line this build cannot read is skipped, not fatal.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn recent(&self, limit: usize) -> Result<Vec<AuditEntry>, AdminError> {
        let limit = limit.clamp(1, AUDIT_READ);
        let key = match LogKey::load(&self.key) {
            Ok(key) => key,
            // Nothing was ever sealed: there is no trail yet.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        Ok(self
            .lines()?
            .iter()
            .rev()
            .filter_map(|line| open_line(&key, line))
            .filter_map(|line| serde_json::from_str(&line).ok())
            .take(limit)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Role;

    fn by() -> Paired {
        Paired {
            id: "tp_1".into(),
            origin: "https://ops.example.com".into(),
            role: Role::Manage,
            label: "ops".into(),
        }
    }

    #[test]
    fn entries_read_back_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let log = AuditLog::at(tmp.path());
        assert!(log.recent(10).unwrap().is_empty());
        log.append(&AuditEntry::new(1, &by(), "device.authorize", "n1", 200))
            .unwrap();
        log.append(&AuditEntry::new(2, &by(), "device.delete", "n2", 404))
            .unwrap();
        let recent = log.recent(10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].action, "device.delete");
        assert_eq!(recent[0].status, 404);
        assert_eq!(recent[1].pairing, "tp_1");
        assert_eq!(log.recent(1).unwrap().len(), 1);
    }

    #[test]
    fn the_file_keeps_its_newest_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let log = AuditLog::at(tmp.path());
        let total = AUDIT_KEEP + AUDIT_KEEP / 2 + 1;
        for at in 0..total {
            log.append(&AuditEntry::new(at as u64, &by(), "key.create", "k", 200))
                .unwrap();
        }
        assert_eq!(log.lines().unwrap().len(), AUDIT_KEEP);
        assert_eq!(log.recent(1).unwrap()[0].at, (total - 1) as u64);
        assert_eq!(log.recent(10_000).unwrap().len(), AUDIT_READ);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_and_skips_what_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let log = AuditLog::at(tmp.path());
        log.append(&AuditEntry::new(1, &by(), "device.expire", "n", 200))
            .unwrap();
        let path = tmp.path().join(AUDIT_FILE);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"not json\n").unwrap();
        assert_eq!(log.recent(10).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn the_trail_rests_sealed_under_a_private_key_beside_it() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let log = AuditLog::at(tmp.path());
        log.append(&AuditEntry::new(
            7,
            &by(),
            "device.rename",
            "nSECRETID",
            200,
        ))
        .unwrap();
        let rest = std::fs::read_to_string(tmp.path().join(AUDIT_FILE)).unwrap();
        assert!(rest.starts_with("osl1."), "{rest}");
        for plain in ["device.rename", "nSECRETID", "ops.example.com", "tp_1"] {
            assert!(!rest.contains(plain), "{plain} rests in the clear");
        }
        let key = tmp.path().join(AUDIT_KEY_FILE);
        assert_eq!(
            std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(log.recent(1).unwrap()[0].target, "nSECRETID");
        // Without its key the trail reads as nothing, never as an error.
        std::fs::remove_file(&key).unwrap();
        assert!(log.recent(10).unwrap().is_empty());
    }
}
