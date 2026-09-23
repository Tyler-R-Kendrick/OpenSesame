//! The one inventory of everything sealed under the vault root.
//!
//! Rotation re-encrypts from it, and attachment listing, garbage collection
//! and replication read their manifests from it too, so all four see one set.
//! It deliberately does not reuse the `ls` walker: that hides dot-named files
//! and directories from the person browsing the store, but `pass insert
//! Dev/.npmrc` and `pass attach add Dev/.w2` are legal, and a walker that
//! skipped them would leave them under the revoked root, let GC reclaim their
//! chunks, or keep them out of a replica. Here nothing is hidden except the
//! store's own reserved locations, none of which may hold an entry
//! (`StoreLock::for_sealing` refuses them): `.git`, the staging directory, and
//! the chunk pool, whose objects the rotation accounts for through their
//! manifests and then prunes. A directory whose name differs from one of those
//! only in ASCII case fails the walk closed: on a case-folding filesystem it is
//! the reserved location, on a case-sensitive one it is not, and the walk
//! cannot tell which.

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

/// How a directory relates to the store's reserved locations.
#[derive(Debug, PartialEq, Eq)]
enum Reserved {
    /// Ordinary content: walk it.
    No,
    /// The reserved location itself: skip it.
    Exact,
    /// Differs from a reserved name only in ASCII case. On a case-folding
    /// filesystem it *is* that location; on a case-sensitive one it is a
    /// separate directory that could hold sealed content. Either way the walk
    /// cannot vouch for it, so it fails closed.
    CaseVariant,
}

fn reserved(segments: &[String]) -> Reserved {
    let names: &[&str] = match segments {
        [only] if only == ".git" || only == ROTATION_STAGING_DIR => return Reserved::Exact,
        [first, second] if first == POOL_DIR[0] && second == POOL_DIR[1] => return Reserved::Exact,
        [_] => &[".git", ROTATION_STAGING_DIR],
        [_, _] => &POOL_DIR,
        _ => return Reserved::No,
    };
    let variant = if let [only] = segments {
        names.iter().any(|name| only.eq_ignore_ascii_case(name))
    } else {
        segments
            .iter()
            .zip(names)
            .all(|(segment, name)| segment.eq_ignore_ascii_case(name))
    };
    if variant {
        Reserved::CaseVariant
    } else {
        Reserved::No
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
            match reserved(segments) {
                Reserved::No => walk(&entry.path(), segments, out)?,
                Reserved::Exact => {}
                Reserved::CaseVariant => {
                    return Err(StoreError::InvalidPath(format!(
                        "{} differs only in case from a reserved store directory; rename it \
                         before rotating",
                        segments.join("/")
                    )));
                }
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
    if let Some(stem) = file.strip_suffix(OSSEAL_SUFFIX) {
        out.entries.insert(logical(stem)?);
    } else if let Some(stem) = file.strip_suffix(attach_suffix.as_str()) {
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

    #[test]
    fn reserved_names_match_in_any_ascii_case() {
        let seg = |parts: &[&str]| parts.iter().map(|p| (*p).to_string()).collect::<Vec<_>>();
        assert_eq!(reserved(&seg(&[".git"])), Reserved::Exact);
        assert_eq!(
            reserved(&seg(&[".attachments", "objects"])),
            Reserved::Exact
        );
        let staging = ROTATION_STAGING_DIR.to_ascii_uppercase();
        for variant in [
            seg(&[".GIT"]),
            seg(&[".Git"]),
            seg(&[&staging]),
            seg(&[".Attachments", "OBJECTS"]),
        ] {
            assert_eq!(reserved(&variant), Reserved::CaseVariant, "{variant:?}");
        }
        assert_eq!(reserved(&seg(&[".gitx"])), Reserved::No);
        assert_eq!(reserved(&seg(&["Dev", ".git"])), Reserved::No);
        assert_eq!(reserved(&seg(&[".attachments"])), Reserved::No);
    }

    #[test]
    fn a_differently_cased_reserved_directory_is_never_walked_as_content() {
        for rel in [".GIT/stray.osseal", ".Attachments/Objects/ab/x.osseal"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
            assert!(inventory(dir.path()).is_err(), "{rel}");
        }
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
    fn a_file_with_no_stem_fails_closed_rather_than_being_skipped() {
        for rel in ["Dev/.osseal", "Scans/.osattach", ".osseal"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
            assert!(inventory(dir.path()).is_err(), "{rel}");
        }
    }

    #[test]
    fn a_name_the_store_would_address_elsewhere_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(" x.osseal"), b"x").unwrap();
        assert!(inventory(dir.path()).is_err());
    }
}
