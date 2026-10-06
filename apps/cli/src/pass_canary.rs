//! Fresh human owner canary management; raw bait identifiers are returned once.
use crate::pass_security::StoreArgs;
use clap::{Subcommand, ValueEnum};
use opensesame_human_vault::credential_canaries::ArtifactKind;
#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum CanaryKind {
    ConnectionRef,
    McpConfiguration,
}
#[derive(Debug, Subcommand)]
pub(crate) enum PassCanaryCmd {
    /// Mint a controlled high-entropy bait identifier, shown once to its owner.
    Create {
        #[command(flatten)]
        store: StoreArgs,
        #[arg(long, value_enum)]
        kind: CanaryKind,
    },
    /// Retire an actual configured Host issuance using independent native owner authorization.
    RetireIssued {
        issuer_record_ref: String,
        #[arg(long)]
        allow_loopback: bool,
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Inspect redacted artifact and event metadata after current owner proof.
    Status {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Remove a registered artifact; no production session is altered.
    Remove {
        id: String,
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Clear local observations without resetting the independent receiver budget.
    ClearEvents {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Export controlled MCP metadata for explicit installation; contains no token/root.
    ExportValidator {
        id: String,
        #[arg(long)]
        output_file: std::path::PathBuf,
        #[command(flatten)]
        store: StoreArgs,
    },
}
pub(crate) async fn run(server: &str, cmd: PassCanaryCmd) -> anyhow::Result<()> {
    let store = match &cmd {
        PassCanaryCmd::Create { store, .. }
        | PassCanaryCmd::RetireIssued { store, .. }
        | PassCanaryCmd::Status { store }
        | PassCanaryCmd::Remove { store, .. }
        | PassCanaryCmd::ClearEvents { store }
        | PassCanaryCmd::ExportValidator { store, .. } => store,
    };
    let (root, current) = crate::pass_security::owner(store)?;
    use opensesame_sealed_store::credential_canaries as canaries;
    match cmd {
        PassCanaryCmd::Create { kind, .. } => {
            let kind = match kind {
                CanaryKind::ConnectionRef => ArtifactKind::ConnectionRef,
                CanaryKind::McpConfiguration => ArtifactKind::McpConfiguration,
            };
            let artifact = canaries::create(&root, current.as_bytes(), kind)?;
            let reference =
                opensesame_human_vault::credential_canaries::reference(&artifact.presented_id)?;
            if matches!(kind, ArtifactKind::McpConfiguration) {
                let executable = std::env::current_exe()?;
                let config = serde_json::json!({"mcpServers":{"OpenSesameCanary":{"command":executable,"args":["canary","serve","--store",root,"--artifact-id",artifact.id],"env":{"OPENSESAME_CANARY_TOKEN":artifact.presented_id}}}});
                println!(
                    "{}",
                    serde_json::json!({"artifact":artifact,"reference":reference,"configuration":config})
                );
            } else {
                println!(
                    "{}",
                    serde_json::json!({"artifact":artifact,"reference":reference})
                );
            }
        }
        PassCanaryCmd::RetireIssued {
            issuer_record_ref,
            allow_loopback,
            ..
        } => {
            crate::canary_issuer::retire(root, current, issuer_record_ref, server, allow_loopback)
                .await?;
        }
        PassCanaryCmd::Status { .. } => {
            println!("{}", canaries::status(&root, current.as_bytes())?)
        }
        PassCanaryCmd::Remove { id, .. } => canaries::remove(&root, current.as_bytes(), &id)?,
        PassCanaryCmd::ClearEvents { .. } => canaries::clear_events(&root, current.as_bytes())?,
        PassCanaryCmd::ExportValidator {
            id, output_file, ..
        } => {
            let presented = zeroize::Zeroizing::new(crate::store::prompt_secret_hidden(
                "Selected canary identifier",
            )?);
            let binding = canaries::export_validator(&root, current.as_bytes(), &id, &presented)?;
            crate::write_private_new(&output_file, &serde_json::to_vec(&binding)?)?;
            println!("Exported metadata-only validator binding.");
        }
    }
    Ok(())
}
