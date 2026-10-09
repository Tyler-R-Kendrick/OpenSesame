//! Actual LockFileEx and filesystem controls, not a simulated lock or clock.
use super::*;
use crate::root_protection::windows_private_files::write_new;
use std::fs;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Arc<PrivateDirectory>) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("actual-private-os-lock-root");
    let directory = Arc::new(PrivateDirectory::create_directories(&root).unwrap());
    (temporary, root, directory)
}

#[test]
fn original_exclusive_lock_really_contends_and_drop_releases_without_lock_file_deletion() {
    let (_temporary, root, directory) = fixture();
    let first = HeldPrivateStoreLock::exclusive(Arc::clone(&directory)).unwrap();
    let error = HeldPrivateStoreLock::exclusive(Arc::clone(&directory))
        .err()
        .unwrap();
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
    first.validate().unwrap();
    assert!(fs::rename(root.join(NAME), root.join("swapped-lock")).is_err());
    drop(first);
    assert!(root.join(NAME).exists());
    HeldPrivateStoreLock::exclusive(directory)
        .unwrap()
        .validate()
        .unwrap();
}

#[test]
fn actual_shared_kernel_holder_blocks_private_exclusive_and_vice_versa() {
    let (_temporary, _root, directory) = fixture();
    write_new(&directory, Path::new(NAME), b"").unwrap();
    let shared = open(&directory).unwrap();
    let mut overlapped = OVERLAPPED::default();
    // SAFETY: this test owns the actual synchronous File and offset-zero output structure.
    assert_ne!(
        unsafe {
            LockFileEx(
                shared.as_raw_handle(),
                LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        },
        0
    );
    assert_eq!(
        HeldPrivateStoreLock::exclusive(Arc::clone(&directory))
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    drop(shared);
    let exclusive = HeldPrivateStoreLock::exclusive(Arc::clone(&directory)).unwrap();
    let shared = open(&directory).unwrap();
    // SAFETY: actual independent retained handle requests the same byte range.
    assert_eq!(
        unsafe {
            LockFileEx(
                shared.as_raw_handle(),
                LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        },
        0
    );
    assert_eq!(
        u32::try_from(io::Error::last_os_error().raw_os_error().unwrap()).unwrap(),
        ERROR_LOCK_VIOLATION
    );
    drop(exclusive);
    drop(shared);
    HeldPrivateStoreLock::exclusive(directory).unwrap();
}

#[test]
fn inherited_or_nonempty_or_hardlinked_lock_is_refused_without_repair() {
    for kind in ["inherited", "nonempty", "hardlinked"] {
        let (_temporary, root, directory) = fixture();
        match kind {
            "inherited" => fs::write(root.join(NAME), b"").unwrap(),
            "nonempty" => write_new(&directory, Path::new(NAME), b"not an empty lock").unwrap(),
            _ => {
                write_new(&directory, Path::new(NAME), b"").unwrap();
                fs::hard_link(root.join(NAME), root.join("another-lock-name")).unwrap();
            }
        }
        let before = fs::read(root.join(NAME)).unwrap();
        assert!(HeldPrivateStoreLock::exclusive(directory).is_err());
        assert_eq!(fs::read(root.join(NAME)).unwrap(), before);
    }
}

#[test]
fn actual_rotation_fence_before_and_after_acquisition_refuses_and_root_stays_retained() {
    let (temporary, root, directory) = fixture();
    fs::create_dir(root.join(ROTATION)).unwrap();
    assert!(HeldPrivateStoreLock::exclusive(Arc::clone(&directory)).is_err());
    assert!(!root.join(NAME).exists());
    fs::remove_dir(root.join(ROTATION)).unwrap();
    let held = HeldPrivateStoreLock::exclusive(directory).unwrap();
    assert!(fs::rename(&root, temporary.path().join("swapped-original-root")).is_err());
    fs::create_dir(root.join(ROTATION)).unwrap();
    assert!(held.validate().is_err());
    drop(held);
    fs::remove_dir(root.join(ROTATION)).unwrap();
    let directory = Arc::new(PrivateDirectory::open(&root).unwrap());
    HeldPrivateStoreLock::exclusive(directory).unwrap();
}
