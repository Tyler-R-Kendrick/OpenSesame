//! `opensesame pass protect` — human root-protection commands (noninteractive deliberate).

use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use clap::Subcommand;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use opensesame_sealed_store::{
    discover_piv_age, protect_add_store_age_recipient, protect_add_store_recovery,
    protect_list_store, protect_remove_store, protect_rewrap_store_password,
    protect_root_rotate_store, protect_test_store_password, protect_test_store_recovery,
    refuse_destructive_ykman, resolve_sops_bin, sops_decrypt, sops_encrypt, SopsFormat,
};

use crate::store::{prompt_password, require_reveal, resolve_root};

#[derive(Subcommand, Debug)]
pub enum PassProtectCmd {
    /// List enrolled protectors (ids and kinds only).
    List {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Add a protector (age-recipient today; recovery via `recovery`).
    Add {
        #[command(subcommand)]
        cmd: PassProtectAddCmd,
    },
    /// Test that a password opens the store (no secrets printed).
    Test {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Remove a protector by id.
    Remove {
        protector_id: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Rewrap the password protector under a new passphrase.
    Rewrap {
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Recovery-key protector helpers.
    Recovery {
        #[command(subcommand)]
        cmd: PassProtectRecoveryCmd,
    },
    /// Rotate the store root key (requires deliberate content-key consent).
    RootRotate {
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        allow_content_key_change: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Non-destructive PIV / age-plugin-yubikey discovery (KP-29).
    PivDiscover {},
    /// Optional SOPS encrypt/decrypt (OPENSESAME_SOPS_BIN absolute path).
    Sops {
        #[command(subcommand)]
        cmd: PassProtectSopsCmd,
    },
}

#[derive(Subcommand, Debug)]
pub enum PassProtectAddCmd {
    /// Enroll an age-recipient protector.
    Age {
        #[arg(long = "recipient", value_name = "RECIPIENT")]
        recipients: Vec<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum PassProtectRecoveryCmd {
    /// Add a recovery-key protector.
    Add {
        #[arg(long)]
        yes: bool,
        /// Print the recovery secret once (default: fingerprint only).
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Test a recovery key (base64url) without printing secrets.
    Test {
        recovery: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum PassProtectSopsCmd {
    Encrypt {
        #[arg(long, default_value = "yaml")]
        format: String,
        #[arg(long = "recipient", value_name = "RECIPIENT")]
        recipients: Vec<String>,
        #[arg(long)]
        reveal: bool,
    },
    Decrypt {
        #[arg(long, default_value = "yaml")]
        format: String,
        #[arg(long)]
        reveal: bool,
    },
}

pub fn run(cmd: PassProtectCmd) -> anyhow::Result<()> {
    match cmd {
        PassProtectCmd::List { path, tomb } => cmd_protect_list(path.as_deref(), tomb.as_deref()),
        PassProtectCmd::Add { cmd } => match cmd {
            PassProtectAddCmd::Age { recipients, yes, path, tomb } => {
                cmd_protect_add_age(&recipients, path.as_deref(), tomb.as_deref(), yes)
            }
        },
        PassProtectCmd::Test { path, tomb } => cmd_protect_test(path.as_deref(), tomb.as_deref()),
        PassProtectCmd::Remove { protector_id, yes, path, tomb } => {
            cmd_protect_remove(&protector_id, path.as_deref(), tomb.as_deref(), yes)
        }
        PassProtectCmd::Rewrap { yes, path, tomb } => {
            cmd_protect_rewrap(path.as_deref(), tomb.as_deref(), yes)
        }
        PassProtectCmd::Recovery { cmd } => match cmd {
            PassProtectRecoveryCmd::Add { yes, reveal, path, tomb } => {
                cmd_protect_add_recovery(path.as_deref(), tomb.as_deref(), yes, reveal)
            }
            PassProtectRecoveryCmd::Test { recovery, path, tomb } => {
                cmd_protect_recovery_test(&recovery, path.as_deref(), tomb.as_deref())
            }
        },
        PassProtectCmd::RootRotate { yes, allow_content_key_change, path, tomb } => {
            cmd_protect_root_rotate(path.as_deref(), tomb.as_deref(), yes, allow_content_key_change)
        }
        PassProtectCmd::PivDiscover {} => cmd_protect_piv_discover(),
        PassProtectCmd::Sops { cmd } => match cmd {
            PassProtectSopsCmd::Encrypt { format, recipients, reveal } => {
                cmd_sops_encrypt(&format, &recipients, reveal)
            }
            PassProtectSopsCmd::Decrypt { format, reveal } => cmd_sops_decrypt(&format, reveal),
        },
    }
}

fn require_yes(yes: bool, action: &str) -> anyhow::Result<()> {
    if yes {
        return Ok(());
    }
    anyhow::bail!("{action} requires --yes (deliberate noninteractive consent)");
}

pub fn cmd_protect_list(path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    let root = resolve_root(path, tomb)?;
    let rows = protect_list_store(&root)?;
    for row in rows {
        println!(
            "{}\t{}\t{:?}",
            row.protector_id, row.kind, row.proof_status
        );
    }
    Ok(())
}

pub fn cmd_protect_test(path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    protect_test_store_password(&root, password.as_bytes())?;
    eprintln!("ok");
    Ok(())
}

pub fn cmd_protect_rewrap(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
) -> anyhow::Result<()> {
    require_yes(yes, "rewrap")?;
    let root = resolve_root(path, tomb)?;
    let old = prompt_password("Current store passphrase")?;
    let new = prompt_password("New store passphrase")?;
    let confirm = prompt_password("Confirm new store passphrase")?;
    if new != confirm {
        anyhow::bail!("passphrases do not match");
    }
    protect_rewrap_store_password(&root, old.as_bytes(), new.as_bytes())?;
    eprintln!("rewrap ok");
    Ok(())
}

pub fn cmd_protect_add_recovery(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    reveal: bool,
) -> anyhow::Result<()> {
    require_yes(yes, "add recovery")?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    let (secret, fingerprint) = protect_add_store_recovery(&root, password.as_bytes())?;
    println!("protector=recovery-key fingerprint={fingerprint}");
    if reveal {
        require_reveal(true)?;
        println!("recovery={}", URL_SAFE_NO_PAD.encode(secret));
    } else {
        eprintln!("recovery secret withheld (pass --reveal once to print)");
    }
    Ok(())
}

pub fn cmd_protect_add_age(
    recipients: &[String],
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
) -> anyhow::Result<()> {
    require_yes(yes, "add age-recipient")?;
    if recipients.is_empty() {
        anyhow::bail!("provide at least one --recipient");
    }
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    let id = protect_add_store_age_recipient(&root, password.as_bytes(), recipients)?;
    println!("protector={id} kind=age-recipient");
    Ok(())
}

pub fn cmd_protect_remove(
    protector_id: &str,
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
) -> anyhow::Result<()> {
    require_yes(yes, "remove protector")?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    protect_remove_store(&root, password.as_bytes(), protector_id)?;
    eprintln!("removed {protector_id}");
    Ok(())
}

pub fn cmd_protect_recovery_test(
    recovery_b64: &str,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    let root = resolve_root(path, tomb)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(recovery_b64.trim())
        .map_err(|e| anyhow::anyhow!("recovery key decode: {e}"))?;
    if bytes.len() != 32 {
        anyhow::bail!("recovery key must be 32 bytes");
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    protect_test_store_recovery(&root, &key)?;
    eprintln!("ok");
    Ok(())
}

pub fn cmd_protect_root_rotate(
    path: Option<&Path>,
    tomb: Option<&str>,
    yes: bool,
    allow_content_key_change: bool,
) -> anyhow::Result<()> {
    require_yes(yes, "root-rotate")?;
    let root = resolve_root(path, tomb)?;
    let password = prompt_password("Store passphrase")?;
    let _vrk = protect_root_rotate_store(&root, password.as_bytes(), allow_content_key_change)?;
    eprintln!("root-rotate ok (entries may need lifecycle rebind)");
    Ok(())
}

pub fn cmd_protect_piv_discover() -> anyhow::Result<()> {
    let d = discover_piv_age();
    println!(
        "runtime={:?} requires_hardware={} plugin={}",
        d.runtime,
        d.requires_hardware,
        d.plugin_path.as_deref().unwrap_or("-")
    );
    for note in d.notes {
        eprintln!("note: {note}");
    }
    // Touch the refuse path so operators see KP-29 policy in --help journeys.
    let _ = refuse_destructive_ykman(&["piv", "keys", "generate"]);
    Ok(())
}

pub fn cmd_sops_encrypt(
    format: &str,
    recipients: &[String],
    reveal: bool,
) -> anyhow::Result<()> {
    let _ = resolve_sops_bin()?;
    let fmt = parse_format(format)?;
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    let out = sops_encrypt(&input, fmt, recipients)?;
    if reveal || io::stdin().is_terminal() {
        // ciphertext to stdout is fine; plaintext never echoed back.
        io::stdout().write_all(&out)?;
    } else {
        io::stdout().write_all(&out)?;
    }
    Ok(())
}

pub fn cmd_sops_decrypt(format: &str, reveal: bool) -> anyhow::Result<()> {
    require_reveal(reveal)?;
    let _ = resolve_sops_bin()?;
    let fmt = parse_format(format)?;
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    let out = sops_decrypt(&input, fmt)?;
    io::stdout().write_all(&out)?;
    Ok(())
}

fn parse_format(format: &str) -> anyhow::Result<SopsFormat> {
    match format {
        "yaml" | "yml" => Ok(SopsFormat::Yaml),
        "json" => Ok(SopsFormat::Json),
        other => anyhow::bail!("unsupported sops format: {other}"),
    }
}

