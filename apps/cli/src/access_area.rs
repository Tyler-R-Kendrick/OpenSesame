//! Access commands, grouped the way the Access section is: grants, sessions,
//! connectors, and resources.

use std::path::PathBuf;

use clap::Subcommand;

use super::{
    CeremonyCmd, CertCmd, ConnectionCmd, IntentCmd, LeaseCmd, LifecycleCmd, LifecycleHookCmd,
    ReceiptCmd, RotateCmd, TaskCmd,
};
use crate::local_authority::LocalAuthorityCommand;

#[derive(Subcommand, Debug)]
pub(crate) enum AccessArea {
    /// Grants, leases, and task-scoped authority.
    Grants {
        #[command(subcommand)]
        cmd: AccessGrants,
    },
    /// Session receipts.
    Sessions {
        #[command(subcommand)]
        cmd: AccessSessions,
    },
    /// Connectors, their configuration, and registration ceremonies.
    Connectors {
        #[command(subcommand)]
        cmd: AccessConnectors,
    },
    /// Resources a grant can invoke, and the certificates in front of them.
    Resources {
        #[command(subcommand)]
        cmd: AccessResources,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum AccessGrants {
    /// Approve a paired browser or launch a narrowly scoped local agent.
    #[command(name = "local-authority")]
    LocalAuthority {
        #[command(subcommand)]
        cmd: LocalAuthorityCommand,
    },
    /// Acquire or revoke a short-lived credential lease (human CLI only).
    Lease {
        #[command(subcommand)]
        cmd: LeaseCmd,
    },
    /// Task-scoped authority (immutable ceiling + trust ratchet).
    Task {
        #[command(subcommand)]
        cmd: TaskCmd,
    },
    /// Freeze a task-bound intent via Host API.
    Intent {
        #[command(subcommand)]
        cmd: IntentCmd,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum AccessSessions {
    Receipt {
        #[command(subcommand)]
        cmd: ReceiptCmd,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum AccessConnectors {
    /// Create, attach, and invoke connectors by `service/name`.
    Connect(crate::connect::ConnectArgs),
    /// First-class connection configuration (alias: connector).
    #[command(alias = "connector")]
    Connection {
        #[command(subcommand)]
        cmd: ConnectionCmd,
    },
    /// Export non-secret native connection configuration.
    Export {
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Import non-secret native connection configuration.
    Import { input: PathBuf },
    /// Sandboxed rotation runs: what is running, what it did, and taking over.
    Rotate {
        #[command(subcommand)]
        cmd: RotateCmd,
    },
    /// Connector registration ceremonies: what this build can set up for you.
    Ceremony {
        #[command(subcommand)]
        cmd: CeremonyCmd,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum AccessResources {
    Invoke {
        /// `ConnectionRef` URI (conn://...) or logical name — never a `SecretRef`.
        #[arg(long = "connection-ref", alias = "connection")]
        connection_ref: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        resource: String,
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long, default_value = "1")]
        invoke_level: u8,
    },
    /// Issue TLS certificates with an automatically selected Host-owned issuer.
    Cert {
        #[command(subcommand)]
        cmd: CertCmd,
    },
    /// Expiry lifecycle: what is due, who is subscribed, and what was delivered.
    Lifecycle {
        #[command(subcommand)]
        cmd: LifecycleCmd,
    },
}

pub(crate) async fn run(server: &str, output: &str, cmd: AccessArea) -> anyhow::Result<()> {
    match cmd {
        AccessArea::Grants { cmd } => grants(server, output, cmd).await,
        AccessArea::Sessions { cmd } => sessions(server, cmd).await,
        AccessArea::Connectors { cmd } => connectors(server, output, cmd).await,
        AccessArea::Resources { cmd } => resources(server, output, cmd).await,
    }
}

async fn grants(server: &str, output: &str, cmd: AccessGrants) -> anyhow::Result<()> {
    match cmd {
        AccessGrants::LocalAuthority { cmd } => crate::local_authority::run(server, cmd).await,
        AccessGrants::Lease { cmd } => super::lease_cmd(server, cmd).await,
        AccessGrants::Task { cmd } => super::task_cmd(server, output, cmd).await,
        AccessGrants::Intent { cmd } => super::intent_cmd(server, output, cmd).await,
    }
}

async fn sessions(server: &str, cmd: AccessSessions) -> anyhow::Result<()> {
    match cmd {
        AccessSessions::Receipt {
            cmd: ReceiptCmd::Verify { id },
        } => super::verify_receipt(server, &id).await,
    }
}

async fn connectors(server: &str, output: &str, cmd: AccessConnectors) -> anyhow::Result<()> {
    match cmd {
        AccessConnectors::Connect(args) => crate::connect::run(server, args).await,
        AccessConnectors::Connection { cmd } => super::connection_cmd(server, output, cmd).await,
        AccessConnectors::Export { output } => super::export_connections(server, output).await,
        AccessConnectors::Import { input } => super::import_connections(server, input).await,
        AccessConnectors::Rotate { cmd } => match cmd {
            RotateCmd::Runs => crate::agent_runs::cmd_runs(server, output).await,
            RotateCmd::Watch { run, after, follow } => {
                crate::agent_runs::cmd_watch(server, output, &run, after, follow).await
            }
            RotateCmd::Attach { run } => crate::agent_runs::cmd_attach(server, output, &run).await,
            RotateCmd::Hooks { run, after, follow } => {
                crate::agent_run_hooks::cmd_hooks(server, output, &run, after, follow).await
            }
            RotateCmd::Recipe { cmd } => {
                crate::rotate_recipes::run_recipe(server, output, cmd).await
            }
            RotateCmd::Signer { cmd } => {
                crate::rotate_recipes::run_signer(server, output, cmd).await
            }
        },
        // The catalog is compiled in. This verb is read before a Host exists.
        AccessConnectors::Ceremony { cmd } => match cmd {
            CeremonyCmd::List => crate::ceremony::cmd_list(output),
            CeremonyCmd::Show { provider } => crate::ceremony::cmd_show(output, &provider),
        },
    }
}

async fn resources(server: &str, output: &str, cmd: AccessResources) -> anyhow::Result<()> {
    match cmd {
        AccessResources::Invoke {
            connection_ref,
            operation,
            resource,
            input,
            invoke_level,
        } => {
            super::invoke(
                server,
                &connection_ref,
                &operation,
                &resource,
                input,
                invoke_level,
            )
            .await
        }
        AccessResources::Cert { cmd } => match cmd {
            CertCmd::Ca { out } => crate::certs::cmd_ca(server, output, out).await,
            CertCmd::Issue {
                common_name,
                dns,
                ips,
                ttl_hours,
                out_dir,
                reveal,
            } => {
                crate::certs::cmd_issue(
                    server,
                    output,
                    crate::certs::IssueOptions {
                        common_name,
                        dns,
                        ips,
                        ttl_hours,
                        out_dir,
                        reveal,
                    },
                )
                .await
            }
            CertCmd::Ls => crate::certs::cmd_ls(server, output).await,
            CertCmd::Key { id, reveal, out } => {
                crate::certs::cmd_key(server, output, &id, reveal, out).await
            }
        },
        AccessResources::Lifecycle { cmd } => match cmd {
            LifecycleCmd::Expiring => crate::lifecycle::cmd_expiring(server, output).await,
            LifecycleCmd::Hooks => crate::lifecycle::cmd_hooks(server, output).await,
            LifecycleCmd::Hook { cmd } => match cmd {
                LifecycleHookCmd::Add {
                    name,
                    url,
                    events,
                    subject_kinds,
                } => {
                    crate::lifecycle::cmd_hook_add(
                        server,
                        output,
                        crate::lifecycle::HookOptions {
                            name,
                            url,
                            events,
                            subject_kinds,
                        },
                    )
                    .await
                }
                LifecycleHookCmd::Rm { id } => {
                    crate::lifecycle::cmd_hook_rm(server, output, &id).await
                }
            },
            LifecycleCmd::Deliveries { limit } => {
                crate::lifecycle::cmd_deliveries(server, output, limit).await
            }
            LifecycleCmd::Scan => crate::lifecycle::cmd_scan(server, output).await,
        },
    }
}
