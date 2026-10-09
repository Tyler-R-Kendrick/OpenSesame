//! Genuine OS locks and independent child processes; authored, not executed here.
use super::*;
use std::{fs, path::PathBuf, process::Command};
const CREDENTIAL: &str = "opensesame.retired-credentials";
const BODY: &str = "opensesame:vault-body:main";
fn fixture() -> (tempfile::TempDir, PathBuf, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let root = fs::canonicalize(temp.path()).unwrap().join("private");
    #[cfg(windows)]
    let root = temp.path().join("private");
    let directory = Arc::new(PrivateDirectory::create_new(&root).unwrap());
    (temp, root, directory)
}
fn contend(directory: Arc<PrivateDirectory>, logical: &str) {
    assert_eq!(
        HeldPrivateWriterLease::exclusive(directory, logical)
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::WouldBlock
    );
}
fn child(root: &Path, expected: &str) {
    let module = module_path!().split_once("::").unwrap().1;
    let output = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg(format!("{module}::actual_independent_process_lease_worker"))
        .arg("--nocapture")
        .env("RET_NATIVE_LEASE_TEST_ROOT", root)
        .env("RET_NATIVE_LEASE_TEST_EXPECT", expected)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // A zero-case filtered test executable cannot satisfy this actual worker marker.
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains(&format!("RET_NATIVE_LEASE_WORKER_COMPLETED_{expected}")));
}
#[test]
fn actual_independent_process_lease_worker() {
    let Ok(root) = std::env::var("RET_NATIVE_LEASE_TEST_ROOT") else {
        let (_temp, _root, directory) = fixture();
        let held = HeldPrivateWriterLease::exclusive(Arc::clone(&directory), CREDENTIAL).unwrap();
        contend(Arc::clone(&directory), CREDENTIAL);
        drop(held);
        HeldPrivateWriterLease::exclusive(directory, CREDENTIAL)
            .unwrap()
            .validate()
            .unwrap();
        return;
    };
    let expected = std::env::var("RET_NATIVE_LEASE_TEST_EXPECT").unwrap();
    let directory = Arc::new(PrivateDirectory::open(Path::new(&root)).unwrap());
    if expected == "held" || expected == "shared" {
        contend(Arc::clone(&directory), CREDENTIAL);
        if expected == "shared" {
            HeldPrivateWriterLease::shared(directory, CREDENTIAL)
                .unwrap()
                .validate()
                .unwrap();
        }
    } else {
        assert_eq!(expected, "free");
        HeldPrivateWriterLease::exclusive(directory, CREDENTIAL)
            .unwrap()
            .validate()
            .unwrap();
    }
    println!("RET_NATIVE_LEASE_WORKER_COMPLETED_{expected}");
}
#[test]
fn real_crossprocess_contention_drop_release_and_distinct_body_lock() {
    let (_temp, root, directory) = fixture();
    let credential = HeldPrivateWriterLease::exclusive(Arc::clone(&directory), CREDENTIAL).unwrap();
    let body = HeldPrivateWriterLease::exclusive(Arc::clone(&directory), BODY).unwrap();
    credential.validate().unwrap();
    body.validate().unwrap();
    child(&root, "held");
    drop(credential);
    child(&root, "free");
    body.validate().unwrap();
    assert!(root
        .join(physical_writer_lease_name(CREDENTIAL).unwrap())
        .exists());
}
#[test]
fn nonempty_and_hardlinked_lock_records_refuse_without_repair() {
    for kind in ["nonempty", "hardlinked"] {
        let (_temp, root, directory) = fixture();
        let name = physical_writer_lease_name(CREDENTIAL).unwrap();
        super::super::write_new(
            &directory,
            Path::new(&name),
            if kind == "nonempty" { b"foreign" } else { b"" },
        )
        .unwrap();
        if kind == "hardlinked" {
            fs::hard_link(root.join(&name), root.join("alias")).unwrap();
        }
        let before = fs::read(root.join(&name)).unwrap();
        assert!(HeldPrivateWriterLease::exclusive(directory, CREDENTIAL).is_err());
        assert_eq!(fs::read(root.join(name)).unwrap(), before);
    }
}
#[cfg(unix)]
#[test]
fn substituted_root_or_lease_file_invalidates_the_actual_original_holder() {
    let (_temp, root, directory) = fixture();
    let held = HeldPrivateWriterLease::exclusive(directory, CREDENTIAL).unwrap();
    let name = physical_writer_lease_name(CREDENTIAL).unwrap();
    fs::rename(root.join(&name), root.join("old-lock")).unwrap();
    assert!(held.validate().is_err());
    fs::rename(root.join("old-lock"), root.join(name)).unwrap();
    held.validate().unwrap();
    fs::rename(&root, root.with_extension("old")).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(held.validate().is_err());
}
#[cfg(windows)]
#[test]
fn retained_windows_lease_and_ancestry_deny_delete_substitution() {
    let (_temp, root, directory) = fixture();
    let held = HeldPrivateWriterLease::exclusive(directory, CREDENTIAL).unwrap();
    let name = physical_writer_lease_name(CREDENTIAL).unwrap();
    assert!(fs::rename(root.join(name), root.join("old-lock")).is_err());
    assert!(fs::rename(&root, root.with_extension("old")).is_err());
    held.validate().unwrap();
}

#[test]
fn actual_shared_leases_coexist_and_block_exclusive_across_processes() {
    let (_temp, root, directory) = fixture();
    let first = HeldPrivateWriterLease::shared(Arc::clone(&directory), CREDENTIAL).unwrap();
    let second = HeldPrivateWriterLease::shared(Arc::clone(&directory), CREDENTIAL).unwrap();
    first.validate().unwrap();
    second.validate().unwrap();
    contend(Arc::clone(&directory), CREDENTIAL);
    child(&root, "shared");
    drop(first);
    contend(Arc::clone(&directory), CREDENTIAL);
    drop(second);
    let exclusive = HeldPrivateWriterLease::exclusive(Arc::clone(&directory), CREDENTIAL).unwrap();
    assert_eq!(
        HeldPrivateWriterLease::shared(directory, CREDENTIAL)
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    exclusive.validate().unwrap();
}
