//! `opensesame pass attach` — human CLI for sealed file attachments (ADR 0054).
//!
//! Attachments hold documents people care about losing and care about leaking:
//! tax paperwork, identity documents, scans. Two rules shape everything here.
//! Plaintext only ever leaves through [`crate::store::require_reveal`], so an
//! agent driving this binary cannot read a document out of the store. And
//! replication moves sealed bytes without opening them, so pushing a backup
//! never needs the passphrase.

use std::io::{self, Write};
use std::path::PathBuf;

use opensesame_sealed_store::{sanitize_filename, AttachMeta, StoreRoot};

use crate::store::{open_unlocked, require_reveal, resolve_root, shred_file};

/// Warn above this size that the free git-remote tier has a practical ceiling.
const LARGE_ATTACHMENT_WARN_BYTES: u64 = 50 * 1024 * 1024;

pub fn cmd_attach_add(
    name: String,
    file: PathBuf,
    mime: Option<String>,
    force: bool,
    shred: bool,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let meta = std::fs::metadata(&file)?;
    if !meta.is_file() {
        anyhow::bail!(
            "{} is not a regular file; an attachment needs a known length up front",
            file.display()
        );
    }
    let total_bytes = meta.len();
    if total_bytes >= LARGE_ATTACHMENT_WARN_BYTES {
        eprintln!(
            "note: {} MiB attachment — git remotes have a soft repository ceiling around 5 GB; \
             consider an external attachment target for files this size",
            total_bytes / (1024 * 1024)
        );
    }
    let filename = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();

    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let mut source = std::fs::File::open(&file)?;
    let summary = root
        .attach_add(
            &name,
            &mut source,
            total_bytes,
            AttachMeta { filename, mime },
            &key,
            force,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(source);

    if shred {
        shred_file(&file)?;
    }
    println!(
        "sealed {} ({} bytes, {} chunk(s)) at {}",
        summary.filename, summary.total_bytes, summary.chunk_count, summary.name
    );
    Ok(())
}

pub fn cmd_attach_get(
    name: String,
    out: Option<PathBuf>,
    reveal: bool,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    // Plaintext leaves the store on this path whether it lands on stdout or in
    // a file, so the reveal gate covers both.
    require_reveal(reveal)?;
    let (root, key) = open_unlocked(path, tomb.as_deref())?;

    match out {
        None => {
            let mut stdout = io::stdout();
            root.attach_get(&name, &mut stdout, &key)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            stdout.flush()?;
        }
        Some(dest) => {
            let dest = resolve_output_path(&root, &name, &key, dest)?;
            // Reassemble into a sibling temp file and rename, so a failure part
            // way through never leaves a truncated file that looks like the
            // real document.
            let tmp = dest.with_extension("partial");
            {
                let mut file = std::fs::File::create(&tmp)?;
                if let Err(e) = root.attach_get(&name, &mut file, &key) {
                    drop(file);
                    let _ = std::fs::remove_file(&tmp);
                    anyhow::bail!("{e}");
                }
                file.sync_all()?;
            }
            std::fs::rename(&tmp, &dest)?;
            println!("wrote {}", dest.display());
        }
    }
    Ok(())
}

/// Expand a directory destination using the stored filename, which is display
/// metadata from the manifest and so must be sanitized before it names a file.
fn resolve_output_path(
    root: &StoreRoot,
    name: &str,
    key: &opensesame_sealed_store::ItemDataKey,
    dest: PathBuf,
) -> anyhow::Result<PathBuf> {
    if !dest.is_dir() {
        return Ok(dest);
    }
    let summary = root
        .attach_ls(Some(name), key)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("attachment not found: {name}"))?;
    let safe = sanitize_filename(&summary.filename)
        .ok_or_else(|| anyhow::anyhow!("stored filename is unusable; pass an explicit --out"))?;
    Ok(dest.join(safe))
}

pub fn cmd_attach_ls(
    prefix: Option<String>,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let listed = root
        .attach_ls(prefix.as_deref(), &key)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if listed.is_empty() {
        println!("no attachments");
        return Ok(());
    }
    for summary in listed {
        println!(
            "{}\t{}\t{} bytes\t{} chunk(s)\t{}",
            summary.name,
            summary.filename,
            summary.total_bytes,
            summary.chunk_count,
            summary.mime
        );
    }
    Ok(())
}

pub fn cmd_attach_rm(
    name: String,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    root.attach_rm(&name, &key)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("removed {name}");
    eprintln!(
        "note: git history still holds the old ciphertext — removal is not erasure"
    );
    Ok(())
}

pub fn cmd_attach_gc(path: Option<PathBuf>, tomb: Option<String>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb.as_deref())?;
    let outcome = root.attach_gc(&key).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "removed {} orphan(s), kept {} referenced, skipped {} too recent to be sure",
        outcome.removed, outcome.kept, outcome.skipped_recent
    );
    Ok(())
}

pub fn cmd_attach_sync(
    to_dir: Option<PathBuf>,
    server: Option<String>,
    path: Option<PathBuf>,
    tomb: Option<String>,
) -> anyhow::Result<()> {
    // Replication moves sealed bytes only, so it never needs the passphrase.
    let root_path = resolve_root(path, tomb.as_deref())?;
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    let units = root
        .attach_replication_units()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if units.is_empty() {
        println!("no attachment ciphertext to replicate");
        return Ok(());
    }

    let Some(dir) = to_dir else {
        // The connector path needs a configured attachment target and an
        // authenticated Host session. Until that lands, say so plainly rather
        // than pretending to have replicated anything.
        let _ = server;
        anyhow::bail!(
            "connector replication is not wired up yet; use --to-dir <path> to copy ciphertext \
             to a mounted encrypted volume"
        );
    };

    let mut copied = 0usize;
    for (rel, source) in units {
        let dest = dir.join("attachments").join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&source, &dest)?;
        copied += 1;
    }
    println!("replicated {copied} ciphertext file(s) to {}", dir.display());
    Ok(())
}
