//! Chunked, content-addressed file attachments for the sealed store (ADR 0054).
//!
//! An attachment is stored as a set of independently sealed chunk objects plus
//! one sealed manifest. The manifest is the root of trust: it names the chunk
//! digests in order and carries the plaintext digest of the whole file, so a
//! reader never touches a chunk the manifest did not vouch for.
//!
//! Chunks are content-addressed by the BLAKE3 of their *ciphertext* frame. The
//! per-attachment key is derived from a fresh random attachment id, so two
//! attachments holding the same bytes seal to unrelated ciphertext and share no
//! digests — content addressing therefore leaks no equality between them. The
//! deliberate cost is that identical files are stored twice.
//!
//! Ordering matters for crash safety: chunks are written first and the manifest
//! last. A crash between the two leaves orphan objects, which are ciphertext
//! nobody references and which [`StoreRoot::attach_gc`] reclaims. The reverse
//! order would leave a manifest pointing at chunks that do not exist.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use opensesame_human_vault::{
    derive_attachment_key, open_chunk, seal_chunk, ChunkAd, ItemDataKey, ENVELOPE_VERSION,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::envelope::{open_osseal_in, seal_osseal_in, COLLECTION_ATTACHMENTS};
use crate::git::auto_commit;
use crate::path::{confined_read, confined_remove, confined_write, logical_to_relative};
use crate::{StoreError, StoreRoot};

/// Plaintext bytes per chunk. Sealed, a chunk costs 48 bytes more than this —
/// far below the 100 MB per-file ceiling a git remote will accept.
pub const CHUNK_PLAINTEXT_BYTES: usize = 1_048_576;

/// Hard ceiling on one attachment (1 GiB, so at most 1024 chunks).
pub const MAX_ATTACHMENT_BYTES: u64 = 1 << 30;

/// Local anti-rollback state for manifests. Kept separate from the entry
/// revision map so an attachment name can never collide with an entry name.
pub const ATTACHMENT_REVISION_FILE: &str = ".opensesame-attachment-revisions.json";

/// Orphan objects younger than this are left alone, so a garbage collection
/// running beside an in-progress `attach_add` cannot reap its chunks before the
/// manifest that will reference them is written.
pub const GC_GRACE_SECONDS: u64 = 3600;

/// Extension of a sealed attachment manifest.
pub const ATTACH_EXT: &str = "osattach";

/// Extension of a sealed chunk object.
pub const CHUNK_EXT: &str = "oschunk";

/// Directory holding the content-addressed chunk objects. Dot-prefixed so the
/// entry walker, which skips dotted names, never descends into it.
const OBJECTS_DIR: &str = ".attachments/objects";

/// Manifest schema version.
const MANIFEST_FORMAT: u32 = 1;

/// Longest filename we will record. This is display metadata only, but it is
/// still attacker-influenced input that gets decoded on every read.
const MAX_FILENAME_BYTES: usize = 255;

/// What the caller knows about the file being attached.
pub struct AttachMeta {
    pub filename: String,
    pub mime: Option<String>,
}

/// One chunk as recorded in a manifest.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChunkRef {
    /// BLAKE3 of the sealed frame, lowercase hex.
    pub digest: String,
    pub ct_bytes: u64,
    pub pt_bytes: u64,
}

/// Sealed manifest plaintext.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentManifest {
    pub format: u32,
    pub attachment_id: String,
    pub filename: String,
    pub mime: String,
    pub total_bytes: u64,
    pub chunk_bytes: u64,
    pub chunk_count: u32,
    pub chunks: Vec<ChunkRef>,
    /// `blake3:<hex>` over the whole plaintext.
    pub content_digest: String,
    pub created_at_unix_ms: u64,
}

/// Metadata view of a stored attachment. Never carries file bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentSummary {
    pub name: String,
    pub attachment_id: String,
    pub filename: String,
    pub mime: String,
    pub total_bytes: u64,
    pub chunk_count: u32,
    pub content_digest: String,
}

/// Result of a garbage collection pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GcOutcome {
    pub removed: usize,
    pub kept: usize,
    pub skipped_recent: usize,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Guess a content type from the extension alone. Never sniff content: the
/// bytes are the user's document, and a sniffer is one more parser to attack.
fn mime_for(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Strip a recorded filename down to something safe to use as a local output
/// name. Returns `None` when nothing usable survives.
pub fn sanitize_filename(filename: &str) -> Option<String> {
    let base = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('.');
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != '\0')
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    Some(cleaned)
}

