//! KDBX → sealed store.

use std::collections::{BTreeMap, HashSet};
use std::io::Cursor;

use keepass::db::{Database, GroupId};
use keepass::DatabaseKey;
use opensesame_sealed_store::{ItemDataKey, StoreError, StoreRoot};
use serde::Serialize;
use zeroize::Zeroize;

use crate::map::{
    self, KdbxEntryView, MapWarning, MappedItem, PathAllocator, MAX_GROUP_DEPTH,
};
use crate::KdbxError;

/// The four bytes every KDBX file starts with (`0x9AA2D903`, little-endian).
pub(crate) const KDBX_MAGIC: [u8; 4] = [0x03, 0xd9, 0xa2, 0x9a];

/// Options for [`import_kdbx`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportOptions {
    /// Store path prefix every imported entry is placed under.
    pub prefix: Option<String>,
    /// Overwrite store entries whose content differs from the KDBX entry.
    /// Entries that already match are never rewritten, with or without this.
    pub replace: bool,
}

impl ImportOptions {
    /// Place imported entries under `prefix`.
    #[must_use]
    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.prefix = Some(prefix.into());
        self
    }

    /// Overwrite differing store entries.
    #[must_use]
    pub fn replacing(mut self) -> Self {
        self.replace = true;
        self
    }
}

/// Why an item was not written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// A different entry already lives at this path and `replace` was not set.
    Conflict,
}

/// An item the import declined to write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkippedItem {
    /// The store path that was not written.
    pub path: String,
    /// Why.
    pub reason: SkipReason,
}

/// A warning attached to a store path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ItemWarning {
    /// The store path (or group path, for structural warnings).
    pub path: String,
    /// What happened.
    pub warning: MapWarning,
}

/// What happened to one item during the merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// The path was free; the entry was written.
    Created,
    /// The path held a different entry; it was overwritten.
    Updated,
    /// The path already held exactly this entry; nothing was written.
    Unchanged,
    /// The path held a different entry and `replace` was not set.
    Skipped(SkipReason),
}

/// What an import did, path by path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportSummary {
    /// Paths written that did not exist before.
    pub created: Vec<String>,
    /// Paths overwritten.
    pub updated: Vec<String>,
    /// Paths that already matched and were left alone.
    pub unchanged: Vec<String>,
    /// Paths not written.
    pub skipped: Vec<SkippedItem>,
    /// Non-fatal mapping observations, in traversal order.
    pub warnings: Vec<ItemWarning>,
}

impl ImportSummary {
    /// Number of KDBX entries the import accounted for.
    #[must_use]
    pub fn total(&self) -> usize {
        self.created.len() + self.updated.len() + self.unchanged.len() + self.skipped.len()
    }

    /// Whether the import changed the store.
    #[must_use]
    pub fn changed(&self) -> bool {
        !self.created.is_empty() || !self.updated.is_empty()
    }
}

/// Open a KDBX database and map it, without touching any store.
///
/// This is the read half of [`import_kdbx`]: the fuzz target and the
/// conformance fixture both drive it. Items come back in traversal order —
/// each group's own entries first, then its subgroups, both in KDBX document
/// order — with collision suffixes already applied.
///
/// `password` of `Some("")` means "an empty password is a key component";
/// `None` means "there is no password component". Supplying neither a
/// password nor a keyfile is [`KdbxError::MissingCredentials`].
pub fn map_kdbx(
    bytes: &[u8],
    password: Option<&str>,
    keyfile: Option<&[u8]>,
    prefix: Option<&str>,
) -> Result<(Vec<MappedItem>, Vec<ItemWarning>), KdbxError> {
    let db = open_database(bytes, password, keyfile)?;
    let (views, mut warnings) = collect_views(&db);
    let prefix_segments = map::sanitize_prefix(prefix);
    let mut allocator = PathAllocator::new();
    let mut items = Vec::with_capacity(views.len());

    for view in &views {
        let mapped = map::map_entry(view);
        let desired = if prefix_segments.is_empty() {
            mapped.desired_path.clone()
        } else {
            format!("{}/{}", prefix_segments.join("/"), mapped.desired_path)
        };
        let path = allocator.allocate(&desired);
        let mut item_warnings = mapped.warnings;
        if path != desired {
            item_warnings.push(MapWarning::PathCollision {
                desired: desired.clone(),
                assigned: path.clone(),
            });
        }
        for warning in &item_warnings {
            warnings.push(ItemWarning {
                path: path.clone(),
                warning: warning.clone(),
            });
        }
        items.push(MappedItem {
            path,
            entry: mapped.entry,
            warnings: item_warnings,
        });
    }

    Ok((items, warnings))
}

