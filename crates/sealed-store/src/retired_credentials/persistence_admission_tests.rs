// Unix native filesystem controls, included only under cfg(all(test, unix)).
use super::*;
use std::os::unix::fs::{symlink, MetadataExt};

#[test]
fn record_presence_does_not_hide_non_not_found_errors() {
    let root = tempfile::tempdir().unwrap();
    assert!(!exists(root.path()).unwrap());
    write(root.path(), b"complete retired records").unwrap();
    assert!(exists(root.path()).unwrap());
    let non_directory = tempfile::NamedTempFile::new().unwrap();
    assert!(exists(non_directory.path()).is_err());
    assert_eq!(
        std::fs::read(root.path().join(super::super::RETIRED_RECORD_FILE)).unwrap(),
        b"complete retired records"
    );
}

#[test]
fn publication_refuses_symlink_parent_without_modifying_foreign_records() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), b"original retired records").unwrap();
    let alias_root = tempfile::tempdir().unwrap();
    let alias = alias_root.path().join("root-alias");
    symlink(root.path(), &alias).unwrap();
    assert!(write(&alias, b"foreign replacement").is_err());
    assert_eq!(
        std::fs::read(root.path().join(super::super::RETIRED_RECORD_FILE)).unwrap(),
        b"original retired records"
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn real_rename_failure_cleans_its_pending_file_and_cannot_report_publication() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join(super::super::RETIRED_RECORD_FILE);
    let result = write_before_publish(root.path(), b"replacement", || {
        std::fs::create_dir(&destination)
    });
    assert!(result.is_err());
    assert!(destination.is_dir());
    let children: Vec<_> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        children,
        vec![destination.file_name().unwrap().to_os_string()]
    );
    std::fs::remove_dir(&destination).unwrap();
    write(root.path(), b"subsequent complete records").unwrap();
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"subsequent complete records"
    );
    assert_eq!(
        std::fs::metadata(&destination).unwrap().mode() & 0o777,
        0o600
    );
}

#[test]
fn retired_temporary_file_can_own_descriptor_zero_after_parent_open() {
    use std::io::Write;
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    const ENV: &str = "OPENSESAME_RETIRED_TEMP_FD_ZERO_ROOT";
    const CASE: &str = "retired_credentials::persistence::admission_tests::retired_temporary_file_can_own_descriptor_zero_after_parent_open";
    if let Some(root) = std::env::var_os(ENV) {
        let root = std::path::PathBuf::from(root);
        let parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&root)
            .unwrap();
        assert!(parent.as_raw_fd() > 0);
        // SAFETY: isolated child stdin is deliberately closed only after parent open.
        assert_eq!(unsafe { libc::close(libc::STDIN_FILENO) }, 0);
        let name = std::ffi::CString::new(".retired-admission-fd-zero").unwrap();
        let mut file = create_temp(&parent, &name).unwrap();
        assert_eq!(file.as_raw_fd(), 0);
        assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o600);
        // SAFETY: inspect flags of this child's owned live descriptor.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
        file.write_all(b"actual retired temporary descriptor zero")
            .unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(
            std::fs::read(root.join(".retired-admission-fd-zero")).unwrap(),
            b"actual retired temporary descriptor zero"
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let (stdout, stdout_path) = tempfile::NamedTempFile::new().unwrap().keep().unwrap();
    assert!(stdout.metadata().unwrap().is_file());
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CASE, "--nocapture"])
        .env(ENV, root.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(stdout))
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(
                status.success(),
                "isolated retired-file control failed; stdout {stdout_path:?}"
            );
            let captured = std::fs::read_to_string(&stdout_path).unwrap();
            let cases: Vec<_> = captured
                .lines()
                .filter(|line| line.starts_with("test ") && !line.starts_with("test result:"))
                .collect();
            let expected = format!("test {CASE} ... ok");
            assert_eq!(cases, [expected.as_str()], "stdout {stdout_path:?}");
            let summaries: Vec<_> = captured
                .lines()
                .filter(|line| line.starts_with("test result:"))
                .collect();
            assert_eq!(summaries.len(), 1, "stdout {stdout_path:?}");
            assert!(
                summaries[0]
                    .starts_with("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured;"),
                "stdout {stdout_path:?}"
            );
            break;
        }
        if started.elapsed() >= std::time::Duration::from_secs(10) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("isolated retired-file control hung; stdout {stdout_path:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
