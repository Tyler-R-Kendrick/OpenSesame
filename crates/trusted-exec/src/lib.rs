//! Which file a fixed program name starts, and what that program can see.
//!
//! `opensesame` starts a few programs by name: `git`, `gpg`, `gh`, `node`,
//! `tailscale`, a browser opener. The process that starts them may hold what
//! unlocks the sealed store, the Host's connection key, provider tokens and a
//! GitHub App's private key. Two rules, kept in this one crate so that no spawn
//! takes a shortcut around them:
//!
//! 1. The program is found here and run by its absolute path. If the operator
//!    set the program's override variable (`OPENSESAME_GIT=/usr/bin/git`), that
//!    file is the program (see [`named`]): it must be absolute, exist and after
//!    symlinks be a regular file with an execute bit; it is exempt from the
//!    ownership checks below, and a value that cannot be used is an error, not
//!    a fallback. Otherwise only `PATH` entries that are absolute, exist and
//!    that nobody else could have put the program in are searched: owned by
//!    root or the caller, not writable by others, and group-writable only by
//!    root's group or one of the caller's own (see [`trust`]). On Windows:
//!    absolute, existing and not the current directory. The file itself must be
//!    owned by root or the caller and not world-writable. Empty and relative
//!    entries are never searched, and the inherited `PATH` is never a fallback;
//!    the error says why each entry was skipped.
//! 2. The environment is built, not inherited. [`command_in`] clears it and
//!    gives the program `PATH` reduced to the trusted entries and [`COMMON`];
//!    the code that starts it adds, beside the spawn and with a reason, only the
//!    variables that program needs ([`pass_in`]), then what it sets itself.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;

mod env;
mod operator;
mod search;
#[cfg(all(unix, any(test, feature = "testkit")))]
pub mod testkit;
pub mod trust;

pub use env::{pass, pass_in, Pass, CA_BUNDLE, COMMON, COMMON_ON_WINDOWS, LOCALE, PROXY};
pub use operator::named;
pub use search::{find, search, Found, Search};
pub use trust::{Caller, Owner, Skip};

/// Where the rules differ: the file name of a program, how a variable name is
/// compared, and what makes a `PATH` directory untrustworthy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Unix,
    Windows,
}

impl Platform {
    /// The platform this was built for.
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }

    /// The file `program` is on this platform: `git.exe` on Windows, unless
    /// the name already says which file it is (`explorer.exe`).
    #[must_use]
    pub fn file_name(self, program: &str) -> String {
        match self {
            Self::Windows if !program.contains('.') => format!("{program}.exe"),
            _ => program.to_owned(),
        }
    }

    /// Whether two variable names are the same name here.
    #[must_use]
    pub fn same_name(self, a: &str, b: &str) -> bool {
        match self {
            Self::Unix => a == b,
            Self::Windows => a.eq_ignore_ascii_case(b),
        }
    }
}

/// The process state a program is found in and its environment drawn from.
/// It holds the parent's whole environment, so it has no `Debug`.
pub struct Lookup {
    pub vars: Vec<(OsString, OsString)>,
    pub cwd: Option<PathBuf>,
    pub platform: Platform,
    pub caller: Caller,
}

impl Lookup {
    /// This process: its environment, working directory and user.
    #[must_use]
    pub fn capture() -> Self {
        Self {
            vars: std::env::vars_os().collect(),
            cwd: std::env::current_dir().ok(),
            platform: Platform::current(),
            caller: Caller::current(),
        }
    }

    /// The value of `name`, compared as this platform compares names.
    #[must_use]
    pub fn var(&self, name: &str) -> Option<&OsStr> {
        self.vars
            .iter()
            .find(|(n, _)| n.to_str().is_some_and(|n| self.platform.same_name(n, name)))
            .map(|(_, value)| value.as_os_str())
    }
}

/// Why no program was found to run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// No trusted `PATH` entry holds the program; says what was skipped and why.
    NotFound(String),
    /// The override variable is set to something that cannot be run; names it.
    Override(String),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(why) | Self::Override(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for ResolveError {}

/// A program found to run, and the `PATH` entries that were trusted on the way.
#[derive(Debug)]
pub struct Resolved {
    pub program: PathBuf,
    pub trusted: Vec<PathBuf>,
}

/// `program` for `lookup`: the file `override_var` names when it is set,
/// otherwise the first trusted one on `PATH`.
///
/// # Errors
///
/// [`ResolveError::Override`] when the variable is set to a file that cannot
/// be run, [`ResolveError::NotFound`] when no trusted entry holds the program.
pub fn resolve_in(
    program: &str,
    override_var: Option<&str>,
    lookup: &Lookup,
) -> Result<Resolved, ResolveError> {
    let path = lookup.var("PATH");
    let found = path.map(|p| search(p, lookup)).unwrap_or_default();
    let named_value = override_var.and_then(|var| lookup.var(var).map(|value| (var, value)));
    let file = if let Some((var, value)) = named_value {
        named(var, value)?
    } else {
        let hit = find(&lookup.platform.file_name(program), &found.trusted, lookup);
        hit.program
            .ok_or_else(|| search::not_found(program, path, &found, &hit.rejected))?
    };
    Ok(Resolved {
        program: file,
        trusted: found.trusted,
    })
}

/// `program` for this process, or the file `override_var` names.
///
/// # Errors
///
/// As [`resolve_in`].
pub fn resolve(program: &str, override_var: &str) -> Result<PathBuf, ResolveError> {
    resolve_in(program, Some(override_var), &Lookup::capture()).map(|found| found.program)
}

/// `program` for this process, for a program no operator needs to name.
///
/// # Errors
///
/// As [`resolve_in`].
pub fn resolve_on_path(program: &str) -> Result<PathBuf, ResolveError> {
    resolve_in(program, None, &Lookup::capture()).map(|found| found.program)
}

/// `program`, found by [`resolve_in`], with an environment of nothing but
/// `PATH` (the trusted entries) and [`COMMON`] (and on Windows
/// [`COMMON_ON_WINDOWS`]). Add what this program needs with [`pass_in`].
///
/// # Errors
///
/// As [`resolve_in`].
pub fn command_in(
    program: &str,
    override_var: Option<&str>,
    lookup: &Lookup,
) -> Result<Command, ResolveError> {
    let found = resolve_in(program, override_var, lookup)?;
    let path = std::env::join_paths(&found.trusted)
        .map_err(|e| ResolveError::NotFound(format!("PATH cannot be rebuilt: {e}")))?;
    let mut command = Command::new(&found.program);
    command.env_clear().env("PATH", path);
    pass_in(&mut command, &COMMON, lookup);
    if lookup.platform == Platform::Windows {
        pass_in(&mut command, &COMMON_ON_WINDOWS, lookup);
    }
    Ok(command)
}

/// [`command_in`] for this process, honouring `override_var`.
///
/// # Errors
///
/// As [`resolve_in`].
pub fn command(program: &str, override_var: &str) -> Result<Command, ResolveError> {
    command_in(program, Some(override_var), &Lookup::capture())
}

/// [`command_in`] for this process, for a program no operator needs to name.
///
/// # Errors
///
/// As [`resolve_in`].
pub fn command_on_path(program: &str) -> Result<Command, ResolveError> {
    command_in(program, None, &Lookup::capture())
}

#[cfg(all(test, unix))]
mod tests;
