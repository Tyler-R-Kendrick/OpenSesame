//! Human sealed-store CLI (`pass` parity, no `pass` subcommand).

use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

use opensesame_sealed_store::{
    ensure_git_repo, generate_password, git_passthrough, init_store, init_store_key, resolve_store_dir,
    unlock_store_key, Entry, StoreRoot,
};

pub fn require_reveal(reveal: bool) -> anyhow::Result<()> {
    if reveal || io::stdin().is_terminal() {
        return Ok(());
    }
    anyhow::bail!(
        "plaintext output requires a TTY or --reveal; agents must use ConnectionRef invoke"
    );
}

fn prompt_password(prompt: &str) -> anyhow::Result<String> {
    if let Ok(p) = std::env::var("OPENSESAME_STORE_PASSWORD") {
        if !p.is_empty() {
            return Ok(p);
        }
    }
    prompt_line(prompt)
}

fn prompt_line(prompt: &str) -> anyhow::Result<String> {
    eprint!("{prompt}: ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

fn open_unlocked(path: Option<PathBuf>) -> anyhow::Result<(StoreRoot, opensesame_sealed_store::ItemDataKey)> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    let password = prompt_password("Store passphrase")?;
    let key = unlock_store_key(&root_path, password.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((root, key))
}

pub fn cmd_init(path: Option<PathBuf>, recipients: Vec<String>, git: bool) -> anyhow::Result<()> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    init_store(&root_path, &recipients).map_err(|e| anyhow::anyhow!("{e}"))?;
    let password = prompt_password("New store passphrase")?;
    let confirm = if std::env::var("OPENSESAME_STORE_PASSWORD").is_ok() {
        password.clone()
    } else {
        prompt_line("Confirm passphrase")?
    };
    if password != confirm {
        anyhow::bail!("passphrases do not match");
    }
    init_store_key(&root_path, password.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?;
    if git {
        ensure_git_repo(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    println!("initialized sealed store at {}", root_path.display());
    Ok(())
}

pub fn cmd_insert(name: String, echo: bool, path: Option<PathBuf>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    let secret = if echo {
        prompt_line(&format!("Enter password for {name}"))?
    } else {
        prompt_line(&format!("Enter password for {name}"))?
    };
    root.insert(
        &name,
        &Entry {
            secret,
            trailer: String::new(),
        },
        &key,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("added {name}");
    Ok(())
}

pub fn cmd_generate(
    name: String,
    length: usize,
    no_symbols: bool,
    path: Option<PathBuf>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    let secret = generate_password(length, !no_symbols);
    root.insert(
        &name,
        &Entry {
            secret: secret.clone(),
            trailer: String::new(),
        },
        &key,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("{secret}");
    Ok(())
}

pub fn cmd_show(name: String, reveal: bool, path: Option<PathBuf>) -> anyhow::Result<()> {
    require_reveal(reveal)?;
    let (root, key) = open_unlocked(path)?;
    let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
    let entry = root
        .show_with_age_identity(&name, &key, age_id.as_deref())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    print!("{}", entry.render());
    Ok(())
}

pub fn cmd_ls(prefix: Option<String>, path: Option<PathBuf>) -> anyhow::Result<()> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    for name in root.ls(prefix.as_deref().unwrap_or("")).map_err(|e| anyhow::anyhow!("{e}"))? {
        println!("{name}");
    }
    Ok(())
}

pub fn cmd_find(query: String, path: Option<PathBuf>) -> anyhow::Result<()> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    for name in root.find(&query).map_err(|e| anyhow::anyhow!("{e}"))? {
        println!("{name}");
    }
    Ok(())
}

pub fn cmd_rm(name: String, path: Option<PathBuf>) -> anyhow::Result<()> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    root.rm(&name).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("removed {name}");
    Ok(())
}

pub fn cmd_cp(from: String, to: String, path: Option<PathBuf>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    root.cp(&from, &to, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

pub fn cmd_mv(from: String, to: String, path: Option<PathBuf>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    root.mv(&from, &to, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

pub fn cmd_git(args: Vec<String>, path: Option<PathBuf>) -> anyhow::Result<i32> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    git_passthrough(&root_path, &args).map_err(|e| anyhow::anyhow!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_reveal_allows_flag() {
        assert!(require_reveal(true).is_ok());
    }
}
