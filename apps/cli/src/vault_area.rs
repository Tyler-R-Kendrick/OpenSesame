//! Vault commands: the same work the Vault section covers, plus the sealed store.
use std::path::PathBuf;

use super::{PassAttachCmd, PassCmd, PassTombCmd};
use crate::{attach, pass_otp, pass_protect, store};
use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub(crate) enum VaultArea {
    /// Open a Pages vault export or offline backup with its master password.
    Verify { file: PathBuf },
    /// List its items: path and kind, never values.
    Ls { file: PathBuf },
    /// Inspect password-wrapper KDF metadata without deriving a key.
    Inspect { input: PathBuf },
    /// Rewrap a local password wrapper into the portable KDF policy.
    Migrate {
        input: PathBuf,
        output: PathBuf,
        #[arg(long)]
        memory_kib: u32,
        #[arg(long)]
        passes: u32,
    },
    /// Password-store management (`pass` parity): init, insert, show, ls, …
    Pass {
        #[command(subcommand)]
        cmd: super::PassCmd,
    },
    /// Explicit human-only provider reads. Never exposed through MCP or agent APIs.
    Secret {
        #[command(subcommand)]
        cmd: super::SecretCmd,
    },
    /// Push or pull server-blind encrypted blobs.
    Sync {
        #[command(subcommand)]
        cmd: crate::sync_commands::SyncCmd,
    },
    /// Encrypt or decrypt files without placing plaintext in argv or stdout.
    Crypto {
        #[command(subcommand)]
        cmd: super::CryptoCmd,
    },
}

pub(crate) async fn run(server: &str, output: &str, cmd: VaultArea) -> anyhow::Result<()> {
    match cmd {
        VaultArea::Verify { file } => {
            crate::vault_file::run(output, &crate::vault_file::VaultCmd::Verify { file })?;
        }
        VaultArea::Ls { file } => {
            crate::vault_file::run(output, &crate::vault_file::VaultCmd::Ls { file })?;
        }
        VaultArea::Inspect { input } => crate::vault_migration::inspect(&input)?,
        VaultArea::Migrate {
            input,
            output,
            memory_kib,
            passes,
        } => crate::vault_migration::migrate(&input, &output, memory_kib, passes)?,
        VaultArea::Pass { cmd } => run_pass(server, cmd).await?,
        VaultArea::Secret { cmd } => super::secret_cmd(server, cmd).await?,
        VaultArea::Sync { cmd } => crate::sync_commands::sync_cmd(server, cmd).await?,
        VaultArea::Crypto { cmd } => super::crypto_cmd(server, cmd).await?,
    }
    Ok(())
}

async fn run_pass(server: &str, cmd: super::PassCmd) -> anyhow::Result<()> {
    match cmd {
        cmd @ (PassCmd::Init { .. }
        | PassCmd::Insert { .. }
        | PassCmd::Generate { .. }
        | PassCmd::Show { .. }
        | PassCmd::Ls { .. }
        | PassCmd::Find { .. }
        | PassCmd::Rm { .. }
        | PassCmd::Cp { .. }
        | PassCmd::Mv { .. }
        | PassCmd::Git { .. }) => pass_entries(cmd)?,
        cmd @ (PassCmd::Seal { .. }
        | PassCmd::ImportKdbx { .. }
        | PassCmd::ExportKdbx { .. }
        | PassCmd::Backup { .. }) => pass_files(cmd).await?,
        cmd @ PassCmd::Attach { .. } => pass_attach(server, cmd).await?,
        cmd @ (PassCmd::Protect { .. }
        | PassCmd::Otp { .. }
        | PassCmd::Update { .. }
        | PassCmd::Rotate { .. }) => pass_mutate(cmd)?,
        cmd @ (PassCmd::History { .. }
        | PassCmd::Restore { .. }
        | PassCmd::Tomb { .. }
        | PassCmd::Open { .. }
        | PassCmd::Close { .. }) => pass_history(cmd)?,
    }
    Ok(())
}

