//! Actual Windows process, ACL and publication contracts; never run as Unix stubs.
#![cfg(windows)]
use opensesame_human_vault::{windows_io, windows_publish};
use std::{path::Path, process::Command};

fn grant(path: &Path, permission: &str) {
    let output = Command::new("icacls.exe")
        .arg(path)
        .arg("/grant")
        .arg(permission)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "icacls rejected private test fixture"
    );
}

#[test]
fn other_principal_read_grants_refuse_private_files_without_replacing_them() {
    let dir = tempfile::tempdir().unwrap();
    let name = Path::new("records.json");
    windows_publish::atomic_write(dir.path(), name, b"private records").unwrap();
    grant(&dir.path().join(name), "*S-1-1-0:R");
    assert!(windows_io::read_bounded(dir.path(), name, 64).is_err());
    assert!(windows_io::write(dir.path(), name, b"unexpected replacement").is_err());
    assert!(windows_io::remove(dir.path(), name).is_err());
    assert!(windows_publish::atomic_write(dir.path(), name, b"replacement").is_err());
    assert_eq!(
        std::fs::read(dir.path().join(name)).unwrap(),
        b"private records"
    );
}

#[test]
fn publication_refuses_hardlinked_and_reparse_destinations() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    windows_publish::atomic_write(dir.path(), Path::new("original"), b"original bytes").unwrap();
    std::fs::hard_link(dir.path().join("original"), dir.path().join("linked")).unwrap();
    assert!(
        windows_publish::atomic_write(dir.path(), Path::new("linked"), b"replacement").is_err()
    );
    assert_eq!(
        std::fs::read(dir.path().join("original")).unwrap(),
        b"original bytes"
    );
    let alias = dir.path().join("junction");
    assert!(Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&alias)
        .arg(outside.path())
        .status()
        .unwrap()
        .success());
    assert!(
        windows_publish::atomic_write(dir.path(), Path::new("junction"), b"replacement").is_err()
    );
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[test]
fn other_principal_directory_modification_grants_refuse_all_common_operations() {
    let dir = tempfile::tempdir().unwrap();
    windows_publish::atomic_write(dir.path(), Path::new("records.json"), b"private records")
        .unwrap();
    grant(dir.path(), "*S-1-1-0:(OI)(CI)M");
    assert!(windows_io::read_bounded(dir.path(), Path::new("records.json"), 64).is_err());
    assert!(
        windows_publish::atomic_write(dir.path(), Path::new("records.json"), b"replacement")
            .is_err()
    );
    assert!(windows_io::remove(dir.path(), Path::new("records.json")).is_err());
    assert!(windows_io::lock(dir.path(), Path::new(".lock"), true).is_err());
    assert_eq!(
        std::fs::read(dir.path().join("records.json")).unwrap(),
        b"private records"
    );
}

#[test]
fn locks_exclude_other_processes_and_process_exit_releases_them() {
    const ROOT: &str = "OPENSESAME_TEST_WINDOWS_LOCK_ROOT";
    const MODE: &str = "OPENSESAME_TEST_WINDOWS_LOCK_MODE";
    if let Some(root) = std::env::var_os(ROOT) {
        let result = windows_io::lock(Path::new(&root), Path::new(".lock"), true);
        match std::env::var(MODE).unwrap().as_str() {
            "busy" => assert!(result.is_err()),
            "exit" => {
                let _held = result.unwrap();
                std::process::exit(23);
            }
            "available" => {
                let _held = result.unwrap();
            }
            _ => panic!("unknown fixture mode"),
        }
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let child = |mode: &str| {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "locks_exclude_other_processes_and_process_exit_releases_them",
                "--nocapture",
            ])
            .env(ROOT, dir.path())
            .env(MODE, mode)
            .output()
            .unwrap()
    };
    let held = windows_io::lock(dir.path(), Path::new(".lock"), false).unwrap();
    assert!(child("busy").status.success());
    drop(held);
    assert_eq!(child("exit").status.code(), Some(23));
    assert!(child("available").status.success());
}

#[test]
fn pinned_parent_blocks_junction_replacement_and_root_rename_races() {
    let dir = tempfile::tempdir().unwrap();
    windows_io::create_dir(dir.path(), Path::new("content")).unwrap();
    let pin = windows_io::PinnedParent::open(dir.path(), Path::new("content/records.json"), false)
        .unwrap();
    let target = dir.path().join("content");
    assert!(std::fs::rename(&target, dir.path().join("moved")).is_err());
    assert!(std::fs::remove_dir(&target).is_err());
    assert!(!Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&target)
        .arg(dir.path())
        .status()
        .unwrap()
        .success());
    assert!(!dir.path().join("moved").exists());
    drop(pin);
    std::fs::rename(&target, dir.path().join("moved")).unwrap();
}
