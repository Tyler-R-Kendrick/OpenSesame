//! Human sealed-store CLI under `opensesame pass` (`pass` CLI parity).

use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use opensesame_sealed_store::{
    apply_secret_update, default_tombs_config_path, ensure_git_repo, generate_password,
    git_passthrough, init_store, init_store_key, load_tomb_registry, parse_otpauth,
    resolve_store_dir, resolve_tomb_paths, save_tomb_registry, totp_code, unlock_store_key,
    validate_otpauth, Entry, TombBackend, TombEntry, UpdateMode, UpdateOptions, StoreRoot,
};
use regex::Regex;

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

fn prompt_secret_hidden(prompt: &str) -> anyhow::Result<String> {
    // Best-effort: still line-based (no rpassword dep); echo off is not guaranteed.
    prompt_line(prompt)
}

/// Resolve store root: explicit `--path` > `--tomb` / active registry > env defaults.
pub fn resolve_root(path: Option<PathBuf>, tomb: Option<&str>) -> anyhow::Result<PathBuf> {
    if let Some(p) = path {
        return Ok(p);
    }
    let cfg = default_tombs_config_path();
    let reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    if tomb.is_some() || reg.active.is_some() {
        if let Ok(resolved) = resolve_tomb_paths(&reg, tomb) {
            return Ok(resolved.store);
        }
        if tomb.is_some() {
            anyhow::bail!("tomb not found in {}", cfg.display());
        }
    }
    Ok(resolve_store_dir())
}

