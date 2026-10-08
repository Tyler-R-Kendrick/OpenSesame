//! Project-config secrets on the local sealed store (no Host secret API).

use std::path::{Path, PathBuf};

use clap::Subcommand;
use opensesame_sealed_store::list_names;
use serde_json::json;

use crate::store;

fn config_root(slug: &str) -> anyhow::Result<PathBuf> {
    use opensesame_sealed_store::init_store;
    let base = directories::ProjectDirs::from("com", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("could not resolve config directory"))?
        .config_dir()
        .join("project-config")
        .join(slug);
    std::fs::create_dir_all(&base)?;
    if !base.join(".opensesame-key").exists() {
        init_store(&base, &[])?;
        let password = store::prompt_password("New store passphrase")?;
        opensesame_sealed_store::init_store_key(&base, password.as_bytes())
            .map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    Ok(base)
}

#[derive(Subcommand, Debug)]
pub enum ConfigCmd {
    /// List local project-config slugs.
    Ls,
    /// List key names in one config (never values).
    Keys {
        #[arg(long)]
        config: String,
    },
    /// Set one secret (stdin or hidden prompt).
    Set {
        key: String,
        #[arg(long)]
        config: String,
    },
    /// Remove one key.
    Unset {
        key: String,
        #[arg(long)]
        config: String,
    },
    /// Import KEY=VALUE lines from a dotenv file.
    Import {
        file: PathBuf,
        #[arg(long)]
        config: String,
    },
}

pub fn run(output: &str, cmd: ConfigCmd) -> anyhow::Result<()> {
    match cmd {
        ConfigCmd::Ls => cmd_ls(output)?,
        ConfigCmd::Keys { config } => cmd_keys(output, &config)?,
        ConfigCmd::Set { key, config } => cmd_set(&config, &key)?,
        ConfigCmd::Unset { key, config } => cmd_unset(&config, &key)?,
        ConfigCmd::Import { file, config } => cmd_import(&config, &file)?,
    }
    Ok(())
}

fn configs_parent() -> anyhow::Result<PathBuf> {
    let base = directories::ProjectDirs::from("com", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("could not resolve config directory"))?
        .config_dir()
        .join("project-config");
    std::fs::create_dir_all(&base)?;
    Ok(base)
}

fn entry_name(config: &str, key: &str) -> String {
    format!("config/{config}/{key}")
}

fn cmd_ls(output: &str) -> anyhow::Result<()> {
    let parent = configs_parent()?;
    let mut slugs = Vec::new();
    if parent.is_dir() {
        for entry in std::fs::read_dir(&parent)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    slugs.push(name.to_owned());
                }
            }
        }
    }
    slugs.sort();
    let value = json!({ "configs": slugs, "home": parent.display().to_string() });
    crate::print_output(output, &value)
}

fn cmd_keys(output: &str, config: &str) -> anyhow::Result<()> {
    let root = config_root(config)?;
    let prefix = format!("config/{config}/");
    let names = list_names(&root, &prefix)?;
    let keys: Vec<&str> = names
        .iter()
        .map(|name| name.strip_prefix(&prefix).unwrap_or(name.as_str()))
        .collect();
    crate::print_output(
        output,
        &json!({ "config": config, "keys": keys, "store": root.display().to_string() }),
    )
}

fn cmd_set(config: &str, key: &str) -> anyhow::Result<()> {
    let root = config_root(config)?;
    let secret = store::prompt_secret_hidden("Value")?;
    if secret.is_empty() {
        anyhow::bail!("no value provided");
    }
    insert_value(&root, config, key, &secret)?;
    Ok(())
}

fn cmd_unset(config: &str, key: &str) -> anyhow::Result<()> {
    let root = config_root(config)?;
    store::cmd_rm(&entry_name(config, key), Some(root.as_path()), None)?;
    Ok(())
}

fn cmd_import(config: &str, file: &Path) -> anyhow::Result<()> {
    let root = config_root(config)?;
    let text = std::fs::read_to_string(file)?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        insert_value(&root, config, key, value.trim())?;
    }
    Ok(())
}

fn insert_value(root: &Path, config: &str, key: &str, value: &str) -> anyhow::Result<()> {
    use opensesame_sealed_store::Entry;
    let (opened, store_key) = store::open_unlocked(Some(root), None)?;
    opened.insert(
        &entry_name(config, key),
        &Entry {
            secret: value.into(),
            trailer: String::new(),
            otp: None,
        },
        &store_key,
    )?;
    Ok(())
}
