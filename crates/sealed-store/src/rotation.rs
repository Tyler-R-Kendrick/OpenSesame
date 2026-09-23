//! Store-wide root rotation: re-encrypt every entry and attachment under a new
//! vault root key, then swap the key file in last.
//!
//! Content is sealed directly under the root (`ItemDataKey(vrk.0)`), so a new
//! root is only safe once everything sealed under the old one has moved. The
//! order below is what keeps a failure from destroying data:
//!
//! 1. **Stage** — open every `.osseal` entry and `.osattach` manifest with the
//!    old key and write its new ciphertext into `.opensesame-rotation/new/`.
//!    Attachment chunks are resealed into the content-addressed pool, where a
//!    new digest never overwrites anything. Any failure here removes what was
//!    staged and returns; the store and its key file are untouched.
//! 2. **Persist the new key file** into the staging directory, fsynced, so a
//!    crash in the next step never loses the root the swapped files need.
//! 3. **Swap** each staged file into place, keeping the previous ciphertext in
//!    `.opensesame-rotation/old/`. An error rolls every swap back.
//! 4. **Commit** — rename the new key file over `.opensesame-key` (atomic),
//!    then drop the staging directory and the old chunk objects.
//!
//! A crash between 2 and 4 leaves both key files and both ciphertext sets on
//! disk; nothing is deleted before the commit rename. The staging directory is
//! dot-prefixed, so `auto_commit` never picks it up, a later rotation refuses
//! to start while it exists, and every ordinary write refuses while it exists.
//!
//! What is re-encrypted comes from `rotation_walk`, not the `ls` walker that
//! hides dot-named entries like `Dev/.npmrc`; before the key swap the tree is
//! inventoried again, and anything left behind rolls the rotation back. The
//! run holds the store lock exclusively (`store_lock`) throughout.
//!
//! Rotation is not retroactive: ciphertext and key files already in git history
//! still open with the old root. What it guarantees is that nothing written
//! from here on — including the re-encrypted current content — opens with it.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::{
    encode_key_file, prepare_root_rotation, sync_dir, write_synced, KeyFileContents,
    ProtectionError, ReissuedRecovery, RotationEdit, KEY_FILE_NAME,
};
use opensesame_human_vault::{
    derive_attachment_key, open_chunk, seal_chunk, ChunkAd, ItemDataKey, ENVELOPE_VERSION,
};
use zeroize::Zeroize;

use crate::age_fmt::encrypt_age;
use crate::attachment::{attach_relative, hex_to_bytes, object_relative, ChunkRef};
use crate::envelope::{
    envelope_revision, open_osseal, seal_osseal, seal_osseal_in, COLLECTION_ATTACHMENTS,
};
use crate::git::auto_commit;
use crate::path::{confined_read, confined_remove, confined_write};
use crate::rotation_walk::inventory;
use crate::store_lock::StoreLock;
use crate::{StoreError, StoreRoot};

/// Staging directory for an in-flight rotation, relative to the store root.
pub const ROTATION_STAGING_DIR: &str = ".opensesame-rotation";

const COMMIT_ROTATE: &str = "seal: rotate vault root key";

/// What a completed rotation did.
pub struct RotationOutcome {
    /// `.osseal` entries re-encrypted under the new root.
    pub entries: usize,
    /// Attachments (manifest and every chunk) re-encrypted under the new root.
    pub attachments: usize,
    /// `.gpg` / `.age` entries, which are not sealed under the root and were
    /// left exactly as they were.
    pub foreign_entries: usize,
    /// The manifest's root epoch after rotation.
    pub root_epoch: u64,
    /// Recovery keys minted in place of the old ones; show each once.
    pub reissued_recovery: Vec<ReissuedRecovery>,
}

