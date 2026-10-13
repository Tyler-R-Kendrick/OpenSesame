use super::*;
use opensesame_human_vault::root_protection::init_versioned_key_file;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let physical = fs::canonicalize(temp.path()).unwrap();
    fs::set_permissions(&physical, fs::Permissions::from_mode(0o700)).unwrap();
    init_versioned_key_file(&physical, b"actual native scoped-root fixture").unwrap();
    (temp, physical)
}

#[test]
fn actual_native_current_file_and_os_lock_hold_until_original_scope_closes() {
    let (_temp, root) = fixture();
    let (mut current, actual) = ScopedStore::open(&root).unwrap();
    assert_eq!(actual, fs::read(root.join(KEY_FILE_NAME)).unwrap());
    current.validate().unwrap();
    assert!(crate::store_lock::StoreLock::exclusive(&root).is_err());
    assert!(crate::store_lock::StoreLock::shared(&root).is_err());
    drop(current);
    let ordinary = crate::store_lock::StoreLock::exclusive(&root).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    drop(ordinary);
    ScopedStore::open(&root).unwrap();
}

#[test]
fn symlink_hardlink_or_broad_current_file_never_becomes_original_private_read() {
    let (_temp, root) = fixture();
    let path = root.join(KEY_FILE_NAME);
    let original = fs::read(&path).unwrap();
    let held = root.join("held-keyfile");
    fs::rename(&path, &held).unwrap();
    symlink(&held, &path).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    fs::remove_file(&path).unwrap();
    fs::hard_link(&held, &path).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    fs::remove_file(&path).unwrap();
    fs::rename(&held, &path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
}

#[test]
fn actual_current_generation_replacement_or_inplace_change_invalidates_held_scope() {
    let (_temp, root) = fixture();
    let path = root.join(KEY_FILE_NAME);
    let (mut current, original) = ScopedStore::open(&root).unwrap();
    let next = root.join("next-keyfile");
    fs::write(&next, &original).unwrap();
    fs::set_permissions(&next, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(&next, &path).unwrap();
    assert!(current.validate().is_err());
    drop(current);
    let (mut current, _) = ScopedStore::open(&root).unwrap();
    fs::write(&path, b"changed current generation").unwrap();
    assert!(current.validate().is_err());
}

#[test]
fn replacing_root_path_or_lock_inode_refuses_origin_acknowledgment() {
    let (_temp, parent) = fixture();
    let root = parent.join("store");
    fs::create_dir(&root).unwrap();
    init_versioned_key_file(&root, b"actual native second scoped-root").unwrap();
    let (mut current, _) = ScopedStore::open(&root).unwrap();
    let moved = parent.join("moved");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(current.validate().is_err());
    drop(current);
    let (mut current, _) = ScopedStore::open(&moved).unwrap();
    let lock = moved.join(crate::store_lock::STORE_LOCK_FILE);
    fs::rename(&lock, moved.join("old-lock")).unwrap();
    fs::write(&lock, []).unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(current.validate().is_err());
}

#[test]
fn unsupported_root_or_lock_profiles_refuse_without_permission_repair() {
    let (_temp, root) = fixture();
    let alias = root.join("alias");
    symlink(&root, &alias).unwrap();
    assert!(ScopedStore::open(&alias).is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o777);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let lock = root.join(crate::store_lock::STORE_LOCK_FILE);
    fs::write(&lock, b"not a dedicated empty lock").unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    assert_eq!(fs::read(&lock).unwrap(), b"not a dedicated empty lock");
}

#[test]
fn staging_presence_and_oversized_current_file_refuse_before_native_authentication() {
    let (_temp, root) = fixture();
    let staging = root.join(crate::rotation::ROTATION_STAGING_DIR);
    fs::create_dir(&staging).unwrap();
    assert!(ScopedStore::open(&root).is_err());
    fs::remove_dir(&staging).unwrap();
    let path = root.join(KEY_FILE_NAME);
    let file = File::options().write(true).open(&path).unwrap();
    file.set_len(u64::try_from(MAX_MANIFEST_ENCODED_BYTES + 1).unwrap())
        .unwrap();
    assert!(ScopedStore::open(&root).is_err());
}
