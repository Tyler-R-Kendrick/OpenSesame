use super::*;
use tempfile::TempDir;

fn fixture() -> (TempDir, PathBuf) {
    let temp = tempfile::tempdir().expect("temporary NTFS directory");
    let root = temp.path().join("private-vault");
    windows_private::create_directory(&root).expect("owner-only vault directory");
    (temp, root)
}
#[test]
fn bounded_io_and_exact_handle_deletion() {
    let (_temp, root) = fixture();
    write(&root, Path::new("config/data"), b"sealed ciphertext").unwrap();
    assert_eq!(
        read_bounded(&root, Path::new("config/data"), 32).unwrap(),
        b"sealed ciphertext"
    );
    assert!(read_bounded(&root, Path::new("config/data"), 4).is_err());
    remove(&root, Path::new("config/data")).unwrap();
    assert!(!root.join("config/data").exists());
}
#[test]
fn empty_directory_pins_exclude_delete_handles_until_drop() {
    let (_temp, root) = fixture();
    let open_delete = || {
        windows_private::create_file(
            &root,
            DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL,
            SHARING,
            OPEN_EXISTING,
            ATTRIBUTES,
        )
    };
    // The owner can acquire DELETE access when no operation holds a pin.
    drop(open_delete().unwrap());
    let pin = PinnedParent::open(&root, Path::new("not-created.json"), false).unwrap();
    assert_eq!(
        open_delete().unwrap_err().raw_os_error().map(u32::try_from),
        Some(Ok(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION))
    );
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    drop(pin);
    drop(open_delete().unwrap());
}
#[test]
fn locks_are_nonblocking_and_preserve_ancestor_pins() {
    let (_temp, root) = fixture();
    let first = lock(&root, Path::new("operation.lock"), true).unwrap();
    let busy = lock(&root, Path::new("operation.lock"), true)
        .err()
        .expect("exclusive lock contention");
    assert_eq!(busy.kind(), io::ErrorKind::WouldBlock);
    assert!(lock(&root, Path::new("operation.lock"), false).is_err());
    assert!(std::fs::rename(&root, root.with_file_name("moved-vault")).is_err());
    drop(first);
    let shared_a = lock(&root, Path::new("operation.lock"), false).unwrap();
    let shared_b = lock(&root, Path::new("operation.lock"), false).unwrap();
    assert!(lock(&root, Path::new("operation.lock"), true).is_err());
    drop((shared_a, shared_b));
    assert!(lock(&root, Path::new("operation.lock"), true).is_ok());
}
#[test]
fn hardlinked_final_files_fail_closed_for_every_operation() {
    let (_temp, root) = fixture();
    write(&root, Path::new("sealed"), b"ciphertext").unwrap();
    std::fs::hard_link(root.join("sealed"), root.join("alias")).unwrap();
    assert!(read_bounded(&root, Path::new("sealed"), 32).is_err());
    assert!(write(&root, Path::new("sealed"), b"replacement").is_err());
    assert!(remove(&root, Path::new("sealed")).is_err());
    assert!(lock(&root, Path::new("sealed"), true).is_err());
    assert_eq!(std::fs::read(root.join("sealed")).unwrap(), b"ciphertext");
}
#[test]
fn junction_parent_never_reaches_external_file() {
    let (temp, root) = fixture();
    let external = temp.path().join("external");
    windows_private::create_directory(&external).unwrap();
    std::fs::write(external.join("secret"), b"outside").unwrap();
    let status = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(root.join("junction"))
        .arg(&external)
        .status()
        .expect("Windows junction creation");
    assert!(
        status.success(),
        "hosted Windows tests require junction creation"
    );
    assert!(read_bounded(&root, Path::new("junction/secret"), 32).is_err());
    assert!(write(&root, Path::new("junction/secret"), b"replacement").is_err());
    assert!(remove(&root, Path::new("junction/secret")).is_err());
    assert_eq!(std::fs::read(external.join("secret")).unwrap(), b"outside");
    std::fs::remove_dir(root.join("junction")).unwrap();
}

fn allow_world_listing(path: &Path) {
    let output = std::process::Command::new("icacls.exe")
        .arg(path)
        .args(["/grant", "*S-1-1-0:(RX)"])
        .output()
        .expect("actual Windows ACL mutation");
    assert!(
        output.status.success(),
        "Windows ACL fixture creation failed"
    );
}
#[test]
fn world_readable_vault_root_is_refused_before_private_file_access() {
    let (_temp, root) = fixture();
    write(&root, Path::new("config/data"), b"ciphertext").unwrap();
    allow_world_listing(&root);
    assert_eq!(
        read_bounded(&root, Path::new("config/data"), 32)
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(write(&root, Path::new("config/data"), b"replacement").is_err());
    assert!(lock(&root, Path::new("operation.lock"), true).is_err());
    assert_eq!(
        std::fs::read(root.join("config/data")).unwrap(),
        b"ciphertext"
    );
}
#[test]
fn world_readable_descendant_is_refused_without_widening_private_file_permissions() {
    let (_temp, root) = fixture();
    write(&root, Path::new("config/data"), b"ciphertext").unwrap();
    allow_world_listing(&root.join("config"));
    assert_eq!(
        read_bounded(&root, Path::new("config/data"), 32)
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(remove(&root, Path::new("config/data")).is_err());
    assert!(write(&root, Path::new("config/new"), b"new ciphertext").is_err());
    assert!(!root.join("config/new").exists());
}
#[test]
fn ordinary_readable_os_ancestor_does_not_block_private_vault_access() {
    let (temp, root) = fixture();
    allow_world_listing(temp.path());
    write(&root, Path::new("config/data"), b"ciphertext").unwrap();
    assert_eq!(
        read_bounded(&root, Path::new("config/data"), 32).unwrap(),
        b"ciphertext"
    );
    assert!(lock(&root, Path::new("operation.lock"), true).is_ok());
}
