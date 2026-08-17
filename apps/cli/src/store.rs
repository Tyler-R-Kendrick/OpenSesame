//! Human sealed-store CLI (`pass` parity, no `pass` subcommand).

use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};

use opensesame_sealed_store::{
    ensure_git_repo, generate_password, git_passthrough, init_store, init_store_key,
    parse_manifest, push_backup, remote_url, resolve_store_dir, seal_manifest, set_auto_push,
    set_remote, unlock_store_key, Entry, StoreRoot,
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
    prompt_hidden(prompt)
}

fn prompt_line(prompt: &str) -> anyhow::Result<String> {
    eprint!("{prompt}: ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Read a secret without echoing it — `pass` parity. Non-TTY stdin (pipes,
/// heredocs) falls back to a plain line read, since nothing echoes there.
fn prompt_hidden(prompt: &str) -> anyhow::Result<String> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
    if !io::stdin().is_terminal() {
        return prompt_line(prompt);
    }
    eprint!("{prompt}: ");
    let _ = io::stderr().flush();
    crossterm::terminal::enable_raw_mode()?;
    let mut buf = String::new();
    let outcome = loop {
        match crossterm::event::read() {
            Ok(Event::Key(key)) if key.kind != KeyEventKind::Release => match key.code {
                KeyCode::Enter => break Ok(buf.clone()),
                KeyCode::Backspace => {
                    buf.pop();
                }
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    break Err(anyhow::anyhow!("interrupted"));
                }
                KeyCode::Char(c) => buf.push(c),
                _ => {}
            },
            Ok(_) => {}
            Err(error) => break Err(error.into()),
        }
    };
    let _ = crossterm::terminal::disable_raw_mode();
    eprintln!();
    outcome
}

fn open_unlocked(path: Option<PathBuf>) -> anyhow::Result<(StoreRoot, opensesame_sealed_store::ItemDataKey)> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    let password = prompt_password("Store passphrase")?;
    let key = unlock_store_key(&root_path, password.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((root, key))
}

pub fn cmd_init(
    path: Option<PathBuf>,
    recipients: Vec<String>,
    git: bool,
    remote: Option<String>,
) -> anyhow::Result<()> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    init_store(&root_path, &recipients).map_err(|e| anyhow::anyhow!("{e}"))?;
    let password = prompt_password("New store passphrase")?;
    let confirm = if std::env::var("OPENSESAME_STORE_PASSWORD").is_ok() {
        password.clone()
    } else {
        prompt_hidden("Confirm passphrase")?
    };
    if password != confirm {
        anyhow::bail!("passphrases do not match");
    }
    init_store_key(&root_path, password.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?;
    if git || remote.is_some() {
        ensure_git_repo(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
        if let Some(url) = &remote {
            set_remote(&root_path, url).map_err(|e| anyhow::anyhow!("{e}"))?;
        }
        // The key and recipients files are part of the store's history from
        // commit one, so a clone restores an openable store.
        opensesame_sealed_store::auto_commit(&root_path, "Initialize sealed store")
            .map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    println!("initialized sealed store at {}", root_path.display());
    Ok(())
}

pub fn cmd_insert(name: String, echo: bool, path: Option<PathBuf>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    let prompt = format!("Enter password for {name}");
    let secret = if echo {
        prompt_line(&prompt)?
    } else {
        prompt_hidden(&prompt)?
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
    let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
    root.cp(&from, &to, &key, age_id.as_deref())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

pub fn cmd_mv(from: String, to: String, path: Option<PathBuf>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
    root.mv(&from, &to, &key, age_id.as_deref())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

pub fn cmd_git(args: Vec<String>, path: Option<PathBuf>) -> anyhow::Result<i32> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    git_passthrough(&root_path, &args).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Seal a Pages "store path manifest" (plaintext JSON export) into encrypted
/// entries, then optionally shred the manifest so plaintext never lingers.
pub fn cmd_seal(
    manifest: PathBuf,
    replace: bool,
    shred: bool,
    path: Option<PathBuf>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path)?;
    let json = std::fs::read_to_string(&manifest)?;
    let entries = parse_manifest(&json).map_err(|e| anyhow::anyhow!("{e}"))?;
    let outcome =
        seal_manifest(&root, &key, &entries, replace).map_err(|e| anyhow::anyhow!("{e}"))?;
    if shred {
        shred_file(&manifest)?;
    }
    println!(
        "{}",
        serde_json::json!({
            "sealed": outcome.sealed,
            "skipped": outcome.skipped,
            "rejected": outcome
                .rejected
                .iter()
                .map(|(name, reason)| serde_json::json!({"path": name, "reason": reason}))
                .collect::<Vec<_>>(),
            "manifest_shredded": shred,
            "store": root.path,
        })
    );
    if !shred {
        eprintln!(
            "reminder: {} is plaintext — delete it (or re-run with --shred); never commit it",
            manifest.display()
        );
    }
    Ok(())
}

/// Best-effort overwrite-then-remove for a plaintext manifest. Not proof
/// against journaling filesystems, but better than leaving the bytes named.
fn shred_file(path: &Path) -> anyhow::Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        let zeros = vec![0u8; meta.len() as usize];
        let _ = std::fs::write(path, &zeros);
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Commit outstanding changes and push the store to its backup remote.
/// GitHub HTTPS remotes authenticate via `GITHUB_TOKEN`/`GH_TOKEN`, a
/// configured GitHub App (installation token minted on the fly), or an
/// ambient `gh` login — in that order; other remotes use git's own helpers.
pub async fn cmd_backup(
    remote: Option<String>,
    auto_push: Option<bool>,
    path: Option<PathBuf>,
) -> anyhow::Result<()> {
    let root_path = path.unwrap_or_else(resolve_store_dir);
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    ensure_git_repo(&root.path).map_err(|e| anyhow::anyhow!("{e}"))?;
    opensesame_sealed_store::auto_commit(&root.path, "Backup sealed store")
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if let Some(url) = &remote {
        set_remote(&root.path, url).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    if let Some(enabled) = auto_push {
        set_auto_push(&root.path, enabled).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    let Some(url) = remote_url(&root.path) else {
        anyhow::bail!(
            "no backup remote configured — run `opensesame backup --remote <url>` once"
        );
    };
    let token = if is_github_https(&url) {
        crate::github::resolve_push_token().await
    } else {
        None
    };
    push_backup(&root.path, token.as_deref()).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "{}",
        serde_json::json!({
            "status": "pushed",
            "remote": url,
            "auth": if token.is_some() { "github-token" } else { "ambient-git" },
            "auto_push": opensesame_sealed_store::auto_push_enabled(&root.path),
        })
    );
    Ok(())
}

fn is_github_https(url: &str) -> bool {
    url.starts_with("https://github.com/") || url.starts_with("https://www.github.com/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_reveal_allows_flag() {
        assert!(require_reveal(true).is_ok());
    }

    #[test]
    fn github_token_injection_is_https_github_only() {
        assert!(is_github_https("https://github.com/me/store.git"));
        assert!(!is_github_https("https://gitlab.com/me/store.git"));
        assert!(!is_github_https("git@github.com:me/store.git"));
        assert!(!is_github_https("https://github.com.evil.example/x.git"));
    }
}
