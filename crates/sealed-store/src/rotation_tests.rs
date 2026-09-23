use std::fs;
use std::path::{Path, PathBuf};

use age::secrecy::ExposeSecret;
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::{
    load_key_file, protect_test_recovery, unwrap_vrk_with_recovery_key, KeyFileContents,
    ProtectionRecord,
};

use super::*;
use crate::store::{init_store, init_store_key, unlock_store_key};
use crate::{protect_add_store_age_recipient, protect_add_store_recovery, AttachMeta, Entry};

const PW: &[u8] = b"correct horse";
const BIG: usize = crate::CHUNK_PLAINTEXT_BYTES + 17;

fn entry(secret: &str) -> Entry {
    Entry {
        secret: secret.into(),
        trailer: String::new(),
        otp: None,
    }
}

fn payload() -> Vec<u8> {
    (0..BIG).map(|i| u8::try_from(i % 251).unwrap()).collect()
}

/// A store with one entry and one two-chunk attachment under `PW`.
fn seeded() -> (tempfile::TempDir, StoreRoot, ItemDataKey) {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), PW).unwrap();
    store.insert("Dev/token", &entry("hunter2"), &key).unwrap();
    let bytes = payload();
    store
        .attach_add(
            "Taxes/2025",
            &mut std::io::Cursor::new(bytes),
            BIG as u64,
            AttachMeta {
                filename: "w2.pdf".into(),
                mime: None,
            },
            &key,
            false,
        )
        .unwrap();
    (dir, store, key)
}

fn read_attachment(store: &StoreRoot, key: &ItemDataKey) -> Result<Vec<u8>, StoreError> {
    let mut sink = Vec::new();
    store.attach_get("Taxes/2025", &mut sink, key)?;
    Ok(sink)
}

fn objects(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let pool = root.join(".attachments/objects");
    for shard in fs::read_dir(pool).unwrap() {
        for object in fs::read_dir(shard.unwrap().path()).unwrap() {
            out.push(object.unwrap().path());
        }
    }
    out.sort();
    out
}

/// Open an old key file copy (as git history would hold it) with `password`.
fn key_from_copy(key_file: &[u8], password: &[u8]) -> ItemDataKey {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(KEY_FILE_NAME), key_file).unwrap();
    unlock_store_key(dir.path(), password).unwrap()
}

#[test]
fn rotation_reencrypts_entries_and_attachments_under_the_new_root() {
    let (dir, store, old_key) = seeded();
    let old_file = fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();
    let old_objects = objects(dir.path());

    let outcome = rotate_store_root(dir.path(), PW, RotationEdit::default()).unwrap();
    assert_eq!((outcome.entries, outcome.attachments), (1, 1));
    assert_eq!(outcome.root_epoch, 2);

    let new_key = unlock_store_key(dir.path(), PW).unwrap();
    assert_ne!(new_key.0, old_key.0);
    assert_eq!(store.show("Dev/token", &new_key).unwrap().secret, "hunter2");
    assert_eq!(read_attachment(&store, &new_key).unwrap(), payload());

    // The old root — and the old key file as history keeps it — opens none of it.
    let historic = key_from_copy(&old_file, PW);
    assert_eq!(historic.0, old_key.0);
    assert!(store.show("Dev/token", &old_key).is_err());
    assert!(read_attachment(&store, &old_key).is_err());

    // Old chunk ciphertext is gone from the pool; nothing staged is left behind.
    let new_objects = objects(dir.path());
    assert_eq!(new_objects.len(), old_objects.len());
    assert!(new_objects.iter().all(|o| !old_objects.contains(o)));
    assert!(!dir.path().join(ROTATION_STAGING_DIR).exists());
}

#[test]
fn rotating_rewrap_revokes_the_old_passphrase_and_old_key_file() {
    let (dir, store, _) = seeded();
    let old_file = fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();
    let edit = RotationEdit {
        new_password: Some(b"new passphrase"),
        ..RotationEdit::default()
    };
    rotate_store_root(dir.path(), PW, edit).unwrap();

    assert!(unlock_store_key(dir.path(), PW).is_err());
    let key = unlock_store_key(dir.path(), b"new passphrase").unwrap();
    assert_eq!(store.show("Dev/token", &key).unwrap().secret, "hunter2");
    store.insert("Dev/later", &entry("after"), &key).unwrap();

    let leaked = key_from_copy(&old_file, PW);
    assert!(store.show("Dev/token", &leaked).is_err());
    assert!(store.show("Dev/later", &leaked).is_err());
    assert!(read_attachment(&store, &leaked).is_err());
}

