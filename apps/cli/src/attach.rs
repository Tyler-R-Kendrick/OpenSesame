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

/// Local record of what has already been replicated, so a re-run does not
/// re-upload every chunk. Keyed by remote path; always safe to delete.
const SYNC_CACHE_FILE: &str = ".opensesame-attachment-sync.json";

fn load_sync_cache(root: &std::path::Path) -> std::collections::BTreeSet<String> {
    std::fs::read(root.join(SYNC_CACHE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_sync_cache(root: &std::path::Path, cache: &std::collections::BTreeSet<String>) {
    // Best-effort: a lost cache costs re-uploads, never correctness.
    if let Ok(bytes) = serde_json::to_vec(cache) {
        let _ = std::fs::write(root.join(SYNC_CACHE_FILE), bytes);
    }
}

/// Split a replication-unit path into what the gateway needs to file it.
///
/// Manifests are addressed by their logical store path, chunks by digest, so
/// the two take different endpoints. Anything else in the store is not ours to
/// replicate.
enum Unit {
    Manifest { logical: String },
    Chunk { digest: String },
}

fn classify(relative: &str) -> Option<Unit> {
    if let Some(stem) = relative.strip_suffix(".osattach") {
        let logical = stem.replace('\\', "/");
        return (!logical.is_empty()).then_some(Unit::Manifest { logical });
    }
    if relative.ends_with(".oschunk") {
        let digest = std::path::Path::new(relative)
            .file_stem()
            .and_then(|s| s.to_str())?
            .to_string();
        let looks_like_a_digest =
            digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit());
        return looks_like_a_digest.then_some(Unit::Chunk { digest });
    }
    None
}

pub async fn cmd_attach_sync(
    to_dir: Option<PathBuf>,
    server: &str,
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

    match to_dir {
        Some(dir) => sync_to_dir(&units, &dir),
        None => sync_to_target(&units, &root_path, server).await,
    }
}

/// Copy ciphertext to a mounted encrypted volume. No gateway, no ceremony.
fn sync_to_dir(units: &[(String, PathBuf)], dir: &std::path::Path) -> anyhow::Result<()> {
    let mut copied = 0usize;
    for (rel, source) in units {
        let dest = dir.join("attachments").join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source, &dest)?;
        copied += 1;
    }
    println!("replicated {copied} ciphertext file(s) to {}", dir.display());
    Ok(())
}

/// Push ciphertext through the gateway to the configured provider target.
///
/// The gateway injects the provider credential; this side never sees it, and
/// the gateway never sees a store key. Uploads are idempotent by construction
/// (digest-addressed, overwrite mode), so a re-run after a partial failure is
/// safe.
async fn sync_to_target(
    units: &[(String, PathBuf)],
    root_path: &std::path::Path,
    server: &str,
) -> anyhow::Result<()> {
    let token = crate::load_access_token()?;
    let base = server.trim_end_matches('/');
    let client = reqwest::Client::new();

    // Fail before uploading anything if there is nowhere to put it.
    let target: serde_json::Value = client
        .get(format!("{base}/api/v1/attachments/target"))
        .bearer_auth(&token)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("could not read the attachment target: {e}"))?
        .json()
        .await?;
    if target.get("target").is_none_or(|t| t.is_null()) {
        anyhow::bail!(
            "no attachment target configured; set one with PUT {base}/api/v1/attachments/target, \
             or use --to-dir to copy ciphertext to a mounted encrypted volume"
        );
    }

    let mut cache = load_sync_cache(root_path);
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    for (rel, source) in units {
        let Some(unit) = classify(rel) else {
            continue;
        };
        if cache.contains(rel) {
            skipped += 1;
            continue;
        }
        let body = std::fs::read(source)?;
        let url = match &unit {
            Unit::Chunk { digest } => {
                format!("{base}/api/v1/attachments/replicate/chunk?digest={digest}")
            }
            Unit::Manifest { logical } => format!(
                "{base}/api/v1/attachments/replicate/manifest?path={}",
                urlencoding_path(logical)
            ),
        };
        let sent = client
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/octet-stream")
            .body(body)
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_success() => {
                cache.insert(rel.clone());
                uploaded += 1;
                println!("uploaded {rel}");
            }
            Ok(response) => {
                let status = response.status();
                let detail = response.text().await.unwrap_or_default();
                let snippet: String = detail.chars().take(200).collect();
                eprintln!("failed {rel}: {status} {snippet}");
                failed += 1;
            }
            Err(error) => {
                eprintln!("failed {rel}: {error}");
                failed += 1;
            }
        }
    }

    save_sync_cache(root_path, &cache);
    println!("replicated {uploaded} file(s), skipped {skipped} already uploaded, {failed} failed");
    if failed > 0 {
        anyhow::bail!("{failed} attachment object(s) failed to replicate");
    }
    Ok(())
}

/// Percent-encode the few characters that would otherwise change a query
/// string's shape. Store-logical paths are already restricted to safe
/// characters, so this is a belt on top of braces.
fn urlencoding_path(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            '&' => "%26".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '+' => "%2B".to_string(),
            ' ' => "%20".to_string(),
            '%' => "%25".to_string(),
            other => other.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_are_classified_by_what_the_gateway_needs() {
        let digest = "ab".repeat(32);
        match classify(&format!(".attachments/objects/ab/{digest}.oschunk")) {
            Some(Unit::Chunk { digest: got }) => assert_eq!(got, digest),
            _ => panic!("chunk should classify by digest"),
        }
        match classify("Taxes/2025.osattach") {
            Some(Unit::Manifest { logical }) => assert_eq!(logical, "Taxes/2025"),
            _ => panic!("manifest should classify by logical path"),
        }
        // Anything else in the store is not ours to replicate.
        assert!(classify("Dev/token.osseal").is_none());
        assert!(classify(".opensesame-key").is_none());
        // A chunk whose name is not a digest is not addressable by the endpoint.
        assert!(classify(".attachments/objects/zz/nothex.oschunk").is_none());
    }

    #[test]
    fn query_characters_that_would_reshape_a_url_are_encoded() {
        assert_eq!(urlencoding_path("Taxes/2025"), "Taxes/2025");
        assert_eq!(urlencoding_path("a&b"), "a%26b");
        assert_eq!(urlencoding_path("a b"), "a%20b");
        assert_eq!(urlencoding_path("a#b"), "a%23b");
        assert_eq!(urlencoding_path("100%"), "100%25");
    }
}
