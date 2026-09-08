//! Native encrypted-sync command arguments and dispatch.
use crate::{load_access_token, read_bounded, sync_export, sync_import, sync_migration};
use clap::Subcommand;
use serde_json::json;
use std::path::PathBuf;

#[derive(Subcommand, Debug)]
pub(super) enum SyncCmd {
    /// Rebind explicitly selected legacy ciphertext after verifying ownership offline.
    #[command(name = "rebind-legacy")]
    RebindLegacy {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        owner: String,
        #[arg(long)]
        organization: String,
        #[arg(long = "revision", required = true)]
        revisions: Vec<String>,
        #[arg(long)]
        evidence_digest: String,
        #[arg(long)]
        confirm_rebind: bool,
    },
    /// Upload a JSON array of ciphertext blobs.
    Push { input: PathBuf },
    /// Download ciphertext blobs to a new JSON file.
    Pull {
        output: PathBuf,
        #[arg(long, default_value_t = 0)]
        since_epoch: u64,
        #[arg(long)]
        device: Option<String>,
    },
}

pub(super) async fn sync_cmd(server: &str, cmd: SyncCmd) -> anyhow::Result<()> {
    if let SyncCmd::RebindLegacy {
        database,
        owner,
        organization,
        revisions,
        evidence_digest,
        confirm_rebind,
    } = cmd
    {
        return sync_migration::rebind(
            &database,
            opensesame_domain::PrincipalId::parse(&owner)?,
            opensesame_domain::OrganizationId::parse(&organization)?,
            revisions,
            evidence_digest,
            confirm_rebind,
        )
        .await;
    }
    let token = load_access_token()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let base = server.trim_end_matches('/');
    match cmd {
        SyncCmd::Push { input } => {
            if sync_import::try_push(&client, base, &token, &input).await? {
                return Ok(());
            }
            let value: serde_json::Value = serde_json::from_slice(&read_bounded(&input)?)?;
            let blobs = value
                .as_array()
                .cloned()
                .or_else(|| value.get("blobs").and_then(|v| v.as_array()).cloned())
                .ok_or_else(|| {
                    anyhow::anyhow!("sync input must be a JSON array of ciphertext blobs")
                })?;
            let response: serde_json::Value = client
                .post(format!("{base}/api/v1/sync/push"))
                .bearer_auth(token)
                .json(&json!({"blobs": blobs}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            println!("{}", serde_json::to_string_pretty(&response)?);
        }
        SyncCmd::Pull {
            output,
            since_epoch,
            device,
        } => {
            sync_export::pull(&client, base, &token, &output, since_epoch, device).await?;
        }
        SyncCmd::RebindLegacy { .. } => {
            unreachable!("offline migration returned before credential loading")
        }
    }
    Ok(())
}
