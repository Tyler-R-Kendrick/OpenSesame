//! The rotation's own inventory of everything sealed under the vault root.
//!
//! This deliberately does not reuse the `ls` / attachment-listing walkers:
//! those hide dot-named files and directories from the person browsing the
//! store, but `pass insert Dev/.npmrc` is a legal entry, and a rotation that
//! skipped it would leave it sealed under the revoked root. Here nothing is
//! hidden except the store's own reserved locations, none of which may hold an
//! entry (`StoreLock::for_sealing` refuses them): `.git`, the staging
//! directory, and the chunk pool, whose objects the rotation accounts for
//! through their manifests and then prunes.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::attachment::ATTACH_EXT;
use crate::path::logical_to_relative;
use crate::rotation::ROTATION_STAGING_DIR;
use crate::StoreError;

const OSSEAL_SUFFIX: &str = ".osseal";
const POOL_DIR: [&str; 2] = [".attachments", "objects"];

/// Every root-sealed file in the store, by logical name.
#[derive(Default)]
pub(crate) struct SealedInventory {
    /// Logical names of `.osseal` entries.
    pub entries: BTreeSet<String>,
    /// Logical names of `.osattach` manifests.
    pub attachments: BTreeSet<String>,
    /// `.gpg` / `.age` files, which are not sealed under the root.
    pub foreign: usize,
}

impl SealedInventory {
    /// Store-relative paths of every root-sealed file.
    pub(crate) fn relative_paths(&self) -> BTreeSet<PathBuf> {
        let attach_suffix = format!(".{ATTACH_EXT}");
        self.entries
            .iter()
            .map(|name| PathBuf::from(format!("{name}{OSSEAL_SUFFIX}")))
            .chain(
                self.attachments
                    .iter()
                    .map(|name| PathBuf::from(format!("{name}{attach_suffix}"))),
            )
            .collect()
    }
}

/// Inventory every root-sealed file under `root`.
///
/// # Errors
///
/// Fails closed on a symlink anywhere in the walked tree (it could hide sealed
/// content the rotation cannot confine), on a sealed file whose name is not
/// UTF-8, and on any directory that cannot be read.
pub(crate) fn inventory(root: &Path) -> Result<SealedInventory, StoreError> {
    let mut out = SealedInventory::default();
    walk(root, &mut Vec::new(), &mut out)?;
    Ok(out)
}

fn reserved(segments: &[String]) -> bool {
    match segments {
        [only] => only == ".git" || only == ROTATION_STAGING_DIR,
        [first, second] => first == POOL_DIR[0] && second == POOL_DIR[1],
        _ => false,
    }
}

fn walk(
    dir: &Path,
    segments: &mut Vec<String>,
    out: &mut SealedInventory,
) -> Result<(), StoreError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let raw_name = entry.file_name();
        let Some(name) = raw_name.to_str() else {
            let lossy = raw_name.to_string_lossy();
            if file_type.is_dir() || is_sealed_name(&lossy) {
                return Err(StoreError::InvalidPath(format!(
                    "non-UTF-8 name in the store ({lossy}); rename it before rotating"
                )));
            }
            continue;
        };
        segments.push(name.to_string());
        if file_type.is_symlink() {
            return Err(StoreError::InvalidPath(format!(
                "symlink inside the store ({}); a rotation cannot vouch for what it hides",
                segments.join("/")
            )));
        }
        if file_type.is_dir() {
            if !reserved(segments) {
                walk(&entry.path(), segments, out)?;
            }
        } else if file_type.is_file() {
            classify(segments, out)?;
        }
        segments.pop();
    }
    Ok(())
}

fn is_sealed_name(name: &str) -> bool {
    let attach_suffix = format!(".{ATTACH_EXT}");
    [OSSEAL_SUFFIX, attach_suffix.as_str()]
        .iter()
        .any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
}

fn classify(segments: &[String], out: &mut SealedInventory) -> Result<(), StoreError> {
    let Some((file, parents)) = segments.split_last() else {
        return Ok(());
    };
    // A name the store would map to a different file (surrounding
    // whitespace, say) cannot be re-encrypted in place: refuse, never guess.
    let logical = |stem: &str| {
        let mut parts: Vec<&str> = parents.iter().map(String::as_str).collect();
        parts.push(stem);
        let name = parts.join("/");
        match logical_to_relative(&name) {
            Ok(rel) if rel == Path::new(&name) => Ok(name),
            _ => Err(StoreError::InvalidPath(format!(
                "{} is not a name the store can address; rename it before rotating",
                segments.join("/")
            ))),
        }
    };
    let attach_suffix = format!(".{ATTACH_EXT}");
    if let Some(stem) = file.strip_suffix(OSSEAL_SUFFIX).filter(|s| !s.is_empty()) {
        out.entries.insert(logical(stem)?);
    } else if let Some(stem) = file
        .strip_suffix(attach_suffix.as_str())
        .filter(|s| !s.is_empty())
    {
        out.attachments.insert(logical(stem)?);
    } else if Path::new(file)
        .extension()
        .is_some_and(|ext| ext == "gpg" || ext == "age")
    {
        out.foreign += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_named_entries_are_inventoried_and_reserved_state_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in [
            "Dev/.npmrc.osseal",
            ".hidden/token.osseal",
            "Dev/.w2.osattach",
            ".attachments/objects/ab/ab.oschunk",
            ".git/stray.osseal",
            "Old/legacy.gpg",
            "Dev/notes.txt",
        ] {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }
        let found = inventory(root).unwrap();
        let entries: Vec<_> = found.entries.iter().map(String::as_str).collect();
        assert_eq!(entries, [".hidden/token", "Dev/.npmrc"]);
        let attachments: Vec<_> = found.attachments.iter().map(String::as_str).collect();
        assert_eq!(attachments, ["Dev/.w2"]);
        assert_eq!(found.foreign, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("Dev")).unwrap();
        assert!(inventory(dir.path()).is_err());
    }

    #[test]
    fn a_name_the_store_would_address_elsewhere_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(" x.osseal"), b"x").unwrap();
        assert!(inventory(dir.path()).is_err());
    }
}
