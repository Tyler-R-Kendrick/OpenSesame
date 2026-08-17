//! Seal a Pages "store path manifest" into ciphertext entries.
//!
//! The Pages Settings panel exports a plaintext JSON array of
//! `{ path, secret, trailer }` (see `apps/pages/src/lib/vault/store-sync.ts`).
//! This module is the missing half of that bridge (ADR 0037 §6): it turns the
//! manifest into encrypted store entries and one git commit, so plaintext
//! never needs to be committed anywhere.

use opensesame_human_vault::ItemDataKey;
use serde::Deserialize;

use crate::git::auto_commit;
use crate::{Entry, StoreError, StoreRoot};

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub secret: String,
    #[serde(default)]
    pub trailer: String,
}

#[derive(Debug, Default)]
pub struct SealOutcome {
    pub sealed: usize,
    /// Logical names that already existed and were left untouched
    /// (empty when sealing with `replace`).
    pub skipped: Vec<String>,
    /// Entries whose paths were invalid, with the reason.
    pub rejected: Vec<(String, String)>,
}

pub fn parse_manifest(json: &str) -> Result<Vec<ManifestEntry>, StoreError> {
    serde_json::from_str(json)
        .map_err(|e| StoreError::Other(format!("manifest must be a JSON array of entries: {e}")))
}

/// Seal every manifest entry into the store under `key`, then record a single
/// commit. Existing entries are skipped unless `replace` is set.
pub fn seal_manifest(
    root: &StoreRoot,
    key: &ItemDataKey,
    entries: &[ManifestEntry],
    replace: bool,
) -> Result<SealOutcome, StoreError> {
    let mut outcome = SealOutcome::default();
    let existing = root.ls("")?;
    for manifest_entry in entries {
        let name = manifest_entry.path.trim().trim_matches('/').to_string();
        let entry = Entry {
            secret: manifest_entry.secret.clone(),
            trailer: manifest_entry.trailer.clone(),
        };
        if existing.iter().any(|n| n == &name) && !replace {
            outcome.skipped.push(name);
            continue;
        }
        match root.write_entry_unchecked(&name, &entry, key) {
            Ok(()) => outcome.sealed += 1,
            Err(StoreError::InvalidPath(reason)) => {
                outcome.rejected.push((name, reason));
            }
            Err(other) => return Err(other),
        }
    }
    if outcome.sealed > 0 {
        auto_commit(
            &root.path,
            &format!(
                "Seal {} manifest {}",
                outcome.sealed,
                if outcome.sealed == 1 { "entry" } else { "entries" }
            ),
        )?;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_store;

    #[test]
    fn seals_entries_skips_existing_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = ItemDataKey([3u8; 32]);
        root.insert(
            "Dev/existing",
            &Entry {
                secret: "old".into(),
                trailer: String::new(),
            },
            &key,
        )
        .unwrap();

        let entries = parse_manifest(
            r#"[
                {"path": "Dev/new", "secret": "n3w", "trailer": "{\"kind\":\"login\"}\n"},
                {"path": "Dev/existing", "secret": "clobber"},
                {"path": "../escape", "secret": "x"}
            ]"#,
        )
        .unwrap();
        let outcome = seal_manifest(&root, &key, &entries, false).unwrap();
        assert_eq!(outcome.sealed, 1);
        assert_eq!(outcome.skipped, vec!["Dev/existing".to_string()]);
        assert_eq!(outcome.rejected.len(), 1);
        assert_eq!(root.show("Dev/existing", &key).unwrap().secret, "old");
        let sealed = root.show("Dev/new", &key).unwrap();
        assert_eq!(sealed.secret, "n3w");
        assert!(sealed.trailer.contains("login"));

        // replace overwrites
        let outcome = seal_manifest(&root, &key, &entries[1..2].to_vec(), true).unwrap();
        assert_eq!(outcome.sealed, 1);
        assert_eq!(root.show("Dev/existing", &key).unwrap().secret, "clobber");
    }

    #[test]
    fn rejects_non_array_manifest() {
        assert!(parse_manifest(r#"{"path": "a"}"#).is_err());
    }
}
