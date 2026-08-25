//! Peer-credential attestation for Unix domain socket callers (ADR 0048 §8).
//!
//! Loopback is not a boundary: any co-resident process can dial a TCP port, so
//! the daemon's operator routes carry a bearer token there. A Unix domain
//! socket is different — the kernel will attest *which process* is on the
//! other end, and identity from the platform beats identity from a presented
//! secret (the SPIFFE Workload API pattern, without SPIFFE). This crate reads
//! that attestation (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` + `LOCAL_PEERPID`
//! on macOS) and applies a same-user allowlist policy.
//!
//! Fail-closed everywhere: a lookup error, an empty allowlist, or a foreign
//! UID all deny. Only [`authorize`] and [`parse_allowed_uids`] are portable;
//! the credential extraction itself is Unix-only and `cfg`-gated.

/// Kernel-attested identity of the process on the other end of a UDS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerCred {
    pub pid: u32,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthnError {
    #[error("peer credential lookup failed: {0}")]
    Lookup(String),
    #[error("peer credential attestation is not supported on this platform")]
    Unsupported,
    #[error("peer uid {uid} is not in the allowed uid set")]
    ForeignUid { uid: u32 },
    #[error("allowed uid set is empty; denying every peer")]
    EmptyAllowlist,
}

/// Extract the kernel-attested credentials of a connected UDS peer.
#[cfg(unix)]
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn peer_cred<S: std::os::fd::AsFd>(stream: &S) -> Result<PeerCred, AuthnError> {
    platform_peer_cred(stream)
}

/// Peer attestation has no non-Unix equivalent in v1 (ADR 0048 §8: Windows is
/// TCP plus operator token only), so this stub always fails closed.
#[cfg(not(unix))]
pub fn peer_cred<S>(_stream: &S) -> Result<PeerCred, AuthnError> {
    Err(AuthnError::Unsupported)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn platform_peer_cred<S: std::os::fd::AsFd>(stream: &S) -> Result<PeerCred, AuthnError> {
    let cred = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
        .map_err(|e| AuthnError::Lookup(e.to_string()))?;
    let pid = u32::try_from(cred.pid()).map_err(|_| AuthnError::Lookup("negative pid".into()))?;
    Ok(PeerCred {
        pid,
        uid: cred.uid(),
        gid: cred.gid(),
    })
}

#[cfg(target_os = "macos")]
fn platform_peer_cred<S: std::os::fd::AsFd>(stream: &S) -> Result<PeerCred, AuthnError> {
    let xu = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::LocalPeerCred)
        .map_err(|e| AuthnError::Lookup(e.to_string()))?;
    let pid = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::LocalPeerPid)
        .map_err(|e| AuthnError::Lookup(e.to_string()))?;
    let pid = u32::try_from(pid).map_err(|_| AuthnError::Lookup("negative pid".into()))?;
    // The first xucred group is the effective gid; an empty group list is not
    // a reason to leak, so fall back to the uid for a same-user gid.
    let gid = xu.groups().first().copied().unwrap_or_else(|| xu.uid());
    Ok(PeerCred {
        pid,
        uid: xu.uid(),
        gid,
    })
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn platform_peer_cred<S: std::os::fd::AsFd>(_stream: &S) -> Result<PeerCred, AuthnError> {
    Err(AuthnError::Unsupported)
}

/// Fail-closed authorization: `peer` passes only when its UID is listed, and
/// an empty allowlist denies everyone rather than letting anyone through.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn authorize(peer: &PeerCred, allowed_uids: &[u32]) -> Result<(), AuthnError> {
    if allowed_uids.is_empty() {
        return Err(AuthnError::EmptyAllowlist);
    }
    if allowed_uids.contains(&peer.uid) {
        Ok(())
    } else {
        Err(AuthnError::ForeignUid { uid: peer.uid })
    }
}

/// The default allowlist: exactly the daemon's own effective UID, i.e. the
/// same-user rule — only processes running as the user who started the daemon
/// may call its operator routes over the socket.
#[cfg(unix)]
#[must_use]
pub fn default_allowed_uids() -> Vec<u32> {
    vec![nix::unistd::geteuid().as_raw()]
}

#[cfg(not(unix))]
pub fn default_allowed_uids() -> Vec<u32> {
    Vec::new()
}

/// Parse a comma-separated UID list (`OPENSESAME_DAEMON_ALLOWED_UIDS`).
/// Malformed entries are dropped, not guessed at; an all-malformed value
/// yields an empty list, which [`authorize`] treats as deny-all.
#[must_use]
pub fn parse_allowed_uids(csv: &str) -> Vec<u32> {
    csv.split(',')
        .filter_map(|part| part.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOME_PEER: PeerCred = PeerCred {
        pid: 4242,
        uid: 1000,
        gid: 1000,
    };

    #[test]
    fn same_uid_authorizes() {
        assert!(authorize(&SOME_PEER, &[1000]).is_ok());
        assert!(authorize(&SOME_PEER, &[0, 1000, 1001]).is_ok());
    }

    #[test]
    fn foreign_uid_fails_closed() {
        assert_eq!(
            authorize(&SOME_PEER, &[1001]),
            Err(AuthnError::ForeignUid { uid: 1000 })
        );
    }

    #[test]
    fn empty_allowlist_denies() {
        assert_eq!(authorize(&SOME_PEER, &[]), Err(AuthnError::EmptyAllowlist));
    }

    #[test]
    fn parse_allowed_uids_tolerates_junk() {
        assert_eq!(parse_allowed_uids("1000, 1001"), vec![1000, 1001]);
        assert_eq!(parse_allowed_uids(" 0 ,abc,,"), vec![0]);
        assert_eq!(parse_allowed_uids(""), Vec::<u32>::new());
        assert_eq!(parse_allowed_uids("nope"), Vec::<u32>::new());
    }

    /// The kernel attests *us* on a socketpair: the peer of either end is
    /// this process, so pid and uid must come back as our own.
    #[cfg(target_os = "linux")]
    #[test]
    fn socketpair_peer_cred_returns_own_identity() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().expect("socketpair");
        let cred = peer_cred(&a).expect("peer cred");
        assert_eq!(cred.pid, std::process::id());
        assert_eq!(cred.uid, default_allowed_uids()[0]);
        // And the loopback attestation must satisfy the same-user rule.
        assert!(authorize(&cred, &default_allowed_uids()).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn listener_accepted_stream_carries_peer_cred() {
        let dir = std::env::temp_dir().join(format!("uds-authn-test-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let listener = std::os::unix::net::UnixListener::bind(&dir).expect("bind");
        let client = std::os::unix::net::UnixStream::connect(&dir).expect("connect");
        let (server, _) = listener.accept().expect("accept");
        let cred = peer_cred(&server).expect("peer cred");
        assert_eq!(cred.pid, std::process::id());
        drop(client);
        let _ = std::fs::remove_file(&dir);
    }
}
