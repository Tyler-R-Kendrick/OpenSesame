// Included only inside private_file::unix under cfg(test). Actual Unix IO, no mock adapter.
use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::process::{Command, Stdio};

const CHILD_ROOT: &str = "OPENSESAME_PRIVATE_FILE_ADMISSION_ROOT";

fn run_child(case: &str, root: &Path) {
    let name = format!("credential_canaries::private_file::unix::admission_tests::{case}");
    let (output, output_path) = tempfile::NamedTempFile::new().unwrap().keep().unwrap();
    assert!(output.metadata().unwrap().is_file());
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env(CHILD_ROOT, root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output))
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let status = wait_for_child(&mut child, case, &output_path);
    let captured = std::fs::read_to_string(&output_path).unwrap();
    assert!(
        status.success(),
        "isolated filesystem control failed: {case}; stdout {output_path:?}"
    );
    let expected = format!("test {name} ... ok");
    let cases: Vec<_> = captured
        .lines()
        .filter(|line| line.starts_with("test ") && !line.starts_with("test result:"))
        .collect();
    assert_eq!(
        cases,
        [expected.as_str()],
        "child must execute exactly its intended case; stdout {output_path:?}"
    );
    let summaries: Vec<_> = captured
        .lines()
        .filter(|line| line.starts_with("test result:"))
        .collect();
    assert_eq!(summaries.len(), 1, "stdout {output_path:?}");
    assert!(
        summaries[0].starts_with("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured;"),
        "stdout {output_path:?}"
    );
}

fn wait_for_child(
    child: &mut std::process::Child,
    case: &str,
    output_path: &Path,
) -> std::process::ExitStatus {
    let started = std::time::Instant::now();
    let mut status = child.try_wait().unwrap();
    while status.is_none() {
        enforce_child_deadline(child, started, case, output_path);
        std::thread::sleep(std::time::Duration::from_millis(20));
        status = child.try_wait().unwrap();
    }
    status.unwrap()
}

fn enforce_child_deadline(
    child: &mut std::process::Child,
    started: std::time::Instant,
    case: &str,
    output_path: &Path,
) {
    if started.elapsed() < std::time::Duration::from_secs(10) {
        return;
    }
    child.kill().unwrap();
    child.wait().unwrap();
    panic!("isolated filesystem control hung: {case}; stdout {output_path:?}");
}

fn child_root() -> Option<std::path::PathBuf> {
    std::env::var_os(CHILD_ROOT).map(Into::into)
}

#[test]
fn every_fixed_record_is_durable_bounded_and_independently_removable() {
    let root = tempfile::tempdir().unwrap();
    for record in [Record::Key, Record::State, Record::Validator] {
        assert!(read(root.path(), record, 32).unwrap().is_none());
        remove(root.path(), record).unwrap();
        write(root.path(), record, record.name().as_bytes()).unwrap();
    }
    for record in [Record::Key, Record::State, Record::Validator] {
        assert_eq!(
            read(root.path(), record, 64).unwrap().unwrap(),
            record.name().as_bytes()
        );
        assert_eq!(
            std::fs::metadata(root.path().join(record.name()))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
    }
    remove(root.path(), Record::State).unwrap();
    assert!(!root.path().join(Record::State.name()).exists());
    assert!(read(root.path(), Record::State, 64).unwrap().is_none());
    assert!(read(root.path(), Record::Key, 64).unwrap().is_some());
    assert!(read(root.path(), Record::Validator, 64).unwrap().is_some());
    remove(root.path(), Record::State).unwrap();
}

#[test]
fn parent_symlink_and_parent_permissions_cannot_admit_private_records() {
    let root = tempfile::tempdir().unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("foreign-root");
    symlink(root.path(), &alias).unwrap();
    assert!(directory(&alias).is_err());
    assert!(write(&alias, Record::State, b"not admitted").is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    super::super::require_private_directory(root.path()).unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o711)).unwrap();
    assert!(super::super::require_private_directory(root.path()).is_err());
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o770)).unwrap();
    assert!(directory(root.path()).is_err());
    assert!(write(root.path(), Record::State, b"not admitted").is_err());
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    write(root.path(), Record::State, b"current private record").unwrap();
    assert_eq!(
        read(root.path(), Record::State, 64).unwrap().unwrap(),
        b"current private record"
    );
}