fn object_relative(digest_hex: &str) -> Result<PathBuf, StoreError> {
    // The digest is produced by us from BLAKE3 output, but it also arrives from
    // a decrypted manifest, so validate before it reaches a path.
    if digest_hex.len() != 64 || !digest_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(StoreError::InvalidPath("invalid chunk digest".into()));
    }
    let lowered = digest_hex.to_ascii_lowercase();
    Ok(PathBuf::from(OBJECTS_DIR)
        .join(&lowered[0..2])
        .join(format!("{lowered}.{CHUNK_EXT}")))
}

fn attach_relative(name: &str) -> Result<PathBuf, StoreError> {
    let rel = logical_to_relative(name)?;
    // Append rather than `with_extension`, matching entry naming so a dotted
    // logical name keeps its final label.
    let mut file = rel.into_os_string();
    file.push(".");
    file.push(ATTACH_EXT);
    Ok(PathBuf::from(file))
}

impl StoreRoot {
    fn attachment_revisions(&self) -> Result<BTreeMap<String, u64>, StoreError> {
        let path = self.path.join(ATTACHMENT_REVISION_FILE);
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        serde_json::from_slice(&confined_read(
            &self.path,
            Path::new(ATTACHMENT_REVISION_FILE),
        )?)
        .map_err(|e| StoreError::Crypto(format!("invalid attachment revision state: {e}")))
    }

    fn record_attachment_revision(&self, name: &str, revision: u64) -> Result<(), StoreError> {
        let mut revisions = self.attachment_revisions()?;
        revisions.insert(name.to_string(), revision);
        let bytes = serde_json::to_vec(&revisions)
            .map_err(|e| StoreError::Crypto(format!("attachment revision state: {e}")))?;
        confined_write(&self.path, Path::new(ATTACHMENT_REVISION_FILE), &bytes)
    }

