//! Human reads from the local sealed store (`vault secret …`).

use clap::Subcommand;

use crate::store;

#[derive(Subcommand, Debug)]
pub enum SecretCmd {
    /// Read one entry. Plaintext requires `--reveal` or a TTY.
    Get {
        name: String,
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<std::path::PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// List entry names under an optional prefix.
    List {
        prefix: Option<String>,
        #[arg(long)]
        path: Option<std::path::PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
}

pub fn run(cmd: SecretCmd) -> anyhow::Result<()> {
    match cmd {
        SecretCmd::Get {
            name,
            reveal,
            path,
            tomb,
        } => store::cmd_show(&name, reveal, path.as_deref(), tomb.as_deref())?,
        SecretCmd::List { prefix, path, tomb } => {
            store::cmd_ls(prefix.as_deref(), path.as_deref(), tomb.as_deref())?;
        }
    }
    Ok(())
}
