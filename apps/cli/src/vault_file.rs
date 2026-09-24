//! `opensesame vault verify <file>` and `opensesame vault ls <file>`: open a
//! vault export or offline backup the Pages PWA wrote, with its master
//! password, through `opensesame_human_vault::pages_vault` — the Rust reader
//! checked against the same vectors as the TypeScript one (ADR 0139) — and
//! print what may be shown: the tomb, whether the body is bound to it, its
//! revision (and a rollback against the header's), and each item's name,
//! kind and path. No field value is ever printed. The password is read from
//! a terminal only: never an argument, a pipe or an environment variable.
//! Mirrors `opensesame-id vault verify|ls` (`packages/cli`).

use std::{
    io::IsTerminal,
    path::{Path, PathBuf},
};

use clap::Subcommand;
use opensesame_human_vault::pages_vault::{
    open_body, read_vault_file, summarize, unwrap_with_password, OpenedVaultFile, SealedVaultFile,
    VaultFileError,
};
use opensesame_vault_item_types::ItemTypeRegistry;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};

#[derive(Subcommand, Debug)]
pub enum VaultCmd {
    /// Open a Pages vault export or offline backup with its master password
    Verify { file: PathBuf },
    /// List its items: path and kind, never values
    Ls { file: PathBuf },
}

/// What the person sees when the file does not open; never a value.
fn refusal(error: VaultFileError) -> anyhow::Error {
    match error {
        VaultFileError::WrongPassword => anyhow::anyhow!("Wrong master password."),
        VaultFileError::Corrupt(reason) => anyhow::anyhow!("Not a readable vault file: {reason}"),
        VaultFileError::Rejected(reason) => anyhow::anyhow!("Refused: {reason}"),
    }
}

fn describe(opened: &OpenedVaultFile) -> String {
    let binding = if opened.bound {
        "bound to"
    } else {
        "legacy body, unbound from"
    };
    let rev = opened
        .rev
        .map_or_else(String::new, |rev| format!(", revision {rev}"));
    let count = opened.items.len();
    let plural = if count == 1 { "" } else { "s" };
    let rollback = match (opened.rolled_back, opened.header_rev) {
        (true, Some(recorded)) => format!(" — ROLLED BACK: the header records revision {recorded}"),
        _ => String::new(),
    };
    format!(
        "{}: {binding} {}{rev}, {count} item{plural}{rollback}",
        opened.format.as_str(),
        opened.tomb
    )
}

fn summary(opened: &OpenedVaultFile) -> Value {
    json!({
        "ok": true,
        "format": opened.format.as_str(),
        "tomb": opened.tomb,
        "bound": opened.bound,
        "rev": opened.rev,
        "header_rev": opened.header_rev,
        "rolled_back": opened.rolled_back,
    })
}

/// `vault verify`: the one-line verdict, or its JSON.
pub fn render_verify(opened: &OpenedVaultFile, output: &str) -> String {
    if output == "json" {
        let mut data = summary(opened);
        data["items"] = json!(opened.items.len());
        return serde_json::to_string_pretty(&data).unwrap_or_default();
    }
    format!("OK — {}", describe(opened))
}

/// `vault ls`: the verdict, then `path<TAB>kind` per item, or its JSON.
pub fn render_ls(opened: &OpenedVaultFile, output: &str) -> String {
    if output == "json" {
        let mut data = summary(opened);
        data["items"] = opened
            .items
            .iter()
            .map(|item| {
                json!({ "id": item.id, "name": item.name, "kind": item.kind, "path": item.path })
            })
            .collect();
        return serde_json::to_string_pretty(&data).unwrap_or_default();
    }
    std::iter::once(describe(opened))
        .chain(
            opened
                .items
                .iter()
                .map(|item| format!("{}\t{}", item.path, item.kind)),
        )
        .collect::<Vec<_>>()
        .join("\n")
}

/// Open a parsed vault file with `password`, listing extensions from the
/// built-in item types — the corpus both planes embed (ADR 0087).
pub fn open(
    file: &SealedVaultFile,
    password: &SecretString,
) -> Result<OpenedVaultFile, VaultFileError> {
    let key = unwrap_with_password(&file.header, password.expose_secret())?;
    let body = open_body(file, &key)?;
    let registry = ItemTypeRegistry::with_builtins();
    let extension_of = |id: &str| {
        registry
            .get(id)
            .map(|definition| definition.spec.extension.clone())
    };
    Ok(summarize(file, &body, &extension_of))
}

fn read_master_password() -> anyhow::Result<SecretString> {
    anyhow::ensure!(
        std::io::stdin().is_terminal(),
        "vault reads the master password from a terminal only"
    );
    Ok(SecretString::from(crate::store::prompt_secret_hidden(
        "Master password",
    )?))
}

fn read_file(path: &Path) -> anyhow::Result<String> {
    std::fs::read_to_string(path)
        .map_err(|error| anyhow::anyhow!("cannot read {}: {error}", path.display()))
}

pub fn run(output: &str, cmd: &VaultCmd) -> anyhow::Result<()> {
    let (path, render): (_, fn(&OpenedVaultFile, &str) -> String) = match cmd {
        VaultCmd::Verify { file } => (file, render_verify),
        VaultCmd::Ls { file } => (file, render_ls),
    };
    // The envelope is refused before a password is asked for.
    let file = read_vault_file(&read_file(path)?).map_err(refusal)?;
    let password = read_master_password()?;
    let opened = open(&file, &password).map_err(refusal)?;
    println!("{}", render(&opened, output));
    Ok(())
}

#[cfg(test)]
#[path = "vault_file_tests.rs"]
mod tests;
