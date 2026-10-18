//! Who could have put this directory, or this `node`, where it is.
//!
//! A `PATH` entry is trusted on Unix when its owner is root or the user running
//! `opensesame`, others cannot write it, and, if its group can, that group is
//! root's or one of the caller's own. That keeps a directory that only
//! the caller (or root) can change, and still takes the layouts package managers
//! and CI images really produce: `root:root 0775`, or `user:user 0775` under the
//! user-private-group `umask 002` that `nvm`, `volta` and Homebrew inherit. It
//! refuses what a planted `node` needs: a directory another user owns, anyone
//! can write, or a group the caller is not in can write.
//!
//! The decisions are pure functions of a stat result and the caller, so the
//! table in `trust/tests.rs` pins them without needing other users on the host.

use std::path::{Path, PathBuf};

/// Why a `PATH` entry, or the `node` in it, is not used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Skip {
    Empty,
    Relative,
    NotADirectory,
    WritableByOthers,
    /// Writable by a group the caller is not in (and that is not root's).
    GroupWritable(u32),
    /// Owned by a user who is neither root nor the caller.
    OwnedBy(u32),
    CurrentDirectory,
}

impl Skip {
    pub(crate) fn reason(self) -> String {
        match self {
            Self::Empty => "empty entry".into(),
            Self::Relative => "relative".into(),
            Self::NotADirectory => "missing or not a directory".into(),
            Self::WritableByOthers => "writable by others".into(),
            Self::GroupWritable(gid) => {
                format!("group-writable by group {gid} which is not one of yours")
            }
            Self::OwnedBy(uid) => format!("owned by uid {uid}"),
            Self::CurrentDirectory => "the current directory".into(),
        }
    }
}

/// The part of a `stat` the decisions read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Owner {
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) mode: u32,
}

#[cfg(unix)]
impl From<&std::fs::Metadata> for Owner {
    fn from(meta: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            uid: meta.uid(),
            gid: meta.gid(),
            mode: meta.mode(),
        }
    }
}

#[cfg(not(unix))]
impl From<&std::fs::Metadata> for Owner {
    fn from(_: &std::fs::Metadata) -> Self {
        Self {
            uid: 0,
            gid: 0,
            mode: 0,
        }
    }
}

/// Who is asking: the effective user and the groups it is in.
#[derive(Clone, Debug, Default)]
pub(crate) struct Caller {
    pub(crate) euid: u32,
    pub(crate) groups: Vec<u32>,
}

impl Caller {
    #[cfg(unix)]
    pub(crate) fn current() -> Self {
        // SAFETY: `geteuid` and `getegid` take nothing. `getgroups` fills the
        // buffer it is handed, which is sized by its own answer to a first
        // call with no buffer, and is read only up to the count it returns.
        unsafe {
            let mut groups = vec![libc::getegid()];
            let wanted = usize::try_from(libc::getgroups(0, std::ptr::null_mut())).unwrap_or(0);
            if wanted > 0 {
                let mut listed: Vec<libc::gid_t> = vec![0; wanted];
                let got = usize::try_from(libc::getgroups(
                    libc::c_int::try_from(wanted).unwrap_or(0),
                    listed.as_mut_ptr(),
                ))
                .unwrap_or(0);
                groups.extend(listed.into_iter().take(got));
            }
            Self {
                euid: libc::geteuid(),
                groups,
            }
        }
    }

    #[cfg(not(unix))]
    pub(crate) fn current() -> Self {
        Self::default()
    }

    /// Root's group, or one of the caller's.
    fn trusts_group(&self, gid: u32) -> bool {
        gid == 0 || self.groups.contains(&gid)
    }

    fn trusts_owner(&self, uid: u32) -> bool {
        uid == 0 || uid == self.euid
    }
}

const OTHERS_WRITE: u32 = 0o002;
const GROUP_WRITE: u32 = 0o020;

/// Why a `PATH` directory with this owner is not searched, if it is not.
pub(crate) fn directory(owner: Owner, caller: &Caller) -> Option<Skip> {
    if !caller.trusts_owner(owner.uid) {
        Some(Skip::OwnedBy(owner.uid))
    } else if owner.mode & OTHERS_WRITE != 0 {
        Some(Skip::WritableByOthers)
    } else if owner.mode & GROUP_WRITE != 0 && !caller.trusts_group(owner.gid) {
        Some(Skip::GroupWritable(owner.gid))
    } else {
        None
    }
}

/// Why this `node` file (after symlinks) is not run, if it is not: owned by
/// root or the caller, and not writable by everyone.
pub(crate) fn file(owner: Owner, caller: &Caller) -> Option<Skip> {
    if !caller.trusts_owner(owner.uid) {
        Some(Skip::OwnedBy(owner.uid))
    } else if owner.mode & OTHERS_WRITE != 0 {
        Some(Skip::WritableByOthers)
    } else {
        None
    }
}

/// `dir` is the current directory (both resolved when they can be).
pub(crate) fn is_cwd(dir: &Path, cwd: Option<&Path>) -> bool {
    let Some(cwd) = cwd else { return false };
    match (dir.canonicalize(), cwd.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => dir == cwd,
    }
}

/// The first `node` an entry of `trusted` holds that may be run.
#[derive(Debug, Default)]
pub(crate) struct NodeSearch {
    pub(crate) node: Option<PathBuf>,
    /// Executables called `node` that were passed over, and why.
    pub(crate) rejected: Vec<(PathBuf, Skip)>,
}

#[cfg(test)]
mod tests;