#[test]
fn fifo_refusal_is_nonblocking_and_directory_refusal_has_no_publication() {
    if let Some(root) = child_root() {
        let name = std::ffi::CString::new(
            root.join(Record::State.name())
                .as_os_str()
                .as_encoded_bytes(),
        )
        .unwrap();
        // SAFETY: owned fresh fixture path, exact private FIFO permissions.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read(&root, Record::State, 32).is_err());
        assert!(write(&root, Record::State, b"not admitted").is_err());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    run_child(
        "fifo_refusal_is_nonblocking_and_directory_refusal_has_no_publication",
        root.path(),
    );
    std::fs::remove_file(root.path().join(Record::State.name())).unwrap();
    std::fs::create_dir(root.path().join(Record::State.name())).unwrap();
    assert!(read(root.path(), Record::State, 32).is_err());
    assert!(write(root.path(), Record::State, b"not admitted").is_err());
    assert!(remove(root.path(), Record::State).is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn descriptor_zero_is_valid_after_parent_descriptor_was_opened() {
    if let Some(root) = child_root() {
        let parent = directory(&root).unwrap();
        assert!(parent.as_raw_fd() > 0);
        // SAFETY: this isolated child owns stdin; parent directory was already opened.
        assert_eq!(unsafe { libc::close(libc::STDIN_FILENO) }, 0);
        let mut file = open(&parent, Record::State).unwrap().unwrap();
        assert_eq!(file.as_raw_fd(), 0);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"descriptor zero remains valid");
        drop(file); // Release descriptor zero before the distinct exclusive creation operation.
        let temporary = std::ffi::CString::new(".observation-admission-fd-zero").unwrap();
        let mut created = create_temp(&parent, &temporary).unwrap();
        assert_eq!(created.as_raw_fd(), 0);
        assert_eq!(created.metadata().unwrap().mode() & 0o777, 0o600);
        // SAFETY: F_GETFD reads flags on this child-owned live descriptor.
        let flags = unsafe { libc::fcntl(created.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
        created
            .write_all(b"exclusive descriptor zero publication")
            .unwrap();
        created.sync_all().unwrap();
        drop(created);
        assert_eq!(
            std::fs::read(root.join(".observation-admission-fd-zero")).unwrap(),
            b"exclusive descriptor zero publication"
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    write(root.path(), Record::State, b"descriptor zero remains valid").unwrap();
    run_child(
        "descriptor_zero_is_valid_after_parent_descriptor_was_opened",
        root.path(),
    );
}

#[test]
fn exhausted_descriptors_are_errors_rather_than_missing_records() {
    if let Some(root) = child_root() {
        let parent = directory(&root).unwrap();
        let mut original = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: valid owned storage for this isolated process's descriptor limit.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut original) },
            0
        );
        assert!(original.rlim_cur >= 64);
        let bounded = libc::rlimit {
            rlim_cur: 64,
            rlim_max: original.rlim_max,
        };
        // SAFETY: soft limit lowered only within the isolated child.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &bounded) }, 0);
        let mut occupied = Vec::new();
        let exhaustion = occupy_until_exhausted(&mut occupied);
        assert_eq!(exhaustion.raw_os_error(), Some(libc::EMFILE));
        let outcome = open(&parent, Record::State);
        drop(occupied);
        // SAFETY: restore this child's original soft limit before asserting the result.
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &original) },
            0
        );
        assert!(outcome.is_err());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    write(root.path(), Record::State, b"present, not missing").unwrap();
    run_child(
        "exhausted_descriptors_are_errors_rather_than_missing_records",
        root.path(),
    );
}

#[test]
fn refused_unlink_is_not_success_and_keeps_the_private_record() {
    if let Some(root) = child_root() {
        drop_child_root_privileges(&root);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(
            read(&root, Record::State, 64).unwrap().unwrap(),
            b"preserved on unlink failure"
        );
        let outcome = remove(&root, Record::State);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(outcome.is_err());
        assert_eq!(
            read(&root, Record::State, 64).unwrap().unwrap(),
            b"preserved on unlink failure"
        );
        remove(&root, Record::State).unwrap();
        assert!(read(&root, Record::State, 64).unwrap().is_none());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    write(root.path(), Record::State, b"preserved on unlink failure").unwrap();
    run_child(
        "refused_unlink_is_not_success_and_keeps_the_private_record",
        root.path(),
    );
}

fn occupy_until_exhausted(occupied: &mut Vec<File>) -> std::io::Error {
    loop {
        match File::open("/dev/null") {
            Ok(file) => occupied.push(file),
            Err(error) => return error,
        }
    }
}

fn drop_child_root_privileges(root: &Path) {
    // Root-local runs use a genuine unprivileged child, never a skipped permission assertion.
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    for path in [root, &root.join(Record::State.name())] {
        let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: only owned child-fixture paths are handed to the unprivileged UID.
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 65534, 65534) }, 0);
    }
    // SAFETY: permanently drop only this isolated child's privileges.
    assert_eq!(unsafe { libc::setgid(65534) }, 0);
    assert_eq!(unsafe { libc::setuid(65534) }, 0);
}

#[test]
fn actual_rename_refusal_cleans_pending_and_preserves_independent_private_records() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        Record::Key,
        b"unchanged independent key fixture",
    )
    .unwrap();
    let destination = root.path().join(Record::State.name());
    let reached_publication = std::cell::Cell::new(false);
    let result = write_before_publish(root.path(), Record::State, b"never published", || {
        reached_publication.set(true);
        std::fs::create_dir(&destination)
    });
    assert!(reached_publication.get());
    assert!(matches!(result, Err(StoreError::Io(_))));
    assert!(destination.is_dir());
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
    assert_eq!(
        read(root.path(), Record::Key, 64).unwrap().unwrap(),
        b"unchanged independent key fixture"
    );
    let mut names: Vec<_> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    let mut expected = vec![
        std::ffi::OsString::from(Record::Key.name()),
        std::ffi::OsString::from(Record::State.name()),
    ];
    expected.sort();
    assert_eq!(
        names, expected,
        "failed publication must remove its pending file"
    );
    std::fs::remove_dir(&destination).unwrap();
    write(root.path(), Record::State, b"subsequent durable state").unwrap();
    assert_eq!(
        read(root.path(), Record::State, 64).unwrap().unwrap(),
        b"subsequent durable state"
    );
    assert_eq!(
        std::fs::metadata(&destination).unwrap().mode() & 0o777,
        0o600
    );
}
