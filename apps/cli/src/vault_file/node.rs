//! `OPENSESAME_NODE` for `opensesame-id`.
//!
//! `opensesame-id` is a `#!/usr/bin/env node` script, and its child sees only
//! the trusted `PATH` entries, so a `node` that lives where anyone can write
//! (a hosted CI image's 0777 `/usr/local/bin`) is not found by `env`. An
//! operator who names that file with `OPENSESAME_NODE`, as for the env-spec
//! bridge, has chosen it. It is made findable without opening its directory: a
//! private directory holding one link, `node`, goes first on the child's
//! `PATH` for as long as the child runs.

use std::process::Command;

use opensesame_trusted_exec::Lookup;
use tempfile::TempDir;

/// The variable that names the exact `node` to run.
#[cfg(unix)]
const NODE_OVERRIDE: &str = "OPENSESAME_NODE";

/// Puts the `node` that `OPENSESAME_NODE` names first on `command`'s `PATH`.
/// The returned directory is the link's; keep it until the child has exited.
#[cfg(unix)]
pub(super) fn provide(command: &mut Command, lookup: &Lookup) -> anyhow::Result<Option<TempDir>> {
    use std::os::unix::fs::PermissionsExt as _;

    let Some(value) = lookup.var(NODE_OVERRIDE) else {
        return Ok(None);
    };
    let node = opensesame_trusted_exec::named(NODE_OVERRIDE, value)
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    // Private to the caller: nothing else may add a second `node` beside the link.
    let dir = tempfile::Builder::new()
        .prefix("opensesame-node-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()?;
    std::os::unix::fs::symlink(&node, dir.path().join("node"))?;
    let rest = command
        .get_envs()
        .find(|(name, _)| *name == "PATH")
        .and_then(|(_, value)| value)
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let path = std::env::join_paths(std::iter::once(dir.path().to_path_buf()).chain(rest))
        .map_err(|error| anyhow::anyhow!("PATH cannot be rebuilt: {error}"))?;
    command.env("PATH", path);
    Ok(Some(dir))
}

/// Windows starts no script through `env`, so there is nothing to do. The
/// signature matches the Unix one, which can fail.
#[cfg(not(unix))]
#[allow(clippy::unnecessary_wraps)]
pub(super) fn provide(_: &mut Command, _: &Lookup) -> anyhow::Result<Option<TempDir>> {
    Ok(None)
}

#[cfg(all(test, unix))]
mod tests;
