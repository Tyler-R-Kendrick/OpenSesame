//! Ownership probing for **singleton** local endpoints (constitution C7).
//!
//! `$XDG_RUNTIME_DIR/org.keepassxc.KeePassXC.BrowserServer` is a name only one
//! process can hold. Binding it blindly is how a bridge silently breaks the
//! real `KeePassXC`: the browser extension keeps working, the passwords come
//! from the wrong place, and nobody is told. So before binding, ask who is
//! there, and refuse with a diagnostic that *names the owner* rather than
//! stealing the name.
//!
//! Three answers matter:
//!
//! - [`SocketState::Free`] — nothing at the path; bind away.
//! - [`SocketState::Live`] — someone is accepting connections. Refuse, and say
//!   who (the peer's pid and executable name, where the kernel will tell us).
//! - [`SocketState::Stale`] — the file exists but nothing is listening (a
//!   crashed owner). This, and only this, is what `--takeover` may unlink.

use std::path::{Path, PathBuf};

/// Who owns a socket path right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketState {
    /// Nothing exists at the path.
    Free,
    /// A live server is accepting connections there.
    Live { owner: SocketOwner },
    /// The path exists but no server is listening — a crash leftover.
    Stale,
    /// Something is at the path that is not a socket at all.
    NotASocket,
}

/// Best-effort identity of a live socket's owner.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SocketOwner {
    pub pid: Option<i32>,
    pub process: Option<String>,
}

impl std::fmt::Display for SocketOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.process, self.pid) {
            (Some(name), Some(pid)) => write!(f, "{name} (pid {pid})"),
            (Some(name), None) => write!(f, "{name}"),
            (None, Some(pid)) => write!(f, "pid {pid}"),
            (None, None) => write!(f, "an unidentified process"),
        }
    }
}

impl SocketState {
    /// A one-line operator diagnostic. Never contains secret material.
    #[must_use]
    pub fn diagnostic(&self, path: &Path) -> String {
        match self {
            SocketState::Free => format!("{} is free", path.display()),
            SocketState::Live { owner } => format!(
                "{} is already served by {owner}; refusing to take over a live endpoint \
                 (use the stdio native-messaging host instead, or stop the other server)",
                path.display()
            ),
            SocketState::Stale => format!(
                "{} is a stale socket with no listener; re-run with --takeover to remove it",
                path.display()
            ),
            SocketState::NotASocket => format!(
                "{} exists but is not a unix socket; refusing to remove it",
                path.display()
            ),
        }
    }
}

/// The conventional `KeePassXC` browser-server socket path.
///
/// `KeePassXC` uses `$XDG_RUNTIME_DIR/org.keepassxc.KeePassXC.BrowserServer`,
/// falling back to `$TMPDIR`/`/tmp` when the runtime dir is unset. Flatpak
/// installs additionally nest it under `app/org.keepassxc.KeePassXC/`; that
/// layout is out of scope for v1 and documented as such.
pub const KEEPASSXC_SOCKET_NAME: &str = "org.keepassxc.KeePassXC.BrowserServer";

/// Default socket path for the `KeePassXC` browser server.
pub fn keepassxc_socket_path() -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("TMPDIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join(KEEPASSXC_SOCKET_NAME)
}

/// Probe a unix socket path without disturbing whoever owns it.
#[cfg(unix)]
#[must_use]
pub fn probe_unix_socket(path: &Path) -> SocketState {
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::net::UnixStream;

    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return SocketState::Free;
    };
    if !meta.file_type().is_socket() {
        return SocketState::NotASocket;
    }
    match UnixStream::connect(path) {
        Ok(stream) => SocketState::Live {
            owner: peer_owner(&stream),
        },
        // ECONNREFUSED: the inode is there, the listener is not.
        Err(_) => SocketState::Stale,
    }
}

#[cfg(not(unix))]
pub fn probe_unix_socket(_path: &Path) -> SocketState {
    SocketState::Free
}

/// Remove a socket path, but only when it is provably dead.
///
/// A live endpoint is never unlinked, no matter what the caller asked for —
/// `--takeover` is a recovery tool for crashed servers, not a way to evict
/// `KeePassXC`.
///
/// # Errors
///
/// Returns an I/O error only when removing a verified-stale socket fails.
#[cfg(unix)]
pub fn takeover_if_dead(path: &Path) -> Result<SocketState, crate::BridgeError> {
    let state = probe_unix_socket(path);
    if state == SocketState::Stale {
        std::fs::remove_file(path)?;
        return Ok(SocketState::Free);
    }
    Ok(state)
}

#[cfg(not(unix))]
pub fn takeover_if_dead(path: &Path) -> Result<SocketState, crate::BridgeError> {
    Ok(probe_unix_socket(path))
}

