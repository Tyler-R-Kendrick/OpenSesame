//! Secret mutations with explicit human reveal controls.

use super::{open_unlocked, prompt_line, prompt_secret_hidden, require_reveal};
use opensesame_sealed_store::{
    apply_secret_update, generate_password, rotate_secret_entry, Entry, UpdateMode, UpdateOptions,
};
use regex::Regex;
use std::path::Path;

pub fn cmd_generate(
    name: &str,
    length: usize,
    no_symbols: bool,
    reveal: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    if reveal {
        require_reveal(true)?;
    }
    let (root, key) = open_unlocked(path, tomb)?;
    let secret = generate_password(length, !no_symbols);
    root.insert(
        name,
        &Entry {
            secret: secret.clone(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    if reveal {
        println!("{secret}");
    } else {
        println!("generated {name}");
    }
    Ok(())
}

// —— update ———————————————————————————————————————————————

#[expect(
    clippy::struct_excessive_bools,
    reason = "these independent booleans directly represent stable pass update CLI flags"
)]
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
    names: &[String],
    opts: &UpdateCliOpts,
    reveal: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    if reveal {
        require_reveal(true)?;
    }
    let (root, key) = open_unlocked(path, tomb)?;
    let update_opts = UpdateOptions {
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
        let listed = root.ls(name).map_err(|e| anyhow::anyhow!("{e}"))?;
        if listed.is_empty() {
            // Exact entry?
            if root.show(name, &key).is_ok() {
                targets.push(name.clone());
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
        if reveal {
            println!("{}", next.secret);
        } else {
            println!("updated {name}");
        }
    }
    Ok(())
}

/// Rotate first-line secrets without printing plaintext unless `--reveal`.
/// Agents must not call this path for secret disclosure (ADR 0005).
pub fn cmd_rotate(
    names: &[String],
    opts: &UpdateCliOpts,
    reveal: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb)?;
    let update_opts = UpdateOptions {
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
        let listed = root.ls(name).map_err(|e| anyhow::anyhow!("{e}"))?;
        if listed.is_empty() {
            if root.show(name, &key).is_ok() {
                targets.push(name.clone());
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
        if !opts.force {
            let ans = prompt_line(&format!("Rotate password for {name}? [y/N]"))?;
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
        let Some(rotated) = rotate_secret_entry(&name, &entry, provided, &update_opts, None) else {
            eprintln!("skipped {name} (include/exclude)");
            continue;
        };
        root.insert_or_replace(&name, &rotated.entry, &key)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        // Changelog metadata only — never agent-facing secret dump.
        eprintln!(
            "rotated {name} (changelog {} version {})",
            rotated.changelog.event_type, rotated.changelog.version_id
        );
        if reveal {
            require_reveal(true)?;
            println!("{}", rotated.entry.secret);
        } else {
            println!("rotated {name}");
        }
    }
    Ok(())
}
