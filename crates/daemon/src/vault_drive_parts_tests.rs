use super::*;
use std::path::PathBuf;

fn temp_store(name: &str) -> (DriveStore, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "opensesame-vault-drive-parts-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    (DriveStore::new(dir.clone()), dir)
}

const PART: &str = "AbCdEfGhIjKl-_09";

#[test]
fn a_part_is_kept_read_back_and_listed() {
    let (store, dir) = temp_store("round");
    let (view, key) = store.create("Laptop").unwrap();
    assert_eq!(store.get_part(&view.slot, &key, PART).unwrap(), None);
    store
        .put_part(&view.slot, &key, PART, b"ciphertext")
        .unwrap();
    assert_eq!(
        store.get_part(&view.slot, &key, PART).unwrap().as_deref(),
        Some(&b"ciphertext"[..])
    );
    assert_eq!(store.list_parts(&view.slot, &key).unwrap(), vec![PART]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_part_is_never_replaced() {
    let (store, dir) = temp_store("immutable");
    let (view, key) = store.create("Laptop").unwrap();
    store.put_part(&view.slot, &key, PART, b"first").unwrap();
    store.put_part(&view.slot, &key, PART, b"second").unwrap();
    assert_eq!(
        store.get_part(&view.slot, &key, PART).unwrap().as_deref(),
        Some(&b"first"[..])
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_slot_key_is_required_and_part_keys_are_checked() {
    let (store, dir) = temp_store("auth");
    let (view, key) = store.create("Laptop").unwrap();
    assert!(matches!(
        store.put_part(
            &view.slot,
            "wrong-key-wrong-key-wrong-key-wrong",
            PART,
            b"x"
        ),
        Err(DriveError::Unauthorized)
    ));
    assert!(matches!(
        store.list_parts(&view.slot, "wrong-key-wrong-key-wrong-key-wrong"),
        Err(DriveError::Unauthorized)
    ));
    for bad in [
        "../../etc/passwd",
        "short",
        "AbCdEfGhIjKl/_09",
        "AbCdEfGhIjKl.-09",
    ] {
        assert!(matches!(
            store.put_part(&view.slot, &key, bad, b"x"),
            Err(DriveError::Invalid("bad_part_key"))
        ));
        assert!(matches!(
            store.get_part(&view.slot, &key, bad),
            Err(DriveError::Invalid("bad_part_key"))
        ));
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn sizes_are_bounded() {
    let (store, dir) = temp_store("size");
    let (view, key) = store.create("Laptop").unwrap();
    assert!(matches!(
        store.put_part(&view.slot, &key, PART, &vec![0; MAX_PART_BYTES + 1]),
        Err(DriveError::TooLarge)
    ));
    assert!(matches!(
        store.put_part(&view.slot, &key, PART, b""),
        Err(DriveError::TooLarge)
    ));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn closing_the_slot_removes_its_parts() {
    let (store, dir) = temp_store("close");
    let (view, key) = store.create("Laptop").unwrap();
    store
        .put_part(&view.slot, &key, PART, b"ciphertext")
        .unwrap();
    assert!(store.parts_dir(&view.slot).exists());
    assert!(store.remove(&view.slot).unwrap());
    assert!(!store.parts_dir(&view.slot).exists());
    let _ = fs::remove_dir_all(dir);
}