fn pass_entries(cmd: super::PassCmd) -> anyhow::Result<()> {
    match cmd {
        PassCmd::Init {
            path,
            recipients,
            git,
            remote,
        } => store::cmd_init(path.as_deref(), &recipients, git, remote.as_deref())?,
        PassCmd::Insert {
            name,
            echo,
            path,
            tomb,
        } => store::cmd_insert(&name, echo, path.as_deref(), tomb.as_deref())?,
        PassCmd::Generate {
            name,
            length,
            no_symbols,
            path,
            tomb,
        } => store::cmd_generate(&name, length, no_symbols, path.as_deref(), tomb.as_deref())?,
        PassCmd::Show {
            name,
            reveal,
            path,
            tomb,
        } => store::cmd_show(&name, reveal, path.as_deref(), tomb.as_deref())?,
        PassCmd::Ls { prefix, path, tomb } => {
            store::cmd_ls(prefix.as_deref(), path.as_deref(), tomb.as_deref())?;
        }
        PassCmd::Find { query, path, tomb } => {
            store::cmd_find(&query, path.as_deref(), tomb.as_deref())?;
        }
        PassCmd::Rm { name, path, tomb } => {
            store::cmd_rm(&name, path.as_deref(), tomb.as_deref())?;
        }
        PassCmd::Cp {
            from,
            to,
            path,
            tomb,
        } => store::cmd_cp(&from, &to, path.as_deref(), tomb.as_deref())?,
        PassCmd::Mv {
            from,
            to,
            path,
            tomb,
        } => store::cmd_mv(&from, &to, path.as_deref(), tomb.as_deref())?,
        PassCmd::Git { args, path, tomb } => {
            let code = store::cmd_git(&args, path.as_deref(), tomb.as_deref())?;
            if code != 0 {
                std::process::exit(code);
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

async fn pass_files(cmd: super::PassCmd) -> anyhow::Result<()> {
    match cmd {
        PassCmd::Seal {
            manifest,
            replace,
            shred,
            path,
            tomb,
        } => store::cmd_seal(&manifest, replace, shred, path.as_deref(), tomb.as_deref())?,
        PassCmd::ImportKdbx {
            file,
            keyfile,
            prefix,
            replace,
            path,
            tomb,
        } => store::cmd_import_kdbx(
            &file,
            keyfile,
            prefix,
            replace,
            path.as_deref(),
            tomb.as_deref(),
        )?,
        PassCmd::ExportKdbx {
            dest,
            prefix,
            reveal,
            path,
            tomb,
        } => store::cmd_export_kdbx(
            &dest,
            prefix.as_deref(),
            reveal,
            path.as_deref(),
            tomb.as_deref(),
        )?,
        PassCmd::Backup {
            remote,
            auto_push,
            path,
            tomb,
        } => {
            store::cmd_backup(remote, auto_push, path.as_deref(), tomb.as_deref()).await?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

async fn pass_attach(server: &str, cmd: super::PassCmd) -> anyhow::Result<()> {
    match cmd {
        PassCmd::Attach { cmd } => match cmd {
            PassAttachCmd::Add {
                name,
                file,
                mime,
                force,
                shred,
                path,
                tomb,
            } => attach::cmd_attach_add(
                &name,
                &file,
                mime,
                force,
                shred,
                path.as_deref(),
                tomb.as_deref(),
            )?,
            PassAttachCmd::Get {
                name,
                out,
                reveal,
                path,
                tomb,
            } => attach::cmd_attach_get(
                &name,
                out.as_deref(),
                reveal,
                path.as_deref(),
                tomb.as_deref(),
            )?,
            PassAttachCmd::Ls { prefix, path, tomb } => {
                attach::cmd_attach_ls(prefix.as_deref(), path.as_deref(), tomb.as_deref())?;
            }
            PassAttachCmd::Rm { name, path, tomb } => {
                attach::cmd_attach_rm(&name, path.as_deref(), tomb.as_deref())?;
            }
            PassAttachCmd::Gc { path, tomb } => {
                attach::cmd_attach_gc(path.as_deref(), tomb.as_deref())?;
            }
            PassAttachCmd::Sync { to_dir, path, tomb } => {
                attach::cmd_attach_sync(
                    to_dir.as_deref(),
                    server,
                    path.as_deref(),
                    tomb.as_deref(),
                )
                .await?;
            }
        },
        _ => unreachable!(),
    }
    Ok(())
}

fn pass_mutate(cmd: super::PassCmd) -> anyhow::Result<()> {
    match cmd {
        PassCmd::Protect { cmd } => pass_protect::run(cmd)?,
        PassCmd::Otp { cmd } => pass_otp::run(cmd)?,
        PassCmd::Update {
            names,
            length,
            auto_length,
            no_symbols,
            provide,
            multiline,
            include,
            exclude,
            force,
            path,
            tomb,
        } => store::cmd_update(
            &names,
            &store::UpdateCliOpts {
                length,
                auto_length,
                no_symbols,
                provide,
                multiline,
                include,
                exclude,
                force,
            },
            path.as_deref(),
            tomb.as_deref(),
        )?,
        PassCmd::Rotate {
            names,
            length,
            auto_length,
            no_symbols,
            provide,
            multiline,
            include,
            exclude,
            force,
            reveal,
            path,
            tomb,
        } => store::cmd_rotate(
            &names,
            &store::UpdateCliOpts {
                length,
                auto_length,
                no_symbols,
                provide,
                multiline,
                include,
                exclude,
                force,
            },
            reveal,
            path.as_deref(),
            tomb.as_deref(),
        )?,
        _ => unreachable!(),
    }
    Ok(())
}

fn pass_history(cmd: super::PassCmd) -> anyhow::Result<()> {
    match cmd {
        PassCmd::History { name, path, tomb } => {
            store::cmd_history(&name, path.as_deref(), tomb.as_deref())?;
        }
        PassCmd::Restore {
            name,
            rev,
            path,
            tomb,
        } => store::cmd_restore(&name, &rev, path.as_deref(), tomb.as_deref())?,
        PassCmd::Tomb { cmd } => match cmd {
            PassTombCmd::List => store::cmd_tomb_list()?,
            PassTombCmd::Add {
                name,
                store: store_path,
                key,
                volume,
                linux,
            } => store::cmd_tomb_add(&name, store_path, key, volume, linux)?,
            PassTombCmd::Rm { name } => store::cmd_tomb_rm(&name)?,
            PassTombCmd::Use { name } => store::cmd_tomb_use(&name)?,
        },
        PassCmd::Open { name } => store::cmd_open(name.as_deref())?,
        PassCmd::Close { name } => store::cmd_close(name.as_deref())?,
        _ => unreachable!(),
    }
    Ok(())
}