    fn next_attachment_revision(&self, name: &str) -> Result<u64, StoreError> {
        let current = self
            .attachment_revisions()?
            .get(name)
            .copied()
            .unwrap_or_else(|| {
                // No local record. Fall back to what the stored manifest claims
                // so a fresh clone keeps counting up rather than restarting.
                self.stored_attachment_revision(name).unwrap_or(0)
            });
        let next = current
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("attachment revision exhausted".into()))?;
        // Advance trusted local state before replacing ciphertext, so a crash
        // can never leave an older manifest valid.
        self.record_attachment_revision(name, next)?;
        Ok(next)
    }

    /// Revision recorded inside a stored manifest's associated data, read
    /// without a key (the AD travels in cleartext beside the ciphertext).
    fn stored_attachment_revision(&self, name: &str) -> Option<u64> {
        let rel = attach_relative(name).ok()?;
        let blob = confined_read(&self.path, &rel).ok()?;
        crate::envelope::envelope_revision(&blob).ok()
    }

    /// Seal `source` into chunk objects plus a manifest filed at `name`.
    ///
    /// `total_bytes` must be the exact length of `source`; it fixes the chunk
    /// count, which is bound into every chunk's associated data and is what
    /// makes truncation detectable.
    pub fn attach_add(
        &self,
        name: &str,
        source: &mut dyn Read,
        total_bytes: u64,
        meta: AttachMeta,
        key: &ItemDataKey,
        force: bool,
    ) -> Result<AttachmentSummary, StoreError> {
        if total_bytes > MAX_ATTACHMENT_BYTES {
            return Err(StoreError::Crypto(format!(
                "attachment is {total_bytes} bytes, over the {MAX_ATTACHMENT_BYTES} byte limit"
            )));
        }
        if meta.filename.len() > MAX_FILENAME_BYTES {
            return Err(StoreError::InvalidPath("filename too long".into()));
        }
        let rel = attach_relative(name)?;
        if !force && self.path.join(&rel).exists() {
            return Err(StoreError::AlreadyExists(name.into()));
        }

        let mut id_bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let attachment_id = hex_lower(&id_bytes);
        let attachment_key = derive_attachment_key(key, &id_bytes);

        let chunk_size = CHUNK_PLAINTEXT_BYTES as u64;
        let chunk_count = total_bytes.div_ceil(chunk_size) as u32;

        let mut chunks: Vec<ChunkRef> = Vec::with_capacity(chunk_count as usize);
        let mut content = blake3::Hasher::new();
        let mut written: u64 = 0;
        let mut buffer = vec![0u8; CHUNK_PLAINTEXT_BYTES];

        for chunk_index in 0..chunk_count {
            let remaining = total_bytes - written;
            let want = remaining.min(chunk_size) as usize;
            read_exact_chunk(source, &mut buffer[..want])?;
            let plaintext = &buffer[..want];
            content.update(plaintext);

            let ad = ChunkAd {
                envelope_version: ENVELOPE_VERSION,
                attachment_id: attachment_id.clone(),
                item_id: name.to_string(),
                chunk_index,
                chunk_count,
            };
            let frame = seal_chunk(&attachment_key, plaintext, &ad)
                .map_err(|e| StoreError::Crypto(e.to_string()))?;
            let digest = blake3::hash(&frame).to_hex().to_string();
            let object_rel = object_relative(&digest)?;
            // Content-addressed: an identical frame is already the same bytes,
            // so re-writing it would be busywork.
            if !self.path.join(&object_rel).exists() {
                confined_write(&self.path, &object_rel, &frame)?;
            }
            chunks.push(ChunkRef {
                digest,
                ct_bytes: frame.len() as u64,
                pt_bytes: want as u64,
            });
            written += want as u64;
        }

        // Refuse a source that under-delivered: the chunk count is already
        // sealed into every frame, so a short read would produce an attachment
        // that can never be reassembled.
        if written != total_bytes {
            return Err(StoreError::Crypto(format!(
                "source yielded {written} bytes, expected {total_bytes}"
            )));
        }
        // And refuse one that has more to give than it declared.
        let mut extra = [0u8; 1];
        if source.read(&mut extra).unwrap_or(0) != 0 {
            return Err(StoreError::Crypto(
                "source is longer than the declared length".into(),
            ));
        }

        let manifest = AttachmentManifest {
            format: MANIFEST_FORMAT,
            attachment_id: attachment_id.clone(),
            filename: meta.filename.clone(),
            mime: meta.mime.unwrap_or_else(|| mime_for(&meta.filename)),
            total_bytes,
            chunk_bytes: chunk_size,
            chunk_count,
            chunks,
            content_digest: format!("blake3:{}", content.finalize().to_hex()),
            created_at_unix_ms: now_unix_ms(),
        };

        let revision = self.next_attachment_revision(name)?;
        let plaintext = serde_json::to_vec(&manifest)
            .map_err(|e| StoreError::Crypto(format!("manifest encode: {e}")))?;
        let sealed = seal_osseal_in(COLLECTION_ATTACHMENTS, &plaintext, key, name, revision)?;
        confined_write(&self.path, &rel, &sealed)?;

        auto_commit(&self.path, &format!("Attach {name}"))?;
        Ok(summary_of(name, &manifest))
    }

    fn open_manifest(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<AttachmentManifest, StoreError> {
        let rel = attach_relative(name)?;
        if !self.path.join(&rel).exists() {
            return Err(StoreError::NotFound(name.into()));
        }
        let blob = confined_read(&self.path, &rel)?;
        // A locally recorded revision pins the expected value; without one we
        // accept what the blob claims, exactly as entries do on a fresh clone.
        let expected = self.attachment_revisions()?.get(name).copied();
        let opened = open_osseal_in(COLLECTION_ATTACHMENTS, &blob, key, name, expected)?;
        let manifest: AttachmentManifest = serde_json::from_slice(&opened.plaintext)
            .map_err(|e| StoreError::Crypto(format!("invalid manifest: {e}")))?;
        if manifest.format != MANIFEST_FORMAT {
            return Err(StoreError::Crypto(format!(
                "unsupported manifest format {}",
                manifest.format
            )));
        }
        if manifest.chunks.len() != manifest.chunk_count as usize {
            return Err(StoreError::Crypto("manifest chunk count mismatch".into()));
        }
        if manifest.filename.len() > MAX_FILENAME_BYTES {
            return Err(StoreError::Crypto("manifest filename too long".into()));
        }
        let declared: u64 = manifest.chunks.iter().map(|c| c.pt_bytes).sum();
        if declared != manifest.total_bytes {
            return Err(StoreError::Crypto("manifest size mismatch".into()));
        }
        Ok(manifest)
    }

    /// Reassemble an attachment into `sink`.
    pub fn attach_get(
        &self,
        name: &str,
        sink: &mut dyn Write,
        key: &ItemDataKey,
    ) -> Result<AttachmentSummary, StoreError> {
        let manifest = self.open_manifest(name, key)?;
        let mut id_bytes = [0u8; 16];
        hex_to_bytes(&manifest.attachment_id, &mut id_bytes)?;
        let attachment_key = derive_attachment_key(key, &id_bytes);

        let mut content = blake3::Hasher::new();
        let mut written: u64 = 0;
        for (index, chunk) in manifest.chunks.iter().enumerate() {
            let object_rel = object_relative(&chunk.digest)?;
            let frame = confined_read(&self.path, &object_rel)?;
            // Verify the content address before handing the frame to the AEAD:
            // a mismatch means the object pool was tampered with, and that is
            // worth reporting as such rather than as a decrypt failure.
            if blake3::hash(&frame).to_hex().to_string() != chunk.digest {
                return Err(StoreError::Crypto(format!(
                    "chunk {index} does not match its content address"
                )));
            }
            if frame.len() as u64 != chunk.ct_bytes {
                return Err(StoreError::Crypto(format!(
                    "chunk {index} has unexpected ciphertext length"
                )));
            }
            let ad = ChunkAd {
                envelope_version: ENVELOPE_VERSION,
                attachment_id: manifest.attachment_id.clone(),
                item_id: name.to_string(),
                chunk_index: index as u32,
                chunk_count: manifest.chunk_count,
            };
            let plaintext = open_chunk(&attachment_key, &frame, &ad)
                .map_err(|e| StoreError::Crypto(e.to_string()))?;
            if plaintext.len() as u64 != chunk.pt_bytes {
                return Err(StoreError::Crypto(format!(
                    "chunk {index} has unexpected plaintext length"
                )));
            }
            content.update(&plaintext);
            written += plaintext.len() as u64;
            sink.write_all(&plaintext)?;
        }

        if written != manifest.total_bytes {
            return Err(StoreError::Crypto("reassembled size mismatch".into()));
        }
        let digest = format!("blake3:{}", content.finalize().to_hex());
        if digest != manifest.content_digest {
            return Err(StoreError::Crypto(
                "reassembled content digest mismatch".into(),
            ));
        }
        sink.flush()?;
        Ok(summary_of(name, &manifest))
    }

    /// List attachment metadata, optionally filtered by logical-name prefix.
    pub fn attach_ls(
        &self,
        prefix: Option<&str>,
        key: &ItemDataKey,
    ) -> Result<Vec<AttachmentSummary>, StoreError> {
        let mut out = Vec::new();
        for name in self.attachment_names()? {
            if let Some(prefix) = prefix {
                if !name.starts_with(prefix) {
                    continue;
                }
            }
            let manifest = self.open_manifest(&name, key)?;
            out.push(summary_of(&name, &manifest));
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Remove an attachment's manifest and reclaim whatever it alone held.
    ///
    /// This is not erasure: the ciphertext stays in git history.
    pub fn attach_rm(&self, name: &str, key: &ItemDataKey) -> Result<(), StoreError> {
        let rel = attach_relative(name)?;
        if !self.path.join(&rel).exists() {
            return Err(StoreError::NotFound(name.into()));
        }
        confined_remove(&self.path, &rel)?;
        // Leave a tombstone revision so the manifest we just dropped cannot be
        // restored from history and still validate.
        let next = self
            .attachment_revisions()?
            .get(name)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        self.record_attachment_revision(name, next)?;
        self.collect_garbage(key)?;
        auto_commit(&self.path, &format!("Remove attachment {name}"))?;
        Ok(())
    }

    /// Reclaim chunk objects no manifest references.
    pub fn attach_gc(&self, key: &ItemDataKey) -> Result<GcOutcome, StoreError> {
        let outcome = self.collect_garbage(key)?;
        if outcome.removed > 0 {
            auto_commit(&self.path, "GC attachments")?;
        }
        Ok(outcome)
    }

    fn collect_garbage(&self, key: &ItemDataKey) -> Result<GcOutcome, StoreError> {
        // Build the referenced set from every manifest. If even one manifest
        // cannot be opened we do not know what it protects, so we remove
        // nothing rather than risk deleting live chunks.
        let mut referenced: BTreeSet<String> = BTreeSet::new();
        for name in self.attachment_names()? {
            let manifest = self.open_manifest(&name, key).map_err(|e| {
                StoreError::Crypto(format!(
                    "refusing to collect garbage: manifest {name} could not be opened ({e})"
                ))
            })?;
            for chunk in &manifest.chunks {
                referenced.insert(chunk.digest.to_ascii_lowercase());
            }
        }

        let mut outcome = GcOutcome {
            removed: 0,
            kept: 0,
            skipped_recent: 0,
        };
        let now = SystemTime::now();
        for (digest, rel) in self.object_files()? {
            if referenced.contains(&digest) {
                outcome.kept += 1;
                continue;
            }
            // An orphan may belong to an attach that is still running.
            let age_ok = std::fs::metadata(self.path.join(&rel))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .map(|age| age.as_secs() >= GC_GRACE_SECONDS)
                .unwrap_or(false);
            if !age_ok {
                outcome.skipped_recent += 1;
                continue;
            }
            confined_remove(&self.path, &rel)?;
            outcome.removed += 1;
        }
        Ok(outcome)
    }

    /// Every ciphertext file replication needs, without opening any of it.
    ///
    /// Returns `(relative path, absolute path)` pairs covering all manifests
    /// and all chunk objects. Orphans are included: they are ciphertext, and
    /// copying a few extra is cheaper than requiring a passphrase here.
    pub fn attach_replication_units(&self) -> Result<Vec<(String, PathBuf)>, StoreError> {
        let mut units: Vec<(String, PathBuf)> = Vec::new();
        for name in self.attachment_names()? {
            let rel = attach_relative(&name)?;
            units.push((rel.to_string_lossy().into_owned(), self.path.join(&rel)));
        }
        for (_, rel) in self.object_files()? {
            units.push((rel.to_string_lossy().into_owned(), self.path.join(&rel)));
        }
        units.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(units)
    }

    /// Logical names of every stored attachment.
    fn attachment_names(&self) -> Result<Vec<String>, StoreError> {
        let mut names = Vec::new();
        collect_manifests(&self.path, &self.path, &mut names)?;
        names.sort();
        Ok(names)
    }

    /// `(digest, relative path)` for every chunk object in the pool.
    fn object_files(&self) -> Result<Vec<(String, PathBuf)>, StoreError> {
        let mut out = Vec::new();
        let root = self.path.join(OBJECTS_DIR);
        if !root.exists() {
            return Ok(out);
        }
        let shards = match std::fs::read_dir(&root) {
            Ok(shards) => shards,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(StoreError::Io(e)),
        };
        for shard in shards {
            let shard = shard.map_err(StoreError::Io)?;
            if !shard.file_type().map_err(StoreError::Io)?.is_dir() {
                continue;
            }
            for object in std::fs::read_dir(shard.path()).map_err(StoreError::Io)? {
                let object = object.map_err(StoreError::Io)?;
                if !object.file_type().map_err(StoreError::Io)?.is_file() {
                    continue;
                }
                let file_name = object.file_name();
                let Some(file_name) = file_name.to_str() else {
                    continue;
                };
                let Some(digest) = file_name.strip_suffix(&format!(".{CHUNK_EXT}")) else {
                    continue;
                };
                if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                    continue;
                }
                let rel = PathBuf::from(OBJECTS_DIR)
                    .join(shard.file_name())
                    .join(file_name);
                out.push((digest.to_ascii_lowercase(), rel));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }
}

fn summary_of(name: &str, manifest: &AttachmentManifest) -> AttachmentSummary {
    AttachmentSummary {
        name: name.to_string(),
        attachment_id: manifest.attachment_id.clone(),
        filename: manifest.filename.clone(),
        mime: manifest.mime.clone(),
        total_bytes: manifest.total_bytes,
        chunk_count: manifest.chunk_count,
        content_digest: manifest.content_digest.clone(),
    }
}

/// Walk the store for `.osattach` files, skipping dot-prefixed directories so
/// the object pool and local state files are never treated as manifests.
fn collect_manifests(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), StoreError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(StoreError::Io(e)),
    };
    for entry in entries {
        let entry = entry.map_err(StoreError::Io)?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(StoreError::Io)?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_manifests(root, &entry.path(), out)?;
            continue;
        }
        let Some(stem) = file_name.strip_suffix(&format!(".{ATTACH_EXT}")) else {
            continue;
        };
        let rel_dir = entry
            .path()
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let logical = if rel_dir.as_os_str().is_empty() {
            stem.to_string()
        } else {
            format!("{}/{}", rel_dir.to_string_lossy(), stem)
        };
        out.push(logical);
    }
    Ok(())
}

