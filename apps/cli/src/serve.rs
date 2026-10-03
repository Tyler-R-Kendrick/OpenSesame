//! The long-running roles of this binary: the Host API (`opensesame host run`),
//! the local agent daemon (`opensesame daemon run`) and the workload connector
//! host (`opensesame worker run`). One binary serves every native role; the
//! role is the subcommand, not a separate executable (ADR 0138).
use crate::Commands;
use clap::Subcommand;
use opensesame_redaction::{Format, ScrubMakeWriter};

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
///
/// Every sink is wrapped in a scrubbing writer (ADR 0157): a call site that
/// logs a secret by mistake, a library error that echoes a URL with a token in
/// it and a panic message all reach the collector or the file already scrubbed.
/// With `OPENSESAME_LOG_FILE` set the server's lines are sealed into that file
/// instead of written to stdout.
pub fn init_tracing(command: &Commands) {
    match command {
        Commands::Host { .. } => init_host(),
        Commands::Worker { .. } => init_text(),
        Commands::Daemon(args) if args.is_run() => init_text(),
        _ => tracing_subscriber::fmt()
            .with_env_filter("warn")
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(std::io::stderr, Format::Text))
            .init(),
    }
}

fn init_host() {
    let filter = "info,tower_http=info";
    match crate::log_sink::from_env() {
        Some(sink) => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .with_writer(ScrubMakeWriter::new(move || sink.writer(), Format::Json))
            .init(),
        None => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .with_writer(ScrubMakeWriter::new(std::io::stdout, Format::Json))
            .init(),
    }
    crate::log_sink::install_panic_hook();
}

fn init_text() {
    match crate::log_sink::from_env() {
        Some(sink) => tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(move || sink.writer(), Format::Text))
            .init(),
        None => tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(std::io::stdout, Format::Text))
            .init(),
    }
    crate::log_sink::install_panic_hook();
}