/// Read a KDBX database and merge it into `root`, keyed by store path.
///
/// The merge is idempotent: an entry whose rendered plaintext already matches
/// the store is reported `unchanged` and never rewritten, so re-importing the
/// same file leaves the store — including its anti-rollback revisions —
/// untouched. A path that holds *different* content is overwritten only when
/// [`ImportOptions::replace`] is set; otherwise it is skipped.
pub fn import_kdbx(
    bytes: &[u8],
    password: Option<&str>,
    keyfile: Option<&[u8]>,
    root: &StoreRoot,
    key: &ItemDataKey,
    opts: ImportOptions,
) -> Result<ImportSummary, KdbxError> {
    let (items, warnings) = map_kdbx(bytes, password, keyfile, opts.prefix.as_deref())?;
    let mut summary = ImportSummary {
        warnings,
        ..Default::default()
    };

    for item in &items {
        match merge_one(root, key, &item.path, &item.entry, opts.replace)? {
            MergeOutcome::Created => summary.created.push(item.path.clone()),
            MergeOutcome::Updated => summary.updated.push(item.path.clone()),
            MergeOutcome::Unchanged => summary.unchanged.push(item.path.clone()),
            MergeOutcome::Skipped(reason) => summary.skipped.push(SkippedItem {
                path: item.path.clone(),
                reason,
            }),
        }
    }

    Ok(summary)
}

fn merge_one(
    root: &StoreRoot,
    key: &ItemDataKey,
    path: &str,
    entry: &opensesame_sealed_store::Entry,
    replace: bool,
) -> Result<MergeOutcome, KdbxError> {
    match root.show(path, key) {
        Ok(existing) => {
            // Compared canonically, not by rendered text: `sealed_store::Entry`'s
            // render/parse pair is a 2-cycle rather than a fixed point (parsing
            // a rendered entry keeps the blank separator line inside the
            // trailer; rendering that again drops it), so raw text would report
            // a spurious difference on every second generation and break
            // idempotency.
            let mut current = map::item_json(&existing);
            let mut incoming = map::item_json(entry);
            let same = current == incoming;
            zeroize_item(&mut current);
            zeroize_item(&mut incoming);
            if same {
                Ok(MergeOutcome::Unchanged)
            } else if replace {
                root.insert_or_replace(path, entry, key)?;
                Ok(MergeOutcome::Updated)
            } else {
                Ok(MergeOutcome::Skipped(SkipReason::Conflict))
            }
        }
        Err(StoreError::NotFound(_)) => {
            root.insert_or_replace(path, entry, key)?;
            Ok(MergeOutcome::Created)
        }
        Err(other) => Err(other.into()),
    }
}

/// Wipe the plaintext a canonical comparison copied out of the store.
fn zeroize_item(item: &mut map::ItemJson) {
    item.secret.zeroize();
    for line in &mut item.trailer {
        line.zeroize();
    }
    if let Some(otp) = &mut item.otp {
        otp.zeroize();
    }
}

/// Open a KDBX database, classifying failures without echoing key material.
fn open_database(
    bytes: &[u8],
    password: Option<&str>,
    keyfile: Option<&[u8]>,
) -> Result<Database, KdbxError> {
    if bytes.len() < 12 || bytes.get(..4) != Some(&KDBX_MAGIC[..]) {
        return Err(KdbxError::NotKdbx(
            "missing the KDBX file signature".to_string(),
        ));
    }
    if password.is_none() && keyfile.is_none() {
        return Err(KdbxError::MissingCredentials);
    }
    // The KDF runs before anything in the file is authenticated, so hostile
    // work factors are screened out of the header first.
    crate::limits::check_kdf_limits(bytes)?;

    let mut db_key = DatabaseKey::new();
    if let Some(password) = password {
        db_key = db_key.with_password(password);
    }
    if let Some(keyfile) = keyfile {
        db_key = db_key
            .with_keyfile(&mut Cursor::new(keyfile))
            .map_err(|e| KdbxError::Malformed(format!("keyfile: {e}")))?;
    }

    Database::parse(bytes, db_key).map_err(classify_open_error)
}