/// Read exactly `buf.len()` bytes, treating a short stream as an error.
fn read_exact_chunk(source: &mut dyn Read, buf: &mut [u8]) -> Result<(), StoreError> {
    let mut filled = 0;
    while filled < buf.len() {
        match source.read(&mut buf[filled..]) {
            Ok(0) => {
                return Err(StoreError::Crypto(
                    "source ended before the declared length".into(),
                ))
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(StoreError::Io(e)),
        }
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_to_bytes(hex: &str, out: &mut [u8; 16]) -> Result<(), StoreError> {
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(StoreError::Crypto("invalid attachment id".into()));
    }
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| StoreError::Crypto("invalid attachment id".into()))?;
    }
    Ok(())
}

#[cfg(test)]
mod pact {
    use super::*;
    use crate::store::{init_store, init_store_key};
    use crate::Entry;
    use tempfile::TempDir;

    fn store() -> (TempDir, StoreRoot, ItemDataKey) {
        let dir = TempDir::new().expect("tempdir");
        let root = init_store(dir.path(), &[]).expect("init");
        let key = init_store_key(dir.path(), b"correct horse").expect("key");
        (dir, root, key)
    }

    fn add(root: &StoreRoot, key: &ItemDataKey, name: &str, bytes: &[u8]) -> AttachmentSummary {
        let mut source = std::io::Cursor::new(bytes.to_vec());
        root.attach_add(
            name,
            &mut source,
            bytes.len() as u64,
            AttachMeta {
                filename: "scan.pdf".into(),
                mime: None,
            },
            key,
            false,
        )
        .expect("attach_add")
    }

