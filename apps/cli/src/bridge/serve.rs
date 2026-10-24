//! `opensesame bridge keepassxc serve`: run the bridge binary's UDS server as
//! a child process.
//!
//! The CLI does not link the bridge core: the serving surfaces are behind
//! cargo features in `crates/pm-bridges`, and keeping them out of the CLI is
//! what makes "default off" true at link time rather than only at runtime.
//!
//! The bridge opens the store with `OPENSESAME_STORE_PASSWORD` from its
//! environment, so it must be the file the person meant. It is the sibling
//! binary built and installed with this `opensesame`, started as `daemon start`
//! starts `opensesame` itself, in the environment the person gave this
//! command. It is never a name left to the child's `PATH` search.

use std::io;
use std::path::PathBuf;

use opensesame_pm_bridges::conflict::{keepassxc_socket_path, probe_unix_socket, SocketState};
use opensesame_pm_bridges::manifest::BridgeKind;
use opensesame_trusted_exec::{named, Platform};

/// `--bin`, else the bridge that sits beside this `opensesame`. Neither is
/// searched for on `PATH`: a bare name would run whatever answers to it first.
pub(super) fn binary(bin: Option<PathBuf>, exe: io::Result<PathBuf>) -> anyhow::Result<PathBuf> {
    let (label, file) = if let Some(bin) = bin {
        ("--bin", bin)
    } else {
        let exe = exe.map_err(|error| {
            anyhow::anyhow!(
                "cannot tell where this opensesame is, so cannot find the bridge beside it \
                 ({error}); pass --bin <absolute path>"
            )
        })?;
        let name = Platform::current().file_name(BridgeKind::KeepassXc.default_binary());
        let beside = exe.parent().map(|dir| dir.join(&name));
        let Some(beside) = beside.filter(|beside| beside.is_file()) else {
            anyhow::bail!(
                "{name} is not beside {}: install it there or pass --bin <absolute path>",
                exe.display()
            );
        };
        ("the bridge beside this opensesame", beside)
    };
    named(label, file.as_os_str()).map_err(|error| anyhow::anyhow!("{error}"))
}

pub(super) fn run(
    socket: Option<PathBuf>,
    takeover: bool,
    bin: Option<PathBuf>,
) -> anyhow::Result<()> {
    let socket = socket.unwrap_or_else(keepassxc_socket_path);
    match probe_unix_socket(&socket) {
        SocketState::Live { .. } => {
            anyhow::bail!("{}", probe_unix_socket(&socket).diagnostic(&socket));
        }
        SocketState::Stale if !takeover => {
            anyhow::bail!("{}", probe_unix_socket(&socket).diagnostic(&socket));
        }
        _ => {}
    }
    let binary = binary(bin, std::env::current_exe())?;
    let mut command = std::process::Command::new(&binary);
    command.arg("serve").arg("--socket").arg(&socket);
    if takeover {
        command.arg("--takeover");
    }
    let status = command
        .status()
        .map_err(|e| anyhow::anyhow!("could not run {}: {e}", binary.display()))?;
    if !status.success() {
        anyhow::bail!("{} exited with {status}", binary.display());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests;
