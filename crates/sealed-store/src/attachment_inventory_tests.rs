//! Listing, garbage collection and replication read the same manifest set the
//! rotation does. A dot-named attachment (`Dev/.w2`) is legal; a walker that
//! hid it would let GC reclaim its chunks and keep it out of every replica.

use super::*;
use crate::store::{init_store, init_store_key};
use tempfile::TempDir;

fn store() -> (TempDir, StoreRoot, ItemDataKey) {
    let dir = TempDir::new().expect("tempdir");
    let root = init_store(dir.path(), &[]).expect("init");
    let key = init_store_key(dir.path(), b"correct horse").expect("key");
    (dir, root, key)
}

fn add(root: &StoreRoot, key: &ItemDataKey, name: &str, bytes: &[u8]) {
    let mut source = std::io::Cursor::new(bytes.to_vec());
    root.attach_add(
        name,
        &mut source,
        u64::try_from(bytes.len()).expect("fixture length fits u64"),
        AttachMeta {
            filename: "w2.pdf".into(),
            mime: None,
        },
        key,
        false,
    )
    .expect("attach_add");
}

fn get(root: &StoreRoot, key: &ItemDataKey, name: &str) -> Vec<u8> {
    let mut sink: Vec<u8> = Vec::new();
    root.attach_get(name, &mut sink, key).expect("attach_get");
    sink
}

/// Age every chunk in the pool past the GC grace window.
fn backdate_every_chunk(root: &StoreRoot) {
    let aged = SystemTime::now() - std::time::Duration::from_secs(GC_GRACE_SECONDS + 60);
    for (_, rel) in root.object_files().unwrap() {
        std::fs::File::options()
            .write(true)
            .open(root.path.join(rel))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(aged))
            .unwrap();
    }
}

#[test]
fn gc_keeps_every_chunk_of_a_dot_named_attachment() {
    let (_dir, root, key) = store();
    add(&root, &key, "Dev/.w2", b"dot-named document");
    add(&root, &key, ".hidden/scan", b"dot-named directory");
    let chunks = root.object_files().unwrap().len();
    assert!(chunks >= 2, "each attachment wrote a chunk");
    backdate_every_chunk(&root);

    let outcome = root.attach_gc(&key).unwrap();
    assert_eq!(outcome.removed, 0, "referenced chunks are never orphans");
    assert_eq!(outcome.kept, chunks);
    assert_eq!(get(&root, &key, "Dev/.w2"), b"dot-named document".to_vec());
    assert_eq!(
        get(&root, &key, ".hidden/scan"),
        b"dot-named directory".to_vec()
    );
}

#[test]
fn listing_names_what_rotation_rotates() {
    let (_dir, root, key) = store();
    add(&root, &key, "Dev/.w2", b"one");
    add(&root, &key, "Taxes/w2", b"two");
    let listed: Vec<_> = root
        .attach_ls(None, &key)
        .unwrap()
        .into_iter()
        .map(|summary| summary.name)
        .collect();
    let rotated: Vec<_> = crate::rotation_walk::inventory(&root.path)
        .unwrap()
        .attachments
        .into_iter()
        .collect();
    assert_eq!(listed, ["Dev/.w2", "Taxes/w2"]);
    assert_eq!(listed, rotated);
}

#[test]
fn replication_carries_a_dot_named_attachment() {
    let (_dir, root, key) = store();
    add(&root, &key, "Dev/.w2", b"dot-named document");
    let units = root.attach_replication_units().unwrap();
    let manifest = attach_relative("Dev/.w2").unwrap();
    assert!(
        units
            .iter()
            .any(|(rel, abs)| Path::new(rel) == manifest && abs.is_file()),
        "the manifest must be replicated: {units:?}"
    );
    for (_, chunk) in root.object_files().unwrap() {
        assert!(
            units.iter().any(|(rel, _)| Path::new(rel) == chunk),
            "chunk {} must be replicated",
            chunk.display()
        );
    }
}

#[cfg(unix)]
#[test]
fn gc_deletes_nothing_when_the_inventory_cannot_be_taken() {
    let (dir, root, key) = store();
    add(&root, &key, "Dev/.w2", b"dot-named document");
    let orphan = object_relative(&"cd".repeat(32)).unwrap();
    confined_write(&root.path, &orphan, b"orphaned ciphertext").unwrap();
    backdate_every_chunk(&root);
    let before = root.object_files().unwrap().len();

    // A symlink could hide a manifest the walk cannot vouch for.
    let outside = TempDir::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("Linked")).unwrap();

    assert!(root.attach_gc(&key).is_err());
    assert_eq!(root.object_files().unwrap().len(), before);
    assert!(root.path.join(&orphan).exists(), "not even the orphan goes");
}

#[test]
fn a_trailing_slash_name_is_refused_before_it_writes_a_stemless_file() {
    let (dir, root, key) = store();
    let mut source = std::io::Cursor::new(b"scan".to_vec());
    let refused = root.attach_add(
        "Scans/",
        &mut source,
        4,
        AttachMeta {
            filename: "scan.pdf".into(),
            mime: None,
        },
        &key,
        false,
    );
    assert!(refused.is_err());
    assert!(!dir.path().join("Scans/.osattach").exists());
}