    fn get(root: &StoreRoot, key: &ItemDataKey, name: &str) -> Result<Vec<u8>, StoreError> {
        let mut sink: Vec<u8> = Vec::new();
        root.attach_get(name, &mut sink, key)?;
        Ok(sink)
    }

    // --- property -----------------------------------------------------------

    #[test]
    fn round_trips_across_chunk_boundaries() {
        let (_dir, root, key) = store();
        for (i, size) in [
            0usize,
            1,
            CHUNK_PLAINTEXT_BYTES - 1,
            CHUNK_PLAINTEXT_BYTES,
            CHUNK_PLAINTEXT_BYTES + 1,
            3 * CHUNK_PLAINTEXT_BYTES + 17,
        ]
        .into_iter()
        .enumerate()
        {
            let payload: Vec<u8> = (0..size).map(|n| (n % 251) as u8).collect();
            let name = format!("Taxes/doc{i}");
            add(&root, &key, &name, &payload);
            assert_eq!(get(&root, &key, &name).unwrap(), payload, "size {size}");
        }
    }

    #[test]
    fn empty_attachment_writes_no_chunks() {
        let (_dir, root, key) = store();
        let summary = add(&root, &key, "Empty/file", b"");
        assert_eq!(summary.chunk_count, 0);
        assert!(root.object_files().unwrap().is_empty());
        assert_eq!(get(&root, &key, "Empty/file").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn identical_bytes_share_no_digests() {
        let (_dir, root, key) = store();
        let payload = b"identical government id scan".to_vec();
        let a = add(&root, &key, "One/scan", &payload);
        let b = add(&root, &key, "Two/scan", &payload);
        assert_ne!(a.attachment_id, b.attachment_id);
        // Same plaintext digest, but the object pool holds two distinct frames.
        assert_eq!(a.content_digest, b.content_digest);
        assert_eq!(root.object_files().unwrap().len(), 2);
    }

    // --- adversarial --------------------------------------------------------

    #[test]
    fn tampered_chunk_fails_closed() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let (_, rel) = root.object_files().unwrap().remove(0);
        let mut frame = confined_read(&root.path, &rel).unwrap();
        let last = frame.len() - 1;
        frame[last] ^= 0x01;
        confined_write(&root.path, &rel, &frame).unwrap();
        assert!(get(&root, &key, "Taxes/w2").is_err());
    }

    #[test]
    fn chunk_from_another_attachment_cannot_be_spliced() {
        let (_dir, root, key) = store();
        add(&root, &key, "One/scan", b"first document");
        add(&root, &key, "Two/scan", b"second document");
        let objects = root.object_files().unwrap();
        let (_, first) = objects[0].clone();
        let (_, second) = objects[1].clone();
        // Overwrite one object with the other's frame. The content address no
        // longer matches, which is caught before the AEAD is even consulted.
        let stolen = confined_read(&root.path, &second).unwrap();
        confined_write(&root.path, &first, &stolen).unwrap();
        let one = get(&root, &key, "One/scan");
        let two = get(&root, &key, "Two/scan");
        assert!(one.is_err() || two.is_err());
    }

    #[test]
    fn missing_chunk_fails_closed() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let (_, rel) = root.object_files().unwrap().remove(0);
        confined_remove(&root.path, &rel).unwrap();
        assert!(get(&root, &key, "Taxes/w2").is_err());
    }

