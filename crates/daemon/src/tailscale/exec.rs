//! The programs the Tailscale passthrough starts, and what each is handed.
//!
//! The daemon may hold the Tailscale credential and the CLI root trust key, so
//! every program here is found by `opensesame-trusted-exec`'s rule and starts
//! from an empty environment: `PATH` (the trusted entries), `HOME`, `TMPDIR`,
//! `LANG`, `LC_*`, and only what is listed below.

use std::path::{Path, PathBuf};
use std::process::Command;

use opensesame_trusted_exec::{
    command_at, command_on_path, pass_in, resolve_in, Lookup, ResolveError, WSL,
};

/// The variable that names the exact Tailscale CLI to run.
pub(super) const TAILSCALE_OVERRIDE: &str = "OPENSESAME_TAILSCALE";

/// Where a Windows install sits when the daemon runs inside WSL: fixed paths
/// this code chose, tried only when no trusted `PATH` entry holds the CLI (WSL
/// mounts Windows drives writable by everyone, so its `PATH` entries never are).
const WINDOWS_CANDIDATES: &[&str] = &[
    "/mnt/c/Program Files/Tailscale/tailscale.exe",
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe",
];

/// The Tailscale CLI for `lookup`: the file `OPENSESAME_TAILSCALE` names (a
/// value that cannot be used is final), else `tailscale` or `tailscale.exe` on
/// a trusted `PATH` entry, else a Windows install seen from WSL.
pub(super) fn locate_in(lookup: &Lookup) -> Result<PathBuf, String> {
    let mut missing = None;
    for name in ["tailscale", "tailscale.exe"] {
        match resolve_in(name, Some(TAILSCALE_OVERRIDE), lookup) {
            Ok(found) => return Ok(found.program),
            Err(ResolveError::Override(refused)) => return Err(refused),
            Err(ResolveError::NotFound(why)) => missing = missing.or(Some(why)),
        }
    }
    WINDOWS_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .ok_or_else(|| missing.unwrap_or_default())
}

/// `bin` (from [`locate_in`], or Windows' own `curl.exe`) with the built
/// environment and the WSL interop variables.
pub(super) fn command_for(bin: &Path, lookup: &Lookup) -> Result<Command, String> {
    let mut command = command_at(bin, lookup).map_err(|e| e.to_string())?;
    pass_in(&mut command, &WSL, lookup);
    Ok(command)
}

/// `hostname`, `kill` or `taskkill` on a trusted `PATH` entry, given the
/// common set only: none needs more, and none is an operator's choice.
pub(super) fn system(program: &str) -> Option<Command> {
    command_on_path(program).ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;

    #[test]
    fn the_cli_is_the_trusted_one_and_is_handed_only_the_interop_variables() {
        let fixture = Fixture::new("tailscale");
        let lookup = fixture.lookup(&[("WSL_INTEROP", "/run/WSL/1_interop")]);
        let bin = locate_in(&lookup).unwrap();
        assert_eq!(bin, fixture.trusted.join("tailscale"));
        let mut command = command_for(&bin, &lookup).unwrap();
        assert!(command.arg("status").status().unwrap().success());
        let env = fixture.assert_clean();
        assert_eq!(env["WSL_INTEROP"], "/run/WSL/1_interop");
    }

    #[test]
    fn opensesame_tailscale_names_the_file_and_a_bad_value_is_final() {
        let fixture = Fixture::new("tailscale");
        let chosen = fixture.scratch("chosen").join("tailscale");
        fixture.stub_recorder(&chosen);
        let value = chosen.display().to_string();
        let lookup = fixture.lookup(&[(TAILSCALE_OVERRIDE, &value)]);
        assert_eq!(locate_in(&lookup).unwrap(), chosen);
        let bad = fixture.lookup(&[(TAILSCALE_OVERRIDE, "tailscale")]);
        let err = locate_in(&bad).unwrap_err();
        assert!(
            err.starts_with("OPENSESAME_TAILSCALE must be an absolute path"),
            "{err}"
        );
    }
}
