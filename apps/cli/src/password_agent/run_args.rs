//! The delivery options of `password-agent run`: one wrapper, three
//! lanes — inject (`--env`), mount (`--mount`), and broker
//! (`--agent-proxy`) — chosen by these flags alone.

use clap::Args;

#[derive(Args, Debug)]
pub(crate) struct RunArgs {
    #[arg(long = "env", required_unless_present = "mount")]
    pub(super) env: Vec<String>,
    /// Mount a referenced secret as a private temp file for the child;
    /// NAME receives the file path and the file is removed afterwards.
    #[arg(long = "mount", required_unless_present = "env")]
    pub(super) mount: Vec<String>,
    /// Broker each --env os:// connections item through the
    /// surrogate-proxy plugin instead of injecting its value: the child
    /// holds a scoped surrogate and the run's proxy environment, never
    /// the credential. Requires --paths and --methods per brokered name.
    #[arg(long = "agent-proxy", conflicts_with = "mount")]
    pub(super) agent_proxy: bool,
    /// Brokered path scope for one name: NAME=/prefix[,/prefix...].
    #[arg(long = "paths", requires = "agent_proxy")]
    pub(super) paths: Vec<String>,
    /// Brokered method scope for one name: NAME=GET[,POST...].
    #[arg(long = "methods", requires = "agent_proxy")]
    pub(super) methods: Vec<String>,
}