    #[test]
    fn wrong_key_cannot_open_manifest() {
        let (dir, root, _key) = store();
        let key = init_store_key(dir.path(), b"first").unwrap();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let other = ItemDataKey([9u8; 32]);
        assert!(root.attach_ls(None, &other).is_err());
    }

    #[test]
    fn declared_length_must_match_source() {
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(b"only nine".to_vec());
        let result = root.attach_add(
            "Taxes/short",
            &mut source,
            9_999,
            AttachMeta {
                filename: "x.pdf".into(),
                mime: None,
            },
            &key,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn an_oversize_attachment_is_refused_before_anything_is_read() {
        // The ceiling is checked against the declared length before a single
        // byte is read, so this needs no gigabyte on disk. Untested, this guard
        // could be inverted and nothing else would notice.
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(b"tiny".to_vec());
        let err = root
            .attach_add(
                "Taxes/huge",
                &mut source,
                MAX_ATTACHMENT_BYTES + 1,
                AttachMeta {
                    filename: "x.pdf".into(),
                    mime: None,
                },
                &key,
                false,
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("over the"),
            "should refuse on size, not on a later length mismatch: {err}"
        );
        // Nothing was written on the way to refusing.
        assert!(root.object_files().unwrap().is_empty());
    }

    #[test]
    fn an_overlong_filename_is_refused() {
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(b"x".to_vec());
        assert!(root
            .attach_add(
                "Taxes/long",
                &mut source,
                1,
                AttachMeta {
                    filename: "a".repeat(300),
                    mime: None
                },
                &key,
                false,
            )
            .is_err());
    }

    #[test]
    fn a_source_longer_than_declared_is_refused() {
        // The counterpart to declared_length_must_match_source. A file that
        // grew between stat and read must not silently seal truncated: the
        // chunk count is already bound into every frame.
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(vec![7u8; 5000]);
        let err = root
            .attach_add(
                "Taxes/grew",
                &mut source,
                100,
                AttachMeta {
                    filename: "x.pdf".into(),
                    mime: None,
                },
                &key,
                false,
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("longer than the declared length"),
            "{err}"
        );
    }

    #[test]
    fn existing_name_needs_force() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"one");
        let mut source = std::io::Cursor::new(b"two".to_vec());
        assert!(root
            .attach_add(
                "Taxes/w2",
                &mut source,
                3,
                AttachMeta {
                    filename: "x.pdf".into(),
                    mime: None
                },
                &key,
                false,
            )
            .is_err());
    }

