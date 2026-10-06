//! One-purpose human-installed MCP validator. No real-vault unlock or production executor.
use clap::Subcommand;
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
#[derive(Debug, Subcommand)]
pub(crate) enum CanaryCmd {
    /// Run the single controlled synthetic MCP tool over bounded stdio.
    Serve {
        #[arg(long)]
        store: Option<PathBuf>,
        #[arg(long)]
        artifact_id: Option<String>,
        #[arg(long)]
        directory: Option<PathBuf>,
        #[arg(long)]
        validator_id: Option<String>,
    },
    /// Explicitly install exported metadata in an existing owner-private detector directory.
    Install {
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        binding_file: PathBuf,
        #[arg(long)]
        approve_vault_identity: String,
        #[arg(long)]
        replace: bool,
    },
    /// Remove only the explicitly installed metadata detector after human confirmation.
    Uninstall {
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        validator_id: String,
    },
    /// Inspect local installed detector metadata after explicit human access.
    Status {
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        validator_id: String,
    },
}
#[cfg(not(unix))]
pub(crate) fn read_file(_path: &Path, _max: usize) -> anyhow::Result<String> {
    anyhow::bail!("settings imports require the protected native platform adapter");
}
#[cfg(unix)]
pub(crate) fn read_file(path: &Path, max: usize) -> anyhow::Result<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "settings input must be a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no parameters or pointer arguments.
        anyhow::ensure!(
            metadata.nlink() == 1
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o777 == 0o600,
            "settings input must be an owner-private file"
        );
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(u64::try_from(max)? + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= max, "settings input exceeds its size limit");
    Ok(std::str::from_utf8(&bytes)?.to_owned())
}
pub(crate) async fn run(cmd: CanaryCmd) -> anyhow::Result<()> {
    match cmd {
        CanaryCmd::Install {
            directory,
            binding_file,
            approve_vault_identity,
            replace,
        } => {
            anyhow::ensure!(
                io::stdin().is_terminal(),
                "validator installation requires a human terminal"
            );
            let raw = read_file(&binding_file, 4096)?;
            let binding =
                opensesame_human_vault::credential_canaries::ValidatorBinding::parse(&raw)?;
            anyhow::ensure!(
                binding.context.vault_identity == approve_vault_identity,
                "explicit validator vault identity confirmation is required"
            );
            let installed = opensesame_sealed_store::credential_canaries::validator::install(
                &directory, &raw, replace,
            )?;
            println!("{}", serde_json::json!({"installed":installed}));
            Ok(())
        }
        CanaryCmd::Uninstall {
            directory,
            validator_id,
        } => {
            anyhow::ensure!(
                io::stdin().is_terminal(),
                "validator removal requires a human terminal"
            );
            opensesame_sealed_store::credential_canaries::validator::uninstall(
                &directory,
                &validator_id,
            )?;
            println!("Removed installed metadata-only validator.");
            Ok(())
        }
        CanaryCmd::Status {
            directory,
            validator_id,
        } => {
            anyhow::ensure!(
                io::stdin().is_terminal(),
                "validator evidence requires a human terminal"
            );
            println!(
                "{}",
                opensesame_sealed_store::credential_canaries::validator::status(
                    &directory,
                    &validator_id
                )?
            );
            Ok(())
        }
        CanaryCmd::Serve {
            store,
            artifact_id,
            directory,
            validator_id,
        } => {
            let token = Zeroizing::new(
                std::env::var("OPENSESAME_CANARY_TOKEN")
                    .map_err(|_| anyhow::anyhow!("controlled validator token is unavailable"))?,
            );
            opensesame_human_vault::credential_canaries::decode_presented_id(&token)?;
            match (store, artifact_id, directory, validator_id) {
                (Some(root), Some(id), None, None) => serve_registered(root, id, token).await,
                (None, None, Some(root), Some(id)) => serve(|request| {
                    opensesame_sealed_store::credential_canaries::validator::handle(
                        &root, &id, &token, request,
                    )
                }),
                _ => anyhow::bail!(
                    "select exactly one installed validator or local controlled artifact"
                ),
            }
        }
    }
}
async fn serve_registered(
    root: PathBuf,
    id: String,
    token: Zeroizing<String>,
) -> anyhow::Result<()> {
    // A single pending kick coalesces attacker traffic. Only pre-paired sealed metadata can leave.
    let (kick, mut pending) = tokio::sync::mpsc::channel::<()>(1);
    let metadata_edits = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    let delivery_edits = metadata_edits.clone();
    let sender_root = root.clone();
    let sender = tokio::spawn(async move {
        while pending.recv().await.is_some() {
            while pending.try_recv().is_ok() {}
            for _ in 0..2 {
                if !matches!(
                    crate::pass_receiver::deliver_serialized(
                        &sender_root,
                        None,
                        false,
                        &delivery_edits,
                    )
                    .await,
                    Ok(true)
                ) {
                    break;
                }
            }
        }
    });
    // Stdio reads cannot stall delivery. No owner secret, root or edit lock enters this worker.
    let result = tokio::task::spawn_blocking(move || {
        serve(|request| {
            let response = {
                let _metadata_edit = metadata_edits.blocking_lock();
                opensesame_sealed_store::credential_canaries::handle_mcp(
                    &root, &id, &token, request,
                )
            };
            // Detection failures cannot regain production authority or become transport payloads.
            let _ = kick.try_send(());
            response
        })
    })
    .await?;
    sender.await?;
    result
}
fn serve(
    mut handler: impl FnMut(
        &str,
    )
        -> Result<Option<serde_json::Value>, opensesame_sealed_store::StoreError>,
) -> anyhow::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    for _ in 0..64 {
        let mut line = Vec::new();
        let count = input.by_ref().take(4098).read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        if line.len() > 4097 || line.last() != Some(&b'\n') {
            anyhow::bail!("controlled MCP message exceeds its limit");
        }
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let result = std::str::from_utf8(&line)
            .ok()
            .and_then(|request| handler(request).ok());
        // Failure responses never echo hostile arguments, credentials, paths or parse details.
        let response=result.unwrap_or_else(||Some(serde_json::json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Controlled validator request refused"}})));
        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}
