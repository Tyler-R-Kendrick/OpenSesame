//! Human-only detection settings. Passwords are read without argv or output exposure.
use clap::{Args, Subcommand, ValueEnum};
use opensesame_human_vault::retired_credentials::Response;
use opensesame_sealed_store::retired_credentials::{
    clear_retired_events, enroll_retired_password, remove_retired_password,
    retired_records_for_owner,
};
use std::io::{self, IsTerminal};
use std::path::PathBuf;
use zeroize::Zeroizing;

#[derive(Debug, Subcommand)]
pub(crate) enum PassSecurityCmd {
    /// Controlled canary identifiers and explicit detector exports.
    #[command(name = "canary", alias = "canaries")]
    Canaries {
        #[command(subcommand)]
        cmd: crate::pass_canary::PassCanaryCmd,
    },
    /// Pair, verify and manage optional independent sealed observation delivery.
    Receiver {
        #[command(subcommand)]
        cmd: crate::pass_receiver::PassReceiverCmd,
    },
    /// Owner-selected retired password traps, separate from duress policies.
    Retired {
        #[command(subcommand)]
        cmd: RetiredCmd,
    },
}
#[derive(Debug, Args)]
pub(crate) struct StoreArgs {
    #[arg(long)]
    path: Option<PathBuf>,
    #[arg(long)]
    tomb: Option<String>,
}
#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum TrapResponse {
    Reject,
    SyntheticDecoy,
}
#[derive(Debug, Subcommand)]
pub(crate) enum RetiredCmd {
    /// Enroll a selected old password; defaults to recording and rejection.
    Enroll {
        #[command(flatten)]
        store: StoreArgs,
        #[arg(long, value_enum, default_value = "reject")]
        response: TrapResponse,
        /// Retaining a password verifier creates an offline guessing target.
        #[arg(long)]
        acknowledge_verifier_risk: bool,
    },
    /// Review trap metadata and local evidence after fresh owner authentication.
    Status {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Remove one selected trap after fresh owner authentication.
    Remove {
        id: String,
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Clear local observations after fresh owner authentication.
    ClearEvents {
        #[command(flatten)]
        store: StoreArgs,
    },
}

pub(crate) fn root(settings: &StoreArgs) -> anyhow::Result<PathBuf> {
    crate::store::resolve_root(settings.path.as_deref(), settings.tomb.as_deref())
}
pub(crate) fn owner(settings: &StoreArgs) -> anyhow::Result<(PathBuf, Zeroizing<String>)> {
    anyhow::ensure!(
        io::stdin().is_terminal(),
        "credential security settings require a human terminal"
    );
    let root = root(settings)?;
    let current = Zeroizing::new(crate::store::prompt_secret_hidden(
        "Current store passphrase",
    )?);
    Ok((root, current))
}
pub(crate) async fn run(server: &str, cmd: PassSecurityCmd) -> anyhow::Result<()> {
    let cmd = match cmd {
        PassSecurityCmd::Canaries { cmd } => return crate::pass_canary::run(server, cmd).await,
        PassSecurityCmd::Receiver { cmd } => return crate::pass_receiver::run(cmd).await,
        PassSecurityCmd::Retired { cmd } => cmd,
    };
    if !io::stdin().is_terminal() {
        anyhow::bail!("retired credential settings require a human terminal");
    }
    let settings = match &cmd {
        RetiredCmd::Enroll { store, .. }
        | RetiredCmd::Status { store }
        | RetiredCmd::Remove { store, .. }
        | RetiredCmd::ClearEvents { store } => store,
    };
    let root = crate::store::resolve_root(settings.path.as_deref(), settings.tomb.as_deref())?;
    let current = Zeroizing::new(crate::store::prompt_secret_hidden(
        "Current store passphrase",
    )?);
    match cmd {
        RetiredCmd::Enroll {
            response,
            acknowledge_verifier_risk,
            ..
        } => {
            if !acknowledge_verifier_risk {
                anyhow::bail!("acknowledge verifier exposure with --acknowledge-verifier-risk");
            }
            let retired = Zeroizing::new(crate::store::prompt_secret_hidden(
                "Selected retired passphrase",
            )?);
            let response = match response {
                TrapResponse::Reject => Response::Reject,
                TrapResponse::SyntheticDecoy => Response::SyntheticDecoy,
            };
            let trap =
                enroll_retired_password(&root, current.as_bytes(), retired.as_bytes(), response)?;
            println!("enrolled {}", trap.id);
        }
        RetiredCmd::Status { .. } => {
            let records = retired_records_for_owner(&root, current.as_bytes())?;
            let traps: Vec<_> = records.traps.iter().map(|trap| serde_json::json!({ "id": trap.id, "createdAt": trap.created_at, "response": trap.response })).collect();
            println!(
                "{}",
                serde_json::json!({ "traps": traps, "events": records.events })
            );
        }
        RetiredCmd::Remove { id, .. } => remove_retired_password(&root, current.as_bytes(), &id)?,
        RetiredCmd::ClearEvents { .. } => clear_retired_events(&root, current.as_bytes())?,
    }
    Ok(())
}
