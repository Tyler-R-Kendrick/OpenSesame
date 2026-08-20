//! Peer-credential attestation for daemon UDS callers (ADR 0048 §8, D5).
//!
//! Over the Unix socket the kernel attests the caller, so operator routes
//! authenticate with [`opensesame_uds_authn`] instead of the operator bearer
//! token — identity from the platform, not from a presented secret. Over TCP
//! nothing changes: the bearer token remains the break-glass path.
//!
//! The attestation is captured per connection by [`UdsConnectInfo`], wired in
//! via `Router::into_make_service_with_connect_info` on the UDS listener
//! only. A request carrying `ConnectInfo<UdsConnectInfo>` came over the
//! socket; one without it came over TCP.

#[cfg(unix)]
use axum::extract::connect_info::Connected;
#[cfg(unix)]
use axum::serve::IncomingStream;

/// Connect info for the daemon's Unix socket: the kernel-attested peer
/// credentials, or `None` when the lookup itself failed. `None` must deny —
/// a caller we cannot attest is not the same user as far as we can prove.
#[derive(Clone, Copy, Debug)]
pub struct UdsConnectInfo(pub Option<opensesame_uds_authn::PeerCred>);

#[cfg(unix)]
impl Connected<IncomingStream<'_, tokio::net::UnixListener>> for UdsConnectInfo {
    fn connect_info(stream: IncomingStream<'_, tokio::net::UnixListener>) -> Self {
        Self(opensesame_uds_authn::peer_cred(stream.io()).ok())
    }
}

/// Resolve the allowed-UID set for UDS operator routes: the
/// `OPENSESAME_DAEMON_ALLOWED_UIDS` CSV when given, otherwise the same-user
/// rule (exactly the daemon's own effective UID).
pub fn allowed_uids(cli_value: Option<&str>) -> Vec<u32> {
    match cli_value {
        Some(csv) => opensesame_uds_authn::parse_allowed_uids(csv),
        None => opensesame_uds_authn::default_allowed_uids(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_uids_defaults_to_same_user() {
        assert_eq!(
            allowed_uids(None),
            opensesame_uds_authn::default_allowed_uids()
        );
    }

    #[test]
    fn allowed_uids_honors_csv_override() {
        assert_eq!(allowed_uids(Some("1000, 0")), vec![1000, 0]);
        // An all-junk override parses to empty, and empty denies everyone.
        assert_eq!(allowed_uids(Some("junk")), Vec::<u32>::new());
    }
}