/// Ask the kernel who is on the other end of a connected unix socket.
#[cfg(target_os = "linux")]
fn peer_owner(stream: &std::os::unix::net::UnixStream) -> SocketOwner {
    use std::os::fd::AsRawFd;

    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let Some(mut len) = socklen_from_usize(std::mem::size_of::<libc::ucred>()) else {
        return SocketOwner::default();
    };
    // SAFETY: `cred` and `len` are correctly sized for SO_PEERCRED on a
    // connected AF_UNIX socket, and the fd is owned by `stream` for the call.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut cred).cast::<libc::c_void>(),
            &raw mut len,
        )
    };
    if rc != 0 || cred.pid <= 0 {
        return SocketOwner::default();
    }
    SocketOwner {
        pid: Some(cred.pid),
        process: process_name(cred.pid),
    }
}

#[cfg(target_os = "linux")]
fn socklen_from_usize(len: usize) -> Option<libc::socklen_t> {
    libc::socklen_t::try_from(len).ok()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn peer_owner(_stream: &std::os::unix::net::UnixStream) -> SocketOwner {
    // SO_PEERCRED is Linux-specific; macOS `LOCAL_PEERPID` is left for a
    // follow-up rather than guessed at.
    SocketOwner::default()
}

#[cfg(target_os = "linux")]
fn process_name(pid: i32) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let comm = comm.trim();
    if comm.is_empty() {
        None
    } else {
        Some(comm.to_string())
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn a_missing_path_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nothing.sock");
        assert_eq!(probe_unix_socket(&path), SocketState::Free);
        assert!(probe_unix_socket(&path).diagnostic(&path).contains("free"));
    }

    #[test]
    fn a_listening_socket_is_live() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        let state = probe_unix_socket(&path);
        match &state {
            SocketState::Live { owner } => {
                // On Linux the kernel names us; elsewhere the owner is blank.
                if cfg!(target_os = "linux") {
                    let pid = i32::try_from(std::process::id()).expect("test pid fits i32");
                    assert_eq!(owner.pid, Some(pid));
                }
            }
            other => panic!("expected Live, got {other:?}"),
        }
        assert!(state.diagnostic(&path).contains("refusing to take over"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn socket_length_conversion_rejects_values_outside_socklen_t() {
        assert_eq!(
            socklen_from_usize(std::mem::size_of::<libc::ucred>()),
            Some(
                libc::socklen_t::try_from(std::mem::size_of::<libc::ucred>())
                    .expect("ucred size fits socklen_t")
            )
        );
        if usize::BITS > libc::socklen_t::BITS {
            assert_eq!(socklen_from_usize(usize::MAX), None);
        }
    }

    #[test]
    fn a_socket_with_no_listener_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale.sock");
        let listener = UnixListener::bind(&path).unwrap();
        drop(listener); // the inode survives; the listener does not
        assert_eq!(probe_unix_socket(&path), SocketState::Stale);
        assert!(probe_unix_socket(&path)
            .diagnostic(&path)
            .contains("--takeover"));
    }

    #[test]
    fn a_regular_file_is_not_a_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.file");
        std::fs::write(&path, b"not a socket").unwrap();
        assert_eq!(probe_unix_socket(&path), SocketState::NotASocket);
    }

    #[test]
    fn takeover_removes_only_a_dead_socket() {
        let dir = tempfile::tempdir().unwrap();

        let stale = dir.path().join("stale.sock");
        drop(UnixListener::bind(&stale).unwrap());
        assert_eq!(takeover_if_dead(&stale).unwrap(), SocketState::Free);
        assert!(!stale.exists());

        let live = dir.path().join("live.sock");
        let _listener = UnixListener::bind(&live).unwrap();
        assert!(matches!(
            takeover_if_dead(&live).unwrap(),
            SocketState::Live { .. }
        ));
        assert!(live.exists());

        let plain = dir.path().join("plain.file");
        std::fs::write(&plain, b"x").unwrap();
        assert_eq!(takeover_if_dead(&plain).unwrap(), SocketState::NotASocket);
        assert!(plain.exists());
    }

    #[test]
    fn socket_path_follows_xdg_runtime_dir() {
        let previous = std::env::var_os("XDG_RUNTIME_DIR");
        std::env::set_var("XDG_RUNTIME_DIR", "/run/user/4242");
        assert_eq!(
            keepassxc_socket_path(),
            PathBuf::from("/run/user/4242").join(KEEPASSXC_SOCKET_NAME)
        );
        match previous {
            Some(v) => std::env::set_var("XDG_RUNTIME_DIR", v),
            None => std::env::remove_var("XDG_RUNTIME_DIR"),
        }
    }

    #[test]
    fn owner_display_degrades_gracefully() {
        assert_eq!(
            SocketOwner::default().to_string(),
            "an unidentified process"
        );
        assert_eq!(
            SocketOwner {
                pid: Some(7),
                process: Some("keepassxc".into())
            }
            .to_string(),
            "keepassxc (pid 7)"
        );
        assert_eq!(
            SocketOwner {
                pid: Some(7),
                process: None
            }
            .to_string(),
            "pid 7"
        );
        assert_eq!(
            SocketOwner {
                pid: None,
                process: Some("k".into())
            }
            .to_string(),
            "k"
        );
    }
}
