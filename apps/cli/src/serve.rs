//! Long-running roles of this binary. Host API and daemon are gone
//! (Tyler 2026-10-08). The only server role left is the optional vault-relay
//! peer (ADR 0181): `opensesame relay run`.
use crate::Commands;
use clap::Subcommand;
use opensesame_redaction::{Format, ScrubMakeWriter};

/// `opensesame relay`.
#[derive(Subcommand, Debug)]
pub enum RelayCmd {
    /// Serve the optional vault-relay peer until it is stopped.
    Run(Box<opensesame_gateway::Args>),
}

pub async fn relay(cmd: RelayCmd) -> anyhow::Result<()> {
    match cmd {
        RelayCmd::Run(args) => opensesame_gateway::run(*args).await,
    }
}

/// Relay logs to stdout at `info` as JSON lines; every other command logs
/// warnings to stderr. Every sink is scrubbed (ADR 0157).
pub fn init_tracing(command: &Commands) {
    match command {
        Commands::Relay { .. } => init_relay(),
        _ => tracing_subscriber::fmt()
            .with_env_filter("warn")
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(std::io::stderr, Format::Text))
            .init(),
    }
}

fn init_relay() {
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
