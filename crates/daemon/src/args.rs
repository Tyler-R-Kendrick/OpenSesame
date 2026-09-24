//! Flags for `opensesame daemon run`.
use clap::Parser;

/// Flags for `opensesame daemon run`.
#[derive(Parser, Debug)]
#[command(about = "Run the local agent daemon")]
pub struct Args {
    #[arg(
        long,
        env = "OPENSESAME_DAEMON_LISTEN",
        default_value = opensesame_host_core::daemon::DEFAULT_LISTEN
    )]
    pub(crate) listen: String,
    /// Optional Unix domain socket (WSL/devcontainer). Env: `OPENSESAME_AGENT_SOCK`.
    #[arg(long, env = "OPENSESAME_AGENT_SOCK")]
    pub(crate) sock: Option<String>,
    /// Host API base for toolbar approve forwarding.
    #[arg(
        long,
        env = "OPENSESAME_SERVER",
        default_value = "http://127.0.0.1:8787"
    )]
    pub(crate) host_api: String,
    /// Identity API base for claim helpers.
    #[arg(
        long,
        env = "OPENSESAME_ISSUER",
        default_value = "http://127.0.0.1:8788"
    )]
    pub(crate) identity_api: String,
    /// Comma-separated UIDs allowed to call operator routes over the Unix
    /// socket. Default: the daemon's own UID (same-user rule).
    #[arg(long, env = "OPENSESAME_DAEMON_ALLOWED_UIDS")]
    pub(crate) allowed_uids: Option<String>,
}
