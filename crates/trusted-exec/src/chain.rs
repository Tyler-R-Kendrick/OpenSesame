//! The directories above a `PATH` entry or a program.
//!
//! A directory only root or the caller can write is not enough if the
//! directory that holds *it* is one anyone can write: its owner can rename the
//! trusted one away and put theirs in its place, between the check and the
//! `exec`, and a symlink is the same in the directory it sits in. So every
//! directory above the path is asked `trust::ancestor`, both where the path
//! lexically goes (the directory a link sits in) and where it really goes
//! (the directory a link points into), and what is run is the real path.

use std::path::Path;

use crate::trust::{Caller, Skip};

/// The first directory above `path` that someone but root or the caller could
/// rename or replace, as the [`Skip`] to give: `path` is under it.
#[cfg(unix)]
pub(crate) fn above(path: &Path, caller: &Caller) -> Option<Skip> {
    let real = path.canonicalize().ok();
    let walks = std::iter::once(path).chain(real.as_deref().filter(|real| *real != path));
    walks.into_iter().find_map(|walk| ancestors(walk, caller))
}

#[cfg(unix)]
fn ancestors(path: &Path, caller: &Caller) -> Option<Skip> {
    use crate::trust::{ancestor, Owner};
    path.ancestors()
        .skip(1)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| {
            let meta = std::fs::metadata(dir).ok()?;
            ancestor(Owner::from(&meta), caller).map(|cause| Skip::Under {
                ancestor: dir.to_path_buf(),
                cause,
            })
        })
}

/// Windows decides by location only.
#[cfg(not(unix))]
pub(crate) fn above(_: &Path, _: &Caller) -> Option<Skip> {
    None
}
