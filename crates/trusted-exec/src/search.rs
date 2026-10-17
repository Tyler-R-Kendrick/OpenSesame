//! Sorting `PATH` into the entries that are searched and those that are not,
//! and finding the first trusted program file among them.

use std::ffi::OsStr;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::trust::{self, Owner, Skip};
use crate::{chain, Lookup, Platform, ResolveError};

/// The entries of a `PATH`: those searched, in order, and those skipped.
#[derive(Clone, Debug, Default)]
pub struct Search {
    pub trusted: Vec<PathBuf>,
    pub skipped: Vec<(PathBuf, Skip)>,
}

/// The first trusted file a search found, and the ones passed over.
#[derive(Debug, Default)]
pub struct Found {
    /// The file to run: the real path, after every link, whose every
    /// directory above it has been asked too.
    pub program: Option<PathBuf>,
    /// The path it was found as, which a program that behaves by the name it
    /// was started under (a version manager's shim) must be told.
    pub invoked_as: Option<PathBuf>,
    /// Executables of that name that were passed over, and why.
    pub rejected: Vec<(PathBuf, Skip)>,
}

#[cfg(unix)]
pub(crate) fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
pub(crate) fn executable(_: &std::fs::Metadata) -> bool {
    true
}

/// Sorts the entries of `path` into those searched, in order, and those not.
#[must_use]
pub fn search(path: &OsStr, lookup: &Lookup) -> Search {
    let mut found = Search::default();
    for dir in std::env::split_paths(path) {
        let verdict = if dir.as_os_str().is_empty() {
            Some(Skip::Empty)
        } else if !dir.is_absolute() {
            Some(Skip::Relative)
        } else {
            match std::fs::metadata(&dir) {
                Ok(meta) if meta.is_dir() => match lookup.platform {
                    Platform::Unix => trust::directory(Owner::from(&meta), &lookup.caller)
                        .or_else(|| chain::above(&dir, &lookup.caller)),
                    Platform::Windows if trust::is_cwd(&dir, lookup.cwd.as_deref()) => {
                        Some(Skip::CurrentDirectory)
                    }
                    Platform::Windows => None,
                },
                _ => Some(Skip::NotADirectory),
            }
        };
        match verdict {
            Some(skip) => found.skipped.push((dir, skip)),
            None => found.trusted.push(dir),
        }
    }
    found
}

/// The first `file_name` an entry of `trusted` holds that may be run, as an
/// absolute path, and the ones passed over on the way.
#[must_use]
pub fn find(file_name: &str, trusted: &[PathBuf], lookup: &Lookup) -> Found {
    let mut found = Found::default();
    for dir in trusted {
        let candidate = dir.join(file_name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !meta.is_file() || !executable(&meta) {
            continue;
        }
        let verdict = match lookup.platform {
            Platform::Unix => trust::file(Owner::from(&meta), &lookup.caller)
                .or_else(|| chain::above(&candidate, &lookup.caller)),
            Platform::Windows => None,
        };
        if let Some(skip) = verdict {
            found.rejected.push((candidate, skip));
            continue;
        }
        found.program = Some(real_path(&candidate, lookup.platform));
        found.invoked_as = Some(candidate);
        break;
    }
    found
}

/// What to run for `candidate`: its real path on Unix, so the file that was
/// checked is the file that runs; Windows runs it as found.
fn real_path(candidate: &Path, platform: Platform) -> PathBuf {
    match platform {
        Platform::Unix => candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.to_path_buf()),
        Platform::Windows => candidate.to_path_buf(),
    }
}

/// The error for a search that found no usable `program`: what is searched,
/// and why each entry or file was passed over. Never a fallback.
pub(crate) fn not_found(
    program: &str,
    override_var: Option<&str>,
    path: Option<&OsStr>,
    found: &Search,
    rejected: &[(PathBuf, Skip)],
) -> ResolveError {
    let mut why = format!(
        "no usable `{program}`: PATH entries are searched only when absolute, existing, owned \
         by root or you, not writable by others, and group-writable only by root's group or \
         one of yours; "
    );
    match path {
        None => why.push_str("PATH is not set"),
        Some(_) if found.trusted.is_empty() => why.push_str("PATH has none"),
        Some(_) => {
            let searched: Vec<_> = found
                .trusted
                .iter()
                .map(|d| d.display().to_string())
                .collect();
            let _ = write!(why, "none of {} holds a `{program}`", searched.join(", "));
        }
    }
    let mut notes: Vec<String> = found
        .skipped
        .iter()
        .map(|(dir, skip)| format!("\"{}\" {}", dir.display(), skip.reason()))
        .collect();
    notes.extend(
        rejected
            .iter()
            .map(|(file, skip)| format!("{program} \"{}\" {}", file.display(), skip.reason())),
    );
    if !notes.is_empty() {
        let _ = write!(why, " (skipped: {})", notes.join("; "));
    }
    if let Some(variable) = override_var {
        let _ = write!(
            why,
            "; or set {variable} to the absolute path of the `{program}` to run"
        );
    }
    ResolveError::NotFound(why)
}