fn open_unlocked(
    path: Option<PathBuf>,
    tomb: Option<&str>,
) -> anyhow::Result<(StoreRoot, opensesame_sealed_store::ItemDataKey)> {
    let root_path = resolve_root(path, tomb)?;
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    let password = prompt_password("Store passphrase")?;
    let key =
        unlock_store_key(&root_path, password.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?;
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

pub fn cmd_insert(
    name: String,
    echo: bool,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let _ = echo;
    let secret = prompt_line(&format!("Enter password for {name}"))?;
    root.insert(
        &name,
        &Entry {
            secret,
            trailer: String::new(),
            otp: None,
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
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let secret = generate_password(length, !no_symbols);
    root.insert(
        &name,
        &Entry {
            secret: secret.clone(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("{secret}");
    Ok(())
}

pub fn cmd_show(
    name: String,
    reveal: bool,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    require_reveal(reveal)?;
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
    let entry = root
        .show_with_age_identity(&name, &key, age_id.as_deref())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    print!("{}", entry.render());
    Ok(())
}

pub fn cmd_ls(
    prefix: Option<String>,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let root_path = resolve_root(path, tomb.as_deref())?;
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    for name in root
        .ls(prefix.as_deref().unwrap_or(""))
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        println!("{name}");
    }
    Ok(())
}

pub fn cmd_find(query: String, path: Option<PathBuf>, tomb: Option<String>) -> anyhow::Result<()> {
    let root_path = resolve_root(path, tomb.as_deref())?;
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    for name in root.find(&query).map_err(|e| anyhow::anyhow!("{e}"))? {
        println!("{name}");
    }
    Ok(())
}

pub fn cmd_rm(name: String, path: Option<PathBuf>, tomb: Option<String>) -> anyhow::Result<()> {
    let root_path = resolve_root(path, tomb.as_deref())?;
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    root.rm(&name).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("removed {name}");
    Ok(())
}

pub fn cmd_cp(
    from: String,
    to: String,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    root.cp(&from, &to, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

pub fn cmd_mv(
    from: String,
    to: String,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    root.mv(&from, &to, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

pub fn cmd_git(args: Vec<String>, path: Option<PathBuf>, tomb: Option<String>) -> anyhow::Result<i32> {
    let root_path = resolve_root(path, tomb.as_deref())?;
    git_passthrough(&root_path, &args).map_err(|e| anyhow::anyhow!("{e}"))
}

// —— OTP ——————————————————————————————————————————————————

fn read_uri_input(echo: bool) -> anyhow::Result<String> {
    if !io::stdin().is_terminal() {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        return Ok(buf.trim().to_string());
    }
    if echo {
        prompt_line("Enter otpauth:// URI")
    } else {
        let a = prompt_secret_hidden("Enter otpauth:// URI")?;
        let b = prompt_secret_hidden("Retype otpauth:// URI")?;
        if a != b {
            anyhow::bail!("URI entries do not match");
        }
        Ok(a)
    }
}

pub fn cmd_otp_code(
    name: String,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let entry = root.show(&name, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    let otp = entry
        .otp
        .ok_or_else(|| anyhow::anyhow!("no otpauth:// URI in {name}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .as_secs();
    println!("{}", totp_code(&otp, now).map_err(|e| anyhow::anyhow!("{e}"))?);
    Ok(())
}

pub fn cmd_otp_insert(
    name: Option<String>,
    force: bool,
    echo: bool,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let uri = read_uri_input(echo)?;
    let otp = parse_otpauth(&uri).map_err(|e| anyhow::anyhow!("{e}"))?;
    let name = name.or(otp.label.clone()).unwrap_or_else(|| "otp".into());
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    if root.show(&name, &key).is_ok() && !force {
        anyhow::bail!("{name} already exists; pass --force to overwrite");
    }
    let entry = Entry {
        secret: String::new(),
        trailer: String::new(),
        otp: None,
    }
    .with_otp(Some(otp));
    root.insert_or_replace(&name, &entry, &key)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("otp stored at {name}");
    Ok(())
}

pub fn cmd_otp_append(
    name: String,
    force: bool,
    echo: bool,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let uri = read_uri_input(echo)?;
    let otp = parse_otpauth(&uri).map_err(|e| anyhow::anyhow!("{e}"))?;
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let mut entry = root.show(&name, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    if entry.otp.is_some() && !force {
        anyhow::bail!("{name} already has an otpauth URI; pass --force to replace");
    }
    entry = entry.with_otp(Some(otp));
    root.insert_or_replace(&name, &entry, &key)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("otp appended to {name}");
    Ok(())
}

pub fn cmd_otp_uri(
    name: String,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let entry = root.show(&name, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
    let otp = entry
        .otp
        .ok_or_else(|| anyhow::anyhow!("no otpauth:// URI in {name}"))?;
    println!("{}", otp.uri);
    Ok(())
}

pub fn cmd_otp_validate(uri: String) -> anyhow::Result<()> {
    if validate_otpauth(&uri) {
        println!("ok");
        Ok(())
    } else {
        anyhow::bail!("invalid otpauth URI");
    }
}

// —— update ———————————————————————————————————————————————

pub struct UpdateCliOpts {
    pub length: usize,
    pub auto_length: bool,
    pub no_symbols: bool,
    pub provide: bool,
    pub multiline: bool,
    pub include: Option<String>,
    pub exclude: Option<String>,
    pub force: bool,
}

pub fn cmd_update(
    names: Vec<String>,
    opts: UpdateCliOpts,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let mut update_opts = UpdateOptions {
        mode: if opts.multiline {
            UpdateMode::Multiline
        } else {
            UpdateMode::FirstLine
        },
        length: opts.length,
        auto_length: opts.auto_length,
        symbols: !opts.no_symbols,
        include: opts
            .include
            .as_deref()
            .map(Regex::new)
            .transpose()
            .map_err(|e| anyhow::anyhow!("include regex: {e}"))?,
        exclude: opts
            .exclude
            .as_deref()
            .map(Regex::new)
            .transpose()
            .map_err(|e| anyhow::anyhow!("exclude regex: {e}"))?,
    };

    let mut targets = Vec::new();
    for name in names {
        let listed = root.ls(&name).map_err(|e| anyhow::anyhow!("{e}"))?;
        if listed.is_empty() {
            // Exact entry?
            if root.show(&name, &key).is_ok() {
                targets.push(name);
            } else {
                anyhow::bail!("no entries under {name}");
            }
        } else {
            targets.extend(listed);
        }
    }
    targets.sort();
    targets.dedup();

    for name in targets {
        let entry = root.show(&name, &key).map_err(|e| anyhow::anyhow!("{e}"))?;
        eprintln!("Changing password for {name}");
        eprintln!("{}", entry.secret);
        if !entry.trailer.trim().is_empty() {
            eprint!("{}", entry.trailer);
        }
        if !opts.force {
            let ans = prompt_line(&format!(
                "Are you ready to {} a new password? [y/N]",
                if opts.provide { "provide" } else { "generate" }
            ))?;
            if !matches!(ans.to_ascii_lowercase().as_str(), "y" | "yes") {
                eprintln!("skipped {name}");
                continue;
            }
        }
        let provided = if opts.provide {
            let a = prompt_secret_hidden(&format!("Enter the new password for {name}"))?;
            let b = prompt_secret_hidden(&format!("Retype the new password for {name}"))?;
            if a != b {
                anyhow::bail!("passwords do not match");
            }
            Some(a)
        } else {
            None
        };
        let Some(next) = apply_secret_update(&entry, provided, &update_opts) else {
            eprintln!("skipped {name} (include/exclude)");
            continue;
        };
        root.insert_or_replace(&name, &next, &key)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        if !opts.provide {
            println!("The generated password for {name} is:\n{}", next.secret);
        } else {
            println!("updated {name}");
        }
        let _ = &mut update_opts;
    }
    Ok(())
}

// —— tombs ————————————————————————————————————————————————

pub fn cmd_tomb_list() -> anyhow::Result<()> {
    let cfg = default_tombs_config_path();
    let reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    if reg.tombs.is_empty() {
        println!("(no tombs registered; config {})", cfg.display());
        return Ok(());
    }
    for t in &reg.tombs {
        let mark = if reg.active.as_deref() == Some(t.name.as_str()) {
            "*"
        } else {
            " "
        };
        println!(
            "{mark} {}  store={}  key={}  {:?}",
            t.name, t.store, t.key, t.backend
        );
    }
    Ok(())
}

pub fn cmd_tomb_add(
    name: String,
    store: String,
    key: String,
    volume: Option<String>,
    linux: bool,
) -> anyhow::Result<()> {
    let cfg = default_tombs_config_path();
    let mut reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    reg.add(TombEntry {
        name: name.clone(),
        store,
        key,
        volume,
        backend: if linux {
            TombBackend::LinuxTomb
        } else {
            TombBackend::Portable
        },
    })
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    save_tomb_registry(&cfg, &reg).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("registered tomb {name} in {}", cfg.display());
    Ok(())
}

pub fn cmd_tomb_rm(name: String) -> anyhow::Result<()> {
    let cfg = default_tombs_config_path();
    let mut reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    reg.remove(&name).map_err(|e| anyhow::anyhow!("{e}"))?;
    save_tomb_registry(&cfg, &reg).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("unregistered {name}");
    Ok(())
}

pub fn cmd_tomb_use(name: String) -> anyhow::Result<()> {
    let cfg = default_tombs_config_path();
    let mut reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    reg.use_tomb(&name).map_err(|e| anyhow::anyhow!("{e}"))?;
    save_tomb_registry(&cfg, &reg).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("active tomb: {name}");
    Ok(())
}

fn which_tomb() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("tomb");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Build argv for `tomb open|close` (no sudo).
pub fn linux_tomb_args(
    open: bool,
    volume: &Path,
    key: &Path,
    mount: &Path,
) -> Vec<String> {
    if open {
        vec![
            "open".into(),
            volume.display().to_string(),
            "-k".into(),
            key.display().to_string(),
            mount.display().to_string(),
        ]
    } else {
        vec!["close".into(), mount.display().to_string()]
    }
}

pub fn cmd_open(name: Option<String>) -> anyhow::Result<()> {
    let cfg = default_tombs_config_path();
    let mut reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    let resolved = resolve_tomb_paths(&reg, name.as_deref()).map_err(|e| anyhow::anyhow!("{e}"))?;
    if let Some(n) = name {
        reg.use_tomb(&n).map_err(|e| anyhow::anyhow!("{e}"))?;
        save_tomb_registry(&cfg, &reg).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    if resolved.entry.backend == TombBackend::LinuxTomb {
        let tomb = which_tomb().ok_or_else(|| {
            anyhow::anyhow!("tomb binary not found on PATH; install Tomb or use a portable tomb")
        })?;
        let volume = resolved
            .volume
            .ok_or_else(|| anyhow::anyhow!("linux-tomb entry needs a volume path"))?;
        let args = linux_tomb_args(true, &volume, &resolved.key, &resolved.store);
        let status = Command::new(&tomb).args(&args).status()?;
        if !status.success() {
            anyhow::bail!("tomb open failed with {status}");
        }
    }
    println!("open: {}", resolved.entry.name);
    Ok(())
}

pub fn cmd_close(name: Option<String>) -> anyhow::Result<()> {
    let cfg = default_tombs_config_path();
    let reg = load_tomb_registry(&cfg).map_err(|e| anyhow::anyhow!("{e}"))?;
    let resolved = resolve_tomb_paths(&reg, name.as_deref()).map_err(|e| anyhow::anyhow!("{e}"))?;
    if resolved.entry.backend == TombBackend::LinuxTomb {
        let tomb = which_tomb().ok_or_else(|| {
            anyhow::anyhow!("tomb binary not found on PATH; install Tomb or use a portable tomb")
        })?;
        let args = linux_tomb_args(false, Path::new(""), Path::new(""), &resolved.store);
        let status = Command::new(&tomb).args(&args).status()?;
        if !status.success() {
            anyhow::bail!("tomb close failed with {status}");
        }
    }
    println!("closed: {}", resolved.entry.name);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_reveal_allows_flag() {
        assert!(require_reveal(true).is_ok());
    }

    #[test]
    fn linux_tomb_open_argv() {
        let args = linux_tomb_args(
            true,
            Path::new("/home/u/.password.tomb"),
            Path::new("/home/u/.password.key.tomb"),
            Path::new("/home/u/.password-store"),
        );
        assert_eq!(args[0], "open");
        assert!(args.contains(&"-k".into()));
    }
}
