use super::*;

fn temp_store(name: &str) -> (DriveStore, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "opensesame-vault-drive-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    (DriveStore::new(dir.clone()), dir)
}

#[test]
fn a_new_slot_is_empty_and_keeps_only_a_digest_of_its_key() {
    let (store, dir) = temp_store("new");
    let (view, key) = store.create("Phone").unwrap();
    assert_eq!(view.generation, 0);
    assert!(valid_slot(&view.slot));
    assert_eq!(key.len(), 43);
    assert_eq!(store.read(&view.slot, &key).unwrap(), (0, None));
    let meta = fs::read_to_string(dir.join(format!("{}.meta.json", view.slot))).unwrap();
    assert!(!meta.contains(&key), "the key itself must never be stored");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn writes_compare_and_set_on_the_generation() {
    let (store, dir) = temp_store("cas");
    let (view, key) = store.create("Laptop").unwrap();
    assert_eq!(store.write(&view.slot, &key, 0, b"{\"a\":1}").unwrap(), 1);
    assert!(matches!(
        store.write(&view.slot, &key, 0, b"{\"a\":2}"),
        Err(DriveError::Conflict(1))
    ));
    assert_eq!(store.write(&view.slot, &key, 1, b"{\"a\":3}").unwrap(), 2);
    let (generation, bytes) = store.read(&view.slot, &key).unwrap();
    assert_eq!(generation, 2);
    assert_eq!(bytes.as_deref(), Some(&b"{\"a\":3}"[..]));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_wrong_key_and_an_unknown_slot_look_the_same() {
    let (store, dir) = temp_store("auth");
    let (view, _key) = store.create("x").unwrap();
    let wrong = "w".repeat(43);
    assert!(matches!(
        store.read(&view.slot, &wrong),
        Err(DriveError::Unauthorized)
    ));
    assert!(matches!(
        store.read("00000000-0000-4000-8000-000000000000", &wrong),
        Err(DriveError::Unauthorized)
    ));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_path_is_never_a_slot() {
    assert!(!valid_slot("../../etc/passwd"));
    assert!(!valid_slot("slot/../x"));
    assert!(!valid_slot("-leading-dash"));
    assert!(!valid_slot("SHORT"));
    let (store, dir) = temp_store("path");
    assert!(matches!(
        store.read("../escape-attempt", &"k".repeat(43)),
        Err(DriveError::Unauthorized)
    ));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn oversized_snapshots_are_refused_before_anything_is_written() {
    let (store, dir) = temp_store("big");
    let (view, key) = store.create("x").unwrap();
    let big = vec![b' '; MAX_SNAPSHOT_BYTES + 1];
    assert!(matches!(
        store.write(&view.slot, &key, 0, &big),
        Err(DriveError::TooLarge)
    ));
    assert_eq!(store.read(&view.slot, &key).unwrap(), (0, None));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn listing_and_removing_never_expose_keys() {
    let (store, dir) = temp_store("list");
    let (view, key) = store.create("  Desk  ").unwrap();
    store.write(&view.slot, &key, 0, b"{}").unwrap();
    let listed = store.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].label, "Desk");
    assert_eq!(listed[0].bytes, 2);
    assert!(!serde_json::to_string(&listed).unwrap().contains(&key));
    assert!(store.remove(&view.slot).unwrap());
    assert!(!store.remove(&view.slot).unwrap());
    assert!(matches!(
        store.read(&view.slot, &key),
        Err(DriveError::Unauthorized)
    ));
    let _ = fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn files_are_private_to_this_user() {
    use std::os::unix::fs::PermissionsExt as _;
    let (store, dir) = temp_store("perm");
    let (view, key) = store.create("x").unwrap();
    store.write(&view.slot, &key, 0, b"{}").unwrap();
    let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(dir.clone()), 0o700);
    assert_eq!(
        mode(dir.join(format!("{}.1.snapshot.json", view.slot))),
        0o600
    );
    assert_eq!(mode(dir.join(format!("{}.meta.json", view.slot))), 0o600);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_write_that_never_reached_its_metadata_is_invisible_and_overwritten() {
    let (store, dir) = temp_store("crash");
    let (view, key) = store.create("x").unwrap();
    store.write(&view.slot, &key, 0, b"{\"first\":1}").unwrap();
    // A crash after the next generation's file landed but before the metadata
    // naming it did: readers must still get generation 1, whole.
    fs::write(dir.join(format!("{}.2.snapshot.json", view.slot)), b"torn").unwrap();
    assert_eq!(
        store.read(&view.slot, &key).unwrap(),
        (1, Some(b"{\"first\":1}".to_vec()))
    );
    assert_eq!(
        store.write(&view.slot, &key, 1, b"{\"second\":2}").unwrap(),
        2
    );
    assert_eq!(
        store.read(&view.slot, &key).unwrap(),
        (2, Some(b"{\"second\":2}".to_vec()))
    );
    // The superseded generation's file is gone; only the live one remains.
    assert!(!dir.join(format!("{}.1.snapshot.json", view.slot)).exists());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn concurrent_creates_never_open_more_than_max_slots() {
    let (store, dir) = temp_store("full");
    for _ in 0..MAX_SLOTS - 1 {
        store.create("x").unwrap();
    }
    let opened = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| store.create("race").is_ok()))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|ok| *ok)
            .count()
    });
    assert_eq!(opened, 1);
    assert_eq!(store.list().unwrap().len(), MAX_SLOTS);
    let _ = fs::remove_dir_all(dir);
}