/// Rotate the store's root key, re-encrypting all content sealed under it.
///
/// `edit` folds a passphrase change or a protector removal into the same
/// rotation, so the old passphrase or removed protector cannot open anything
/// the store holds afterwards.
///
/// # Errors
///
/// Returns unlock and protector errors before anything is written, and any
/// read, decrypt or write failure while staging — in every such case the store
/// and its key file are left as they were.
pub fn rotate_store_root(
    root: &Path,
    password: &[u8],
    edit: RotationEdit<'_>,
) -> Result<RotationOutcome, StoreError> {
    rotate_store_root_observed(root, password, edit, &mut |_| {})
}

/// [`rotate_store_root`], calling `staged` once everything is re-encrypted into
/// staging and before anything is swapped — the window a concurrent writer
/// would have to land in.
pub(crate) fn rotate_store_root_observed(
    root: &Path,
    password: &[u8],
    edit: RotationEdit<'_>,
    staged: &mut dyn FnMut(&Path),
) -> Result<RotationOutcome, StoreError> {
    if !root.join(KEY_FILE_NAME).exists() {
        return Err(StoreError::NotInitialized(root.to_path_buf()));
    }
    let _lock = StoreLock::exclusive(root)?;
    let staging = root.join(ROTATION_STAGING_DIR);
    if fs::symlink_metadata(&staging).is_ok() {
        return Err(StoreError::Other(format!(
            "an interrupted rotation left {}: key.next is the new key file and old/ holds the \
             previous ciphertext (plan.json maps them); restore or remove it before rotating again",
            staging.display()
        )));
    }
    let store = StoreRoot::open(root)?;
    let seal_capsule = |vrk: &opensesame_human_vault::VaultRootKey, recipients: &[String]| {
        encrypt_age(&vrk.0, recipients)
            .map(|capsule| STANDARD.encode(capsule))
            .map_err(|e| ProtectionError::Unavailable(format!("age capsule: {e}")))
    };
    let prepared = prepare_root_rotation(root, password, edit, &seal_capsule)?;
    let old_key = ItemDataKey(prepared.old_vrk.0);
    let new_key = ItemDataKey(prepared.new_vrk.0);
    let key_json = encode_key_file(&KeyFileContents::Manifest(prepared.manifest.clone()))?;
    let sealed = inventory(root)?;

    create_private_dir(&staging)?;
    let mut plan = Plan {
        foreign_entries: sealed.foreign,
        ..Plan::default()
    };
    let mut stranded = false;
    let keys = (&old_key, &new_key);
    let result = stage_entries(&store, &staging, &sealed.entries, keys, &mut plan)
        .and_then(|()| stage_attachments(&store, &staging, &sealed.attachments, keys, &mut plan))
        .map(|()| staged(root))
        .and_then(|()| commit(root, &staging, &plan, key_json.as_bytes(), &mut stranded));
    if let Err(error) = result {
        // A rollback that could not finish keeps the staging directory and the
        // resealed chunks: they are the only copy of what did not make it back.
        if !stranded {
            for rel in &plan.new_objects {
                let _ = confined_remove(root, rel);
            }
            let _ = fs::remove_dir_all(&staging);
        }
        return Err(error);
    }

    // Committed: the new key file is live. What remains is cleanup: every pool
    // object no new manifest references is old-root ciphertext (or an orphan
    // no manifest ever will), and the lock rules out an attach in flight.
    let _ = fs::remove_dir_all(&staging);
    for (digest, rel) in store.object_files().unwrap_or_default() {
        if !plan.kept_objects.contains(&digest) {
            let _ = confined_remove(root, &rel);
        }
    }
    auto_commit(root, COMMIT_ROTATE)?;
    Ok(RotationOutcome {
        entries: plan.entries,
        attachments: plan.attachments,
        foreign_entries: plan.foreign_entries,
        root_epoch: prepared.manifest.root_epoch,
        reissued_recovery: prepared.reissued_recovery,
    })
}