    #[test]
    fn filename_is_sanitized_for_local_use() {
        assert_eq!(
            sanitize_filename("../../etc/passwd").as_deref(),
            Some("passwd")
        );
        assert_eq!(sanitize_filename("a/b/c.pdf").as_deref(), Some("c.pdf"));
        assert_eq!(sanitize_filename(".."), None);
        assert_eq!(sanitize_filename("   "), None);
        assert_eq!(sanitize_filename(""), None);
    }

    // --- chaos --------------------------------------------------------------

    #[test]
    fn gc_spares_young_orphans_and_keeps_referenced() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        // Simulate a crashed add: an orphan object written moments ago.
        let orphan = object_relative(&"ab".repeat(32)).unwrap();
        confined_write(&root.path, &orphan, b"not a real frame").unwrap();
        let outcome = root.attach_gc(&key).unwrap();
        assert_eq!(outcome.removed, 0, "young orphan must survive");
        assert_eq!(outcome.skipped_recent, 1);
        assert_eq!(outcome.kept, 1);
        assert!(get(&root, &key, "Taxes/w2").is_ok());
    }

    #[test]
    fn gc_reclaims_an_orphan_once_it_is_past_the_grace_window() {
        // The other GC tests both assert nothing was removed, which leaves the
        // reclaim path itself unproven: GC could silently never free space and
        // they would all still pass. Backdate an orphan past the grace window
        // and require that it actually goes.
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let live_before = root.object_files().unwrap().len();

        let orphan = object_relative(&"cd".repeat(32)).unwrap();
        confined_write(&root.path, &orphan, b"orphaned ciphertext").unwrap();
        let aged = std::time::SystemTime::now()
            - std::time::Duration::from_secs(GC_GRACE_SECONDS + 60);
        let handle = std::fs::File::options()
            .write(true)
            .open(root.path.join(&orphan))
            .unwrap();
        handle
            .set_times(std::fs::FileTimes::new().set_modified(aged))
            .unwrap();
        drop(handle);

        let outcome = root.attach_gc(&key).unwrap();
        assert_eq!(outcome.removed, 1, "an aged orphan must be reclaimed");
        assert_eq!(outcome.kept, live_before, "referenced chunks must survive");
        assert_eq!(outcome.skipped_recent, 0);
        assert!(!root.path.join(&orphan).exists(), "the file must be gone");
        // And the attachment that was never orphaned still opens.
        assert_eq!(get(&root, &key, "Taxes/w2").unwrap(), b"sensitive".to_vec());
    }

    #[test]
    fn gc_removes_nothing_when_a_manifest_will_not_open() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let rel = attach_relative("Broken/one").unwrap();
        confined_write(&root.path, &rel, b"OSSEAL1\n{not json").unwrap();
        let before = root.object_files().unwrap().len();
        assert!(root.attach_gc(&key).is_err());
        assert_eq!(root.object_files().unwrap().len(), before);
    }

    #[test]
    fn removing_one_attachment_leaves_the_other_readable() {
        let (_dir, root, key) = store();
        add(&root, &key, "One/scan", b"first");
        add(&root, &key, "Two/scan", b"second");
        root.attach_rm("One/scan", &key).unwrap();
        assert!(get(&root, &key, "One/scan").is_err());
        assert_eq!(get(&root, &key, "Two/scan").unwrap(), b"second".to_vec());
    }

    // --- contract -----------------------------------------------------------

    #[test]
    fn listing_is_metadata_only_and_excludes_entries() {
        let (_dir, root, key) = store();
        root.insert("Dev/token", &Entry::parse("hunter2"), &key)
            .expect("entry");
        add(&root, &key, "Taxes/w2", b"sensitive");
        let listed = root.attach_ls(None, &key).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Taxes/w2");
        assert_eq!(listed[0].filename, "scan.pdf");
        assert_eq!(listed[0].mime, "application/pdf");
        // And the entry walker still ignores attachments.
        let entries = root.ls("").unwrap();
        assert!(entries.iter().all(|e| !e.contains("Taxes/w2")));
    }

    #[test]
    fn replication_units_need_no_key() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let units = root.attach_replication_units().unwrap();
        assert!(units.iter().any(|(rel, _)| rel.ends_with(".osattach")));
        assert!(units.iter().any(|(rel, _)| rel.ends_with(".oschunk")));
    }

    /// Re-seal `name`'s manifest after `mutate` has tampered with it, keeping
    /// the envelope perfectly valid. This models the one attacker who gets
    /// past the AEAD: someone holding the key.
    fn reseal_manifest_with(
        root: &StoreRoot,
        key: &ItemDataKey,
        name: &str,
        mutate: impl FnOnce(&mut AttachmentManifest),
    ) {
        let mut manifest = root.open_manifest(name, key).unwrap();
        mutate(&mut manifest);
        let revision = root.attachment_revisions().unwrap()[name];
        let plaintext = serde_json::to_vec(&manifest).unwrap();
        let sealed =
            seal_osseal_in(COLLECTION_ATTACHMENTS, &plaintext, key, name, revision).unwrap();
        confined_write(&root.path, &attach_relative(name).unwrap(), &sealed).unwrap();
    }

    #[test]
    fn a_manifest_that_decrypts_but_lies_is_refused() {
        // These guards sit behind the AEAD, so only a key-holder or a bug can
        // reach them — which is exactly why nothing was exercising them.
        let (_dir, root, key) = store();

        // Claims more chunks than it lists.
        add(&root, &key, "A/one", b"payload one");
        reseal_manifest_with(&root, &key, "A/one", |m| m.chunk_count += 1);
        assert!(get(&root, &key, "A/one").is_err(), "chunk count must agree");

        // Chunk sizes no longer sum to the declared total.
        add(&root, &key, "B/two", b"payload two");
        reseal_manifest_with(&root, &key, "B/two", |m| m.total_bytes += 512);
        assert!(get(&root, &key, "B/two").is_err(), "sizes must agree");

        // An unsupported format version.
        add(&root, &key, "C/three", b"payload three");
        reseal_manifest_with(&root, &key, "C/three", |m| m.format = 99);
        assert!(get(&root, &key, "C/three").is_err(), "format must be known");

        // A filename long enough to be a problem downstream.
        add(&root, &key, "D/four", b"payload four");
        reseal_manifest_with(&root, &key, "D/four", |m| m.filename = "z".repeat(300));
        assert!(get(&root, &key, "D/four").is_err(), "filename must be bounded");

        // A digest that is not a digest never reaches the filesystem as a path.
        add(&root, &key, "E/five", b"payload five");
        reseal_manifest_with(&root, &key, "E/five", |m| {
            m.chunks[0].digest = "../../etc/passwd".into()
        });
        assert!(get(&root, &key, "E/five").is_err(), "digest must be hex");
    }

    #[test]
    fn a_chunk_of_unexpected_length_is_refused() {
        let (_dir, root, key) = store();
        add(&root, &key, "A/one", b"payload one");
        // The manifest is honest about the digest but lies about the size.
        reseal_manifest_with(&root, &key, "A/one", |m| m.chunks[0].ct_bytes += 1);
        assert!(get(&root, &key, "A/one").is_err());
    }

    #[test]
    fn manifest_is_bound_to_its_path() {
        let (_dir, root, key) = store();
        add(&root, &key, "One/scan", b"first");
        let from = attach_relative("One/scan").unwrap();
        let to = attach_relative("Two/scan").unwrap();
        let blob = confined_read(&root.path, &from).unwrap();
        confined_write(&root.path, &to, &blob).unwrap();
        // Same ciphertext, different logical path: the associated data no
        // longer reconstructs, so it must not open.
        assert!(root.attach_ls(Some("Two/"), &key).is_err());
    }
}
