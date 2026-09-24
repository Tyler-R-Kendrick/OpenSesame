//! Flags for `opensesame daemon run`.
use clap::Parser;
use opensesame_host_core::endpoints::{self, DAEMON, HOST, IDENTITY};

/// Flags for `opensesame daemon run`.
#[derive(Parser, Debug)]
#[command(about = "Run the local agent daemon")]
pub struct Args {
    #[arg(long, env = endpoints::listen_env(DAEMON), default_value_t = endpoints::listen_fallback(DAEMON))]
    pub(crate) listen: String,
    /// Optional Unix domain socket (WSL/devcontainer). Env: `OPENSESAME_AGENT_SOCK`.
    #[arg(long, env = "OPENSESAME_AGENT_SOCK")]
    pub(crate) sock: Option<String>,
    /// Host API base for toolbar approve forwarding.
    #[arg(long, env = endpoints::env(HOST), default_value_t = endpoints::fallback(HOST))]
    pub(crate) host_api: String,
    /// Identity API base for claim helpers.
    #[arg(long, env = endpoints::env(IDENTITY), default_value_t = endpoints::fallback(IDENTITY))]
    pub(crate) identity_api: String,
    /// Comma-separated UIDs allowed to call operator routes over the Unix
    /// socket. Default: the daemon's own UID (same-user rule).
    #[arg(long, env = "OPENSESAME_DAEMON_ALLOWED_UIDS")]
    pub(crate) allowed_uids: Option<String>,
}