#[derive(Default)]
struct Plan {
    /// Store-relative paths whose new ciphertext is staged as `new/<index>`.
    swaps: Vec<PathBuf>,
    /// Chunk objects this rotation wrote (removed again on failure).
    new_objects: Vec<PathBuf>,
    /// Chunk digests the new manifests reference.
    kept_objects: BTreeSet<String>,
    entries: usize,
    attachments: usize,
    foreign_entries: usize,
}

impl Plan {
    fn stage(&mut self, staging: &Path, rel: PathBuf, bytes: &[u8]) -> Result<(), StoreError> {
        let slot = Path::new("new").join(self.swaps.len().to_string());
        confined_write(staging, &slot, bytes)?;
        self.swaps.push(rel);
        Ok(())
    }
}

type Keys<'a> = (&'a ItemDataKey, &'a ItemDataKey);

fn stage_entries(
    store: &StoreRoot,
    staging: &Path,
    names: &BTreeSet<String>,
    (old_key, new_key): Keys<'_>,
    plan: &mut Plan,
) -> Result<(), StoreError> {
    let revisions = store.revisions()?;
    for name in names {
        let rel = StoreRoot::entry_relative(name, "osseal")?;
        let blob = confined_read(&store.path, &rel)?;
        let expected = revisions.get(name).copied();
        let mut opened = open_osseal(&blob, old_key, name, expected)?;
        // Keep the revision the reader will expect: the recorded one, or for a
        // legacy blob with no record, the first revision a rebind would give.
        let revision = if opened.legacy {
            expected.unwrap_or(1)
        } else {
            opened.revision
        };
        let sealed = seal_osseal(&opened.plaintext, new_key, name, revision);
        opened.plaintext.zeroize();
        plan.stage(staging, rel, &sealed?)?;
        plan.entries += 1;
    }
    Ok(())
}

fn stage_attachments(
    store: &StoreRoot,
    staging: &Path,
    names: &BTreeSet<String>,
    (old_key, new_key): Keys<'_>,
    plan: &mut Plan,
) -> Result<(), StoreError> {
    let revisions = store.attachment_revisions()?;
    for name in names {
        let mut manifest = store.open_manifest(name, old_key)?;
        let rel = attach_relative(name)?;
        let revision = match revisions.get(name) {
            Some(revision) => *revision,
            None => envelope_revision(&confined_read(&store.path, &rel)?)?,
        };
        let mut id = [0u8; 16];
        hex_to_bytes(&manifest.attachment_id, &mut id)?;
        let old_ak = derive_attachment_key(old_key, &id);
        let new_ak = derive_attachment_key(new_key, &id);
        for (index, chunk) in manifest.chunks.iter_mut().enumerate() {
            let object = object_relative(&chunk.digest)?;
            let frame = confined_read(&store.path, &object)?;
            if blake3::hash(&frame).to_hex().as_str() != chunk.digest.to_ascii_lowercase() {
                return Err(StoreError::Crypto(format!(
                    "attachment {name}: chunk {index} does not match its content address"
                )));
            }
            let ad = ChunkAd {
                envelope_version: ENVELOPE_VERSION,
                attachment_id: manifest.attachment_id.clone(),
                item_id: name.clone(),
                chunk_index: u32::try_from(index)
                    .map_err(|_| StoreError::Crypto("chunk index out of range".into()))?,
                chunk_count: manifest.chunk_count,
            };
            let mut plaintext =
                open_chunk(&old_ak, &frame, &ad).map_err(|e| StoreError::Crypto(e.to_string()))?;
            let resealed = seal_chunk(&new_ak, &plaintext, &ad);
            plaintext.zeroize();
            let resealed = resealed.map_err(|e| StoreError::Crypto(e.to_string()))?;
            let digest = blake3::hash(&resealed).to_hex().to_string();
            let new_object = object_relative(&digest)?;
            if !store.path.join(&new_object).exists() {
                confined_write(&store.path, &new_object, &resealed)?;
                plan.new_objects.push(new_object);
            }
            plan.kept_objects.insert(digest.clone());
            *chunk = ChunkRef {
                digest,
                ct_bytes: resealed.len() as u64,
                pt_bytes: chunk.pt_bytes,
            };
        }
        let json = serde_json::to_vec(&manifest)
            .map_err(|e| StoreError::Crypto(format!("manifest encode: {e}")))?;
        let sealed = seal_osseal_in(COLLECTION_ATTACHMENTS, &json, new_key, name, revision)?;
        plan.stage(staging, rel, &sealed)?;
        plan.attachments += 1;
    }
    Ok(())
}