fn classify_open_error(err: keepass::db::DatabaseOpenError) -> KdbxError {
    use keepass::db::DatabaseOpenError as E;
    match err {
        E::Io(e) => KdbxError::NotKdbx(format!("truncated: {e}")),
        E::UnexpectedEof => KdbxError::NotKdbx("truncated".to_string()),
        // The signature was checked before parsing, so anything left here is a
        // recognizable KeePass file of a version this bridge does not handle.
        E::VersionParse(e) => KdbxError::UnsupportedVersion(e.to_string()),
        E::UnsupportedVersion => {
            KdbxError::UnsupportedVersion("only KDBX 3 and 4 are supported".to_string())
        }
        E::Key(_) | E::Cryptography(_) => KdbxError::Locked,
        E::Format(e) => KdbxError::Malformed(e.to_string()),
        // `DatabaseOpenError` is `#[non_exhaustive]`.
        other => KdbxError::Malformed(other.to_string()),
    }
}

/// Walk the group tree into a flat, deterministically ordered view list.
///
/// The walk is iterative with a visited set and a depth cap: a hostile file
/// whose group graph is cyclic or thousands deep must not overflow the stack
/// or grow paths without bound.
fn collect_views(db: &Database) -> (Vec<KdbxEntryView>, Vec<ItemWarning>) {
    let mut views = Vec::new();
    let mut warnings = Vec::new();
    let mut visited: HashSet<GroupId> = HashSet::new();

    let root_id = db.root().id();
    visited.insert(root_id);
    let mut stack: Vec<(GroupId, Vec<String>)> = vec![(root_id, Vec::new())];

    while let Some((group_id, group_path)) = stack.pop() {
        let Some(group) = db.group(group_id) else {
            continue;
        };
        for entry_id in group.entry_ids() {
            let Some(entry) = db.entry(entry_id) else {
                continue;
            };
            views.push(KdbxEntryView {
                group_path: group_path.clone(),
                fields: entry
                    .fields
                    .iter()
                    .map(|(k, v)| (k.clone(), v.get().clone()))
                    .collect::<BTreeMap<String, String>>(),
            });
        }

        let children: Vec<GroupId> = group.group_ids().collect();
        if group_path.len() >= MAX_GROUP_DEPTH && !children.is_empty() {
            warnings.push(ItemWarning {
                path: group_path.join("/"),
                warning: MapWarning::DepthLimited,
            });
            continue;
        }
        // Push in reverse so the stack yields children in document order.
        for child_id in children.into_iter().rev() {
            if !visited.insert(child_id) {
                continue;
            }
            let name = db
                .group(child_id)
                .map(|g| g.name.clone())
                .unwrap_or_default();
            let mut child_path = group_path.clone();
            child_path.push(name);
            stack.push((child_id, child_path));
        }
    }

    (views, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_not_kdbx() {
        let err = map_kdbx(&[], Some("x"), None, None).unwrap_err();
        assert!(matches!(err, KdbxError::NotKdbx(_)));
    }

    #[test]
    fn bad_magic_is_not_kdbx() {
        let bytes = vec![0u8; 64];
        let err = map_kdbx(&bytes, Some("x"), None, None).unwrap_err();
        assert!(matches!(err, KdbxError::NotKdbx(_)));
    }

    #[test]
    fn short_but_correctly_signed_input_is_not_kdbx() {
        let bytes = KDBX_MAGIC.to_vec();
        let err = map_kdbx(&bytes, Some("x"), None, None).unwrap_err();
        assert!(matches!(err, KdbxError::NotKdbx(_)));
    }

    #[test]
    fn no_credentials_is_rejected_before_parsing() {
        let mut bytes = KDBX_MAGIC.to_vec();
        bytes.extend_from_slice(&[0u8; 16]);
        let err = map_kdbx(&bytes, None, None, None).unwrap_err();
        assert!(matches!(err, KdbxError::MissingCredentials));
    }

    #[test]
    fn options_builders_compose() {
        let opts = ImportOptions::default().with_prefix("Imported").replacing();
        assert_eq!(opts.prefix.as_deref(), Some("Imported"));
        assert!(opts.replace);
    }

    #[test]
    fn summary_counts_every_disposition() {
        let summary = ImportSummary {
            created: vec!["a".into()],
            updated: vec!["b".into()],
            unchanged: vec!["c".into(), "d".into()],
            skipped: vec![SkippedItem {
                path: "e".into(),
                reason: SkipReason::Conflict,
            }],
            warnings: Vec::new(),
        };
        assert_eq!(summary.total(), 5);
        assert!(summary.changed());
        assert!(!ImportSummary {
            unchanged: vec!["c".into()],
            ..Default::default()
        }
        .changed());
    }
}
