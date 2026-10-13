//! Genuine low-level OS tests, not secure Windows directory-opening or owner proof.
use super::acquire;
#[cfg(unix)]
use super::open_lock_file;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const ROOT_ENV: &str = "OS_LOCK_PROBE_ROOT";
const MODE_ENV: &str = "OS_LOCK_PROBE_EXCLUSIVE";
const CHILD_TEST: &str = "store_lock::platform::tests::child_try_lock";
struct ProbeChild(Child);
impl Drop for ProbeChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn fixture_file(root: &Path, create: bool) -> File {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        // Controlled synchronous test handle; no delete-sharing or overlapped flag.
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    options.open(root.join(".portable-lock-probe")).unwrap()
}
fn probe(root: &Path, exclusive: bool) -> String {
    let mut child = ProbeChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .env(ROOT_ENV, root)
            .env(MODE_ENV, if exclusive { "1" } else { "0" })
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "physical child acquisition did not finish"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut stdout = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .take(4097)
        .read_to_string(&mut stdout)
        .unwrap();
    let mut stderr = String::new();
    child
        .0
        .stderr
        .take()
        .unwrap()
        .take(4097)
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(stdout.len() <= 4096 && stderr.len() <= 4096);
    assert!(status.success(), "child failed: {stderr}");
    let outcomes: Vec<_> = stdout
        .lines()
        .filter(|line| line.starts_with("PHYSICAL_LOCK_"))
        .collect();
    assert_eq!(outcomes.len(), 1);
    outcomes[0].into()
}
// Auxiliary real child entry. Its no-environment invocation is not acceptance evidence.
#[test]
fn child_try_lock() {
    let Some(root) = std::env::var_os(ROOT_ENV) else {
        return;
    };
    let exclusive = match std::env::var(MODE_ENV).unwrap().as_str() {
        "1" => true,
        "0" => false,
        _ => panic!("invalid controlled probe mode"),
    };
    let file = fixture_file(Path::new(&root), false);
    match acquire(&file, exclusive) {
        Ok(()) => println!("\nPHYSICAL_LOCK_ACQUIRED"),
        Err(None) => println!("\nPHYSICAL_LOCK_BUSY"),
        Err(Some(error)) => panic!("physical lock IO failed: {error}"),
    }
}
#[test]
fn exclusive_holder_blocks_both_child_modes_and_close_allows_acquire() {
    let root = tempfile::tempdir().unwrap();
    let file = fixture_file(root.path(), true);
    assert!(acquire(&file, true).is_ok());
    assert_eq!(probe(root.path(), false), "PHYSICAL_LOCK_BUSY");
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_BUSY");
    drop(file);
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_ACQUIRED");
    assert!(root.path().join(".portable-lock-probe").is_file());
}
#[test]
fn shared_holders_allow_reader_but_block_writer_until_all_close() {
    let root = tempfile::tempdir().unwrap();
    let first = fixture_file(root.path(), true);
    let second = fixture_file(root.path(), false);
    assert!(acquire(&first, false).is_ok());
    assert!(acquire(&second, false).is_ok());
    assert_eq!(probe(root.path(), false), "PHYSICAL_LOCK_ACQUIRED");
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_BUSY");
    drop(first);
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_BUSY");
    drop(second);
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_ACQUIRED");
}
#[cfg(unix)]
#[test]
fn original_unix_opening_still_acquires_and_refuses_symlink_root() {
    let root = tempfile::tempdir().unwrap();
    let file = open_lock_file(root.path()).unwrap();
    assert!(acquire(&file, true).is_ok());
    drop(file);
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("root");
    std::os::unix::fs::symlink(root.path(), &alias).unwrap();
    assert!(open_lock_file(&alias).is_err());
}
#[cfg(windows)]
#[test]
fn windows_store_lock_holds_the_real_file_and_blocks_rotation_until_all_writers_drop() {
    let root = tempfile::tempdir().unwrap();
    let first = super::super::StoreLock::shared(root.path()).unwrap();
    let second = super::super::StoreLock::shared(root.path()).unwrap();
    assert!(super::super::StoreLock::exclusive(root.path()).is_err());
    drop(first);
    assert!(super::super::StoreLock::exclusive(root.path()).is_err());
    drop(second);
    let rotation = super::super::StoreLock::exclusive(root.path()).unwrap();
    assert!(super::super::StoreLock::shared(root.path()).is_err());
    assert!(super::super::StoreLock::exclusive(root.path()).is_err());
    drop(rotation);
    assert!(super::super::StoreLock::shared(root.path()).is_ok());
    assert!(root.path().join(super::super::STORE_LOCK_FILE).is_file());
}
#[cfg(windows)]
#[test]
fn explicit_windows_release_allows_real_child_while_file_remains_open() {
    let root = tempfile::tempdir().unwrap();
    let file = fixture_file(root.path(), true);
    assert!(acquire(&file, true).is_ok());
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_BUSY");
    super::release(&file).unwrap();
    assert_eq!(probe(root.path(), true), "PHYSICAL_LOCK_ACQUIRED");
    assert!(file.metadata().unwrap().is_file());
}

#[cfg(windows)]
#[test]
fn windows_directory_handle_failure_is_an_io_error_instead_of_busy_or_success() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    let root = tempfile::tempdir().unwrap();
    let directory = OpenOptions::new()
        .read(true)
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(root.path())
        .unwrap();
    assert!(matches!(
        acquire(&directory, true),
        Err(Some(crate::StoreError::Io(_)))
    ));
}