fn commit(
    root: &Path,
    staging: &Path,
    plan: &Plan,
    key_json: &[u8],
    stranded: &mut bool,
) -> Result<(), StoreError> {
    let key_next = staging.join("key.next");
    write_synced(&key_next, key_json)?;
    let map: Vec<String> = plan
        .swaps
        .iter()
        .map(|rel| rel.to_string_lossy().into_owned())
        .collect();
    let map = serde_json::to_vec(&map).map_err(|e| StoreError::Other(e.to_string()))?;
    write_synced(&staging.join("plan.json"), &map)?;
    create_private_dir(&staging.join("old"))?;

    let result = swap_all(root, staging, plan).and_then(|()| {
        verify_nothing_left_behind(root, plan)?;
        fs::rename(&key_next, root.join(KEY_FILE_NAME))?;
        sync_dir(root);
        Ok(())
    });
    let Err(error) = result else {
        return Ok(());
    };
    // Undo every swap, last first; the old key file is still in place, so
    // putting the old ciphertext back returns the store to its previous state.
    for (index, rel) in plan.swaps.iter().enumerate().rev() {
        let backup = staging.join("old").join(index.to_string());
        if backup.exists() && fs::rename(&backup, root.join(rel)).is_err() {
            *stranded = true;
        }
    }
    if *stranded {
        return Err(StoreError::Other(format!(
            "rotation failed ({error}) and could not be fully rolled back; the previous \
             ciphertext is kept in {} (plan.json maps old/<n> to its path) and \
             .opensesame-key is unchanged",
            staging.display()
        )));
    }
    Err(error)
}

/// Fail closed if any root-sealed file in the tree was not re-encrypted: the
/// key swap would strand it under the old root.
fn verify_nothing_left_behind(root: &Path, plan: &Plan) -> Result<(), StoreError> {
    let swapped: BTreeSet<&PathBuf> = plan.swaps.iter().collect();
    let missed = inventory(root)?
        .relative_paths()
        .into_iter()
        .filter(|rel| !swapped.contains(rel))
        .count();
    if missed > 0 {
        return Err(StoreError::Crypto(format!(
            "{missed} sealed file(s) appeared that were not re-encrypted; the rotation was \
             rolled back so none of them is left under the old root"
        )));
    }
    Ok(())
}

fn swap_all(root: &Path, staging: &Path, plan: &Plan) -> Result<(), StoreError> {
    let mut parents = BTreeSet::new();
    for (index, rel) in plan.swaps.iter().enumerate() {
        refuse_symlinked_parents(root, rel)?;
        let target = root.join(rel);
        let slot = index.to_string();
        fs::rename(&target, staging.join("old").join(&slot))?;
        fs::rename(staging.join("new").join(&slot), &target)?;
        if let Some(parent) = target.parent() {
            parents.insert(parent.to_path_buf());
        }
    }
    for parent in parents {
        sync_dir(&parent);
    }
    Ok(())
}

/// `rename` follows directory symlinks in the parent path; the confined reads
/// that staged these files refused them, so refuse them here too.
fn refuse_symlinked_parents(root: &Path, rel: &Path) -> Result<(), StoreError> {
    let mut current = root.to_path_buf();
    for component in rel.parent().into_iter().flat_map(Path::components) {
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(StoreError::InvalidPath(
                "symlink inside the store during rotation".into(),
            ));
        }
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), StoreError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)?;
    Ok(())
}

#[cfg(test)]
#[path = "rotation_tests.rs"]
mod tests;
