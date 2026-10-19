//! Who could have put this directory, or this program, where it is.
//!
//! A `PATH` entry is trusted on Unix when its owner is root or the user running
//! `opensesame`, others cannot write it, and, if its group can, that group is
//! root's or one of the caller's own. That keeps a directory that only
//! the caller (or root) can change, and still takes the layouts package managers
//! and CI images really produce: `root:root 0775`, or `user:user 0775` under the
//! user-private-group `umask 002` that `nvm`, `volta` and Homebrew inherit. It
//! refuses what a planted program needs: a directory another user owns, anyone
//! can write, or a group the caller is not in can write.
//!
//! The program file gets the same questions as a directory: another owner, any
//! writer outside the caller's own groups, anyone at all. And so does every
//! directory above it (`chain.rs`): a directory only its owner may rename
//! entries of is safe, one anyone can write is not, unless it is sticky and
//! root's (`/tmp`, `/nix/store`), where an entry can be renamed only by its
//! own owner, who is checked in turn.
//!
//! The decisions are pure functions of a stat result and the caller, so the
//! table in `trust/tests.rs` pins them without needing other users on the host.

use std::path::{Path, PathBuf};

/// What is wrong with a directory or a file, apart from where it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    /// Owned by a user who is neither root nor the caller.
    OwnedBy(u32),
    WritableByOthers,
    /// Writable by a group the caller is not in (and that is not root's).
    GroupWritable(u32),
}

impl Cause {
    fn reason(self) -> String {
        match self {
            Self::OwnedBy(uid) => format!("owned by uid {uid}"),
            Self::WritableByOthers => "writable by others".into(),
            Self::GroupWritable(gid) => {
                format!("group-writable by group {gid} which is not one of yours")
            }
        }
    }
}

impl From<Cause> for Skip {
    fn from(cause: Cause) -> Self {
        match cause {
            Cause::OwnedBy(uid) => Self::OwnedBy(uid),
            Cause::WritableByOthers => Self::WritableByOthers,
            Cause::GroupWritable(gid) => Self::GroupWritable(gid),
        }
    }
}

/// Why a `PATH` entry, or the program in it, is not used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Skip {
    Empty,
    Relative,
    NotADirectory,
    WritableByOthers,
    /// Writable by a group the caller is not in (and that is not root's).
    GroupWritable(u32),
    /// Owned by a user who is neither root nor the caller.
    OwnedBy(u32),
    CurrentDirectory,
    /// A directory above it could be renamed or replaced by someone else.
    Under {
        ancestor: PathBuf,
        cause: Cause,
    },
}

impl Skip {
    /// What the error says about an entry skipped for this reason.
    #[must_use]
    pub fn reason(&self) -> String {
        match self {
            Self::Empty => "empty entry".into(),
            Self::Relative => "relative".into(),
            Self::NotADirectory => "missing or not a directory".into(),
            Self::WritableByOthers => "writable by others".into(),
            Self::GroupWritable(gid) => Cause::GroupWritable(*gid).reason(),
            Self::OwnedBy(uid) => Cause::OwnedBy(*uid).reason(),
            Self::CurrentDirectory => "the current directory".into(),
            Self::Under { ancestor, cause } => {
                format!("is under \"{}\", {}", ancestor.display(), cause.reason())
            }
        }
    }
}

/// The part of a `stat` the decisions read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Owner {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
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
pub struct Caller {
    pub euid: u32,
    pub groups: Vec<u32>,
}

impl Caller {
    /// The effective user of this process and every group it is in.
    #[cfg(unix)]
    #[must_use]
    pub fn current() -> Self {
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

    /// Nobody in particular: Windows decides by location, not ownership.
    #[cfg(not(unix))]
    #[must_use]
    pub fn current() -> Self {
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
const STICKY: u32 = 0o1000;

/// Why a `PATH` directory with this owner is not searched, if it is not.
#[must_use]
pub fn directory(owner: Owner, caller: &Caller) -> Option<Skip> {
    writers(owner, caller).map(Skip::from)
}

/// Who could change something owned this way, besides root and the caller.
fn writers(owner: Owner, caller: &Caller) -> Option<Cause> {
    if !caller.trusts_owner(owner.uid) {
        Some(Cause::OwnedBy(owner.uid))
    } else if owner.mode & OTHERS_WRITE != 0 {
        Some(Cause::WritableByOthers)
    } else if owner.mode & GROUP_WRITE != 0 && !caller.trusts_group(owner.gid) {
        Some(Cause::GroupWritable(owner.gid))
    } else {
        None
    }
}

/// Why this program file (after symlinks) is not run, if it is not: owned by
/// root or the caller, and writable by nobody outside the caller's own groups.
#[must_use]
pub fn file(owner: Owner, caller: &Caller) -> Option<Skip> {
    writers(owner, caller).map(Skip::from)
}

/// Why a directory *above* a program or a `PATH` entry cannot be relied on,
/// if it cannot: the same questions as [`directory`], except that one that
/// is sticky and root's is fine however it is writable, since a sticky
/// directory lets only an entry's own owner (or root) rename it, and the
/// entry below is checked in turn.
#[must_use]
pub fn ancestor(owner: Owner, caller: &Caller) -> Option<Cause> {
    let sticky_root = owner.uid == 0 && owner.mode & STICKY != 0;
    if sticky_root {
        None
    } else {
        writers(owner, caller)
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

#[cfg(test)]
mod tests;
