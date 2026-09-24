//! The long-running roles of this binary: the Host API (`opensesame host run`),
//! the local agent daemon (`opensesame daemon run`) and the workload connector
//! host (`opensesame worker run`). One binary serves every native role; the
//! role is the subcommand, not a separate executable (ADR 0138).
use crate::Commands;
use clap::Subcommand;

/// `opensesame host`.
#[derive(Subcommand, Debug)]
pub enum HostCmd {
    /// Serve the Host API until it is stopped.
    Run(Box<opensesame_gateway::Args>),
}

/// `opensesame worker`.
#[derive(Subcommand, Debug)]
pub enum WorkerCmd {
    /// Serve the workload connector host until it is stopped.
    Run(Box<opensesame_worker::Args>),
}

pub async fn host(cmd: HostCmd) -> anyhow::Result<()> {
    match cmd {
        HostCmd::Run(args) => opensesame_gateway::run(*args).await,
    }
}

pub async fn worker(cmd: WorkerCmd) -> anyhow::Result<()> {
    match cmd {
        WorkerCmd::Run(args) => opensesame_worker::run(*args).await,
    }
}

/// A server logs to stdout at `info` (the Host API as JSON lines, as its
/// collectors expect); every other command logs warnings to stderr so its
/// stdout stays the command's output.
pub fn init_tracing(command: &Commands) {
    match command {
        Commands::Host { .. } => tracing_subscriber::fmt()
            .with_env_filter("info,tower_http=info")
            .json()
            .init(),
        Commands::Worker { .. } => tracing_subscriber::fmt().init(),
        Commands::Daemon(args) if args.is_run() => tracing_subscriber::fmt().init(),
        _ => tracing_subscriber::fmt()
            .with_env_filter("warn")
            .with_writer(std::io::stderr)
            .init(),
    }
}