#[test]
fn rotating_remove_revokes_a_removed_recovery_key() {
    let (dir, store, _) = seeded();
    let (secret, _) = protect_add_store_recovery(dir.path(), PW).unwrap();
    let KeyFileContents::Manifest(before) = load_key_file(dir.path()).unwrap() else {
        panic!("versioned manifest expected");
    };
    let (id, old_wrap) = before
        .records
        .iter()
        .find_map(|r| match r {
            ProtectionRecord::RecoveryKey {
                protector_id, wrap, ..
            } => Some((protector_id.clone(), wrap.clone())),
            _ => None,
        })
        .unwrap();

    let edit = RotationEdit {
        remove_protector: Some(&id),
        ..RotationEdit::default()
    };
    rotate_store_root(dir.path(), PW, edit).unwrap();
    assert!(protect_test_recovery(dir.path(), &secret).is_err());

    // The removed wrap, as history keeps it, yields a root that opens nothing.
    let old_root = unwrap_vrk_with_recovery_key(&secret, &old_wrap).unwrap();
    let leaked = ItemDataKey(old_root.0);
    let key = unlock_store_key(dir.path(), PW).unwrap();
    store.insert("Dev/later", &entry("after"), &key).unwrap();
    assert!(store.show("Dev/token", &leaked).is_err());
    assert!(store.show("Dev/later", &leaked).is_err());
}

#[test]
fn a_recovery_key_is_reissued_only_with_consent() {
    let (dir, store, old_key) = seeded();
    let (secret, _) = protect_add_store_recovery(dir.path(), PW).unwrap();
    let before = fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();

    assert!(rotate_store_root(dir.path(), PW, RotationEdit::default()).is_err());
    assert_eq!(fs::read(dir.path().join(KEY_FILE_NAME)).unwrap(), before);
    assert_eq!(store.show("Dev/token", &old_key).unwrap().secret, "hunter2");

    let edit = RotationEdit {
        reissue_recovery: true,
        ..RotationEdit::default()
    };
    let outcome = rotate_store_root(dir.path(), PW, edit).unwrap();
    assert_eq!(outcome.reissued_recovery.len(), 1);
    assert!(protect_test_recovery(dir.path(), &secret).is_err());
    protect_test_recovery(dir.path(), &outcome.reissued_recovery[0].secret).unwrap();
}

#[test]
fn an_age_capsule_follows_the_new_root() {
    let (dir, _, _) = seeded();
    let identity = age::x25519::Identity::generate();
    let recipient = identity.to_public().to_string();
    protect_add_store_age_recipient(dir.path(), PW, &[recipient]).unwrap();

    rotate_store_root(dir.path(), PW, RotationEdit::default()).unwrap();
    let key = unlock_store_key(dir.path(), PW).unwrap();
    let KeyFileContents::Manifest(manifest) = load_key_file(dir.path()).unwrap() else {
        panic!("versioned manifest expected");
    };
    let capsule = manifest
        .records
        .iter()
        .find_map(|r| match r {
            ProtectionRecord::AgeRecipient {
                capsule_age_b64, ..
            } => Some(capsule_age_b64),
            _ => None,
        })
        .unwrap();
    let sealed = STANDARD.decode(capsule).unwrap();
    let opened =
        crate::age_fmt::decrypt_age(&sealed, identity.to_string().expose_secret()).unwrap();
    assert_eq!(opened, key.0);
}

#[test]
fn a_failure_while_staging_leaves_the_store_untouched() {
    let (dir, store, old_key) = seeded();
    store.insert("Dev/other", &entry("kept"), &old_key).unwrap();
    // An attachment manifest that will not open stops the rotation after the
    // entries are staged and the good attachment's chunks are resealed.
    fs::create_dir(dir.path().join("Zz")).unwrap();
    fs::write(dir.path().join("Zz/broken.osattach"), b"not an envelope").unwrap();
    let key_before = fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();
    let objects_before = objects(dir.path());

    assert!(rotate_store_root(dir.path(), PW, RotationEdit::default()).is_err());
    assert_eq!(
        fs::read(dir.path().join(KEY_FILE_NAME)).unwrap(),
        key_before
    );
    assert_eq!(objects(dir.path()), objects_before);
    assert!(!dir.path().join(ROTATION_STAGING_DIR).exists());
    assert_eq!(store.show("Dev/token", &old_key).unwrap().secret, "hunter2");
    assert_eq!(store.show("Dev/other", &old_key).unwrap().secret, "kept");
    assert_eq!(read_attachment(&store, &old_key).unwrap(), payload());
}

#[test]
fn a_leftover_staging_directory_blocks_a_new_rotation() {
    let (dir, store, old_key) = seeded();
    fs::create_dir(dir.path().join(ROTATION_STAGING_DIR)).unwrap();
    assert!(rotate_store_root(dir.path(), PW, RotationEdit::default()).is_err());
    assert_eq!(store.show("Dev/token", &old_key).unwrap().secret, "hunter2");
}
