//! Genuine ordered kernel custody for an absent tomb; DATA, never a vault or owner grant.
use super::*;
#[cfg(unix)]
use crate::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use crate::root_protection::windows_private_files::write_new;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, path::PathBuf, process::Command, sync::mpsc, time::Duration};
const TOMB: &str = "new-selected";
const BODY: &str = "opensesame:vault-body:new-selected";
fn fixture() -> (tempfile::TempDir, PathBuf, Arc<PrivateDirectory>) {
    let temporary = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temporary.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("bootstrap-lease-state");
    #[cfg(windows)]
    let path = Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap())
        .join("bootstrap-lease-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([51; 32])).as_bytes(),
    )
    .unwrap();
    (temporary, path, root)
}
fn probe(path: &Path, expected: &str) {
    let module = module_path!().split_once("::").unwrap().1;
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("{module}::actual_bootstrap_lease_process_probe"),
            "--nocapture",
        ])
        .env("RET_BOOTSTRAP_LEASE_TEST_ROOT", path)
        .env("RET_BOOTSTRAP_LEASE_TEST_EXPECT", expected)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains(&format!("RET_BOOTSTRAP_LEASE_PROCESS_COMPLETED_{expected}")));
}
#[test]
fn actual_bootstrap_lease_process_probe() {
    let Ok(path) = std::env::var("RET_BOOTSTRAP_LEASE_TEST_ROOT") else {
        let (_temporary, _path, root) = fixture();
        NativeNodeDataState::capture(root)
            .unwrap()
            .try_credential_writer()
            .unwrap()
            .unwrap();
        return;
    };
    let expected = std::env::var("RET_BOOTSTRAP_LEASE_TEST_EXPECT").unwrap();
    let root = Arc::new(PrivateDirectory::open(Path::new(&path)).unwrap());
    let state = NativeNodeDataState::capture(root).unwrap();
    match expected.as_str() {
        "held" => {
            assert!(state.try_credential_writer().unwrap().is_none());
            assert!(state.try_exclusive_lease(BODY).unwrap().is_none());
        }
        "credential-only" => {
            assert!(state.try_credential_writer().unwrap().is_none());
            state
                .try_exclusive_lease(BODY)
                .unwrap()
                .unwrap()
                .validate()
                .unwrap();
        }
        "free" => {
            let credential = state.try_credential_writer().unwrap().unwrap();
            let lease = credential
                .try_capture_bootstrap_lease(TOMB)
                .unwrap()
                .unwrap();
            lease.require_destination_absent().unwrap();
        }
        _ => panic!("unknown bootstrap probe expectation"),
    }
    println!("RET_BOOTSTRAP_LEASE_PROCESS_COMPLETED_{expected}");
}
#[test]
fn actual_absent_bootstrap_never_precreates_and_retains_both_kernels_across_processes() {
    let (_temporary, path, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    let lease = credential
        .try_capture_bootstrap_lease(TOMB)
        .unwrap()
        .unwrap();
    assert!(root.original_entry_absent(Path::new("vault")).unwrap());
    lease.require_destination_absent().unwrap();
    drop(credential);
    probe(&path, "held");
    lease.close().unwrap();
    assert!(lease.validate().is_err());
    assert!(lease.require_destination_absent().is_err());
    lease.close().unwrap();
    probe(&path, "free");
    assert!(root.original_entry_absent(Path::new("vault")).unwrap());
}
#[test]
fn actual_bootstrap_contention_returns_none_without_releasing_original_credential() {
    let (_temporary, path, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let body = state.try_shared_lease(BODY).unwrap().unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    assert!(credential
        .try_capture_bootstrap_lease(TOMB)
        .unwrap()
        .is_none());
    credential.validate().unwrap();
    drop(body);
    probe(&path, "credential-only");
    let lease = credential
        .try_capture_bootstrap_lease(TOMB)
        .unwrap()
        .unwrap();
    probe(&path, "held");
    lease.close().unwrap();
    probe(&path, "credential-only");
    drop(credential);
    probe(&path, "free");
}
#[test]
fn actual_bootstrap_accepts_node_stage_rename_without_becoming_a_data_writer() {
    let (_temporary, path, root) = fixture();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    root.create_child(Path::new("origin-files")).unwrap();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    let lease = credential
        .try_capture_bootstrap_lease(TOMB)
        .unwrap()
        .unwrap();
    lease.require_destination_absent().unwrap();
    let staging_directory = vaults
        .create_child(Path::new("original-node-stage"))
        .unwrap();
    write_new(
        &staging_directory,
        Path::new("opaque.json"),
        b"controlled synthetic DATA",
    )
    .unwrap();
    drop(staging_directory);
    fs::rename(
        path.join("vault/original-node-stage"),
        path.join("vault").join(TOMB),
    )
    .unwrap();
    lease.validate().unwrap();
    assert!(lease.require_destination_absent().is_err());
    assert!(credential
        .try_capture_existing_writer(TOMB)
        .unwrap()
        .is_none());
    lease.close().unwrap();
    let writer = credential
        .try_capture_existing_writer(TOMB)
        .unwrap()
        .unwrap();
    assert_eq!(
        writer
            .read(
                super::super::NativeNodeDataScope::Vault,
                Path::new("opaque.json"),
                64
            )
            .unwrap(),
        b"controlled synthetic DATA"
    );
    drop(writer);
    drop(credential);
}
#[test]
fn actual_bootstrap_refuses_present_invalid_destination_and_cancelled_state() {
    let (_temporary, _path, root) = fixture();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    vaults.create_child(Path::new("present")).unwrap();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    for tomb in ["present", "../outside", "", "."] {
        assert!(credential.try_capture_bootstrap_lease(tomb).is_err());
    }
    assert!(vaults.original_entry_absent(Path::new(TOMB)).unwrap());
    let lease = credential
        .try_capture_bootstrap_lease(TOMB)
        .unwrap()
        .unwrap();
    state.seal().unwrap();
    assert!(lease.validate().is_err());
    assert!(lease.require_destination_absent().is_err());
    lease.close().unwrap();
    drop(credential);
    let successor = NativeNodeDataState::capture(root).unwrap();
    successor.try_exclusive_lease(BODY).unwrap().unwrap();
    successor.try_credential_writer().unwrap().unwrap();
}
#[test]
fn actual_bootstrap_close_drains_accepted_native_operation_before_kernel_release() {
    let (_temporary, _path, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    let lease = Arc::new(
        credential
            .try_capture_bootstrap_lease(TOMB)
            .unwrap()
            .unwrap(),
    );
    drop(credential);
    let operation = gate(&state.operations).unwrap();
    let (entered, entry) = mpsc::channel();
    let (completed, completion) = mpsc::channel();
    let closing = Arc::clone(&lease);
    let task = std::thread::spawn(move || {
        entered.send(()).unwrap();
        closing.close().unwrap();
        completed.send(()).unwrap();
    });
    entry.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(
        completion.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    let held = lease.held.lock().unwrap();
    held.as_ref()
        .unwrap()
        .body
        .validate_exclusive_for(&state.locks, BODY)
        .unwrap();
    held.as_ref()
        .unwrap()
        .credential
        .credential
        .validate_exclusive_for(&state.locks, super::super::NODE_CREDENTIAL_LEASE)
        .unwrap();
    drop(held);
    drop(operation);
    completion.recv_timeout(Duration::from_secs(2)).unwrap();
    task.join().unwrap();
    assert!(lease.validate().is_err());
    state.try_exclusive_lease(BODY).unwrap().unwrap();
    state.try_credential_writer().unwrap().unwrap();
}

#[test]
fn actual_same_credential_body_selection_uses_real_presence_and_never_falls_back_on_error() {
    let (_temporary, _path, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    let selected = credential
        .try_capture_body_or_bootstrap(TOMB)
        .unwrap()
        .unwrap();
    let NativeNodeBodyCustody::Bootstrap(lease) = selected else {
        panic!("absent tomb became writer")
    };
    assert!(root.original_entry_absent(Path::new("vault")).unwrap());
    lease.require_destination_absent().unwrap();
    lease.close().unwrap();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    vaults.create_child(Path::new(TOMB)).unwrap();
    // Existing tomb without the original required origin directory is an error, not bootstrap.
    assert!(credential.try_capture_body_or_bootstrap(TOMB).is_err());
    root.create_child(Path::new("origin-files")).unwrap();
    let selected = credential
        .try_capture_body_or_bootstrap(TOMB)
        .unwrap()
        .unwrap();
    let NativeNodeBodyCustody::Writer(writer) = selected else {
        panic!("present tomb became bootstrap")
    };
    writer.validate().unwrap();
    assert!(credential
        .try_capture_body_or_bootstrap(TOMB)
        .unwrap()
        .is_none());
    drop(writer);
    write_new(&vaults, Path::new("unsafe-file"), b"not a directory").unwrap();
    assert!(credential
        .try_capture_body_or_bootstrap("unsafe-file")
        .is_err());
}
