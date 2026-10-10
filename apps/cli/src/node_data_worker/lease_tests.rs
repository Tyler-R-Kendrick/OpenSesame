//! Genuine generic kernel lease custody is distinct from private ordered writer custody.
use super::*;
#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use opensesame_human_vault::root_protection::windows_private_files::write_new;
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temporary = tempfile::tempdir().unwrap();
    let parent = std::fs::canonicalize(temporary.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("lease-only-worker-state");
    #[cfg(windows)]
    let path = Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap())
        .join("lease-only-worker-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([31; 32])).as_bytes(),
    )
    .unwrap();
    (temporary, root)
}
fn session(state: Arc<NativeNodeDataState>) -> OriginalSession {
    OriginalSession {
        state,
        lease: None,
        credential: None,
        body: None,
        inventory: None,
    }
}
fn request(op: wire::Operation) -> wire::Request {
    wire::Request { v: 1, op }
}
#[test]
fn actual_shared_kernel_lease_coexists_but_blocks_exclusive_until_original_worker_drain() {
    let (_temporary, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let mut original = session(Arc::clone(&state));
    original
        .apply(request(wire::Operation::Lease {
            logical: "opensesame:vault-body:selected".into(),
            mode: wire::LeaseMode::Shared,
        }))
        .unwrap();
    let other = NativeNodeDataState::capture(root).unwrap();
    let coexist = other
        .shared_lease("opensesame:vault-body:selected")
        .unwrap();
    coexist.validate().unwrap();
    drop(coexist);
    // Native acquisition is nonblocking. A genuine conflicting kernel object yields None;
    // a background unwrap cannot establish queueing or contention.
    assert!(other
        .try_exclusive_lease("opensesame:vault-body:selected")
        .unwrap()
        .is_none());
    original
        .apply(request(wire::Operation::Validate {}))
        .unwrap();
    original.drain().unwrap();
    other
        .try_exclusive_lease("opensesame:vault-body:selected")
        .unwrap()
        .unwrap()
        .validate()
        .unwrap();
    assert!(state.validate().is_err());
}
#[test]
fn generic_actual_kernel_lease_never_grants_ordered_writer_or_ciphertext_egress() {
    for operation in [
        wire::Operation::Credential {},
        wire::Operation::Body {
            tomb: "selected".into(),
        },
        wire::Operation::ReadGeneration {},
        wire::Operation::CaptureInventory {},
    ] {
        let (_temporary, root) = fixture();
        let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
        let mut original = session(Arc::clone(&state));
        original
            .apply(request(wire::Operation::Lease {
                logical: "opensesame.retired-credentials".into(),
                mode: wire::LeaseMode::Exclusive,
            }))
            .unwrap();
        assert!(original.apply(request(operation)).is_err());
        assert!(original.credential.is_none());
        assert!(original.body.is_none());
        assert!(original.inventory.is_none());
        original.drain().unwrap();
        assert!(state.validate().is_err());
        let successor = NativeNodeDataState::capture(root).unwrap();
        successor
            .exclusive_lease("opensesame.retired-credentials")
            .unwrap()
            .validate()
            .unwrap();
    }
}
#[test]
fn actual_protocol_failure_drops_generic_lease_and_refuses_caller_supplied_held_flag() {
    let (_temporary, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let mut input = Vec::new();
    for text in [
        r#"{"v":1,"op":{"kind":"lease","logical":"opensesame:activity-log:selected","mode":"exclusive"}}"#,
        r#"{"v":1,"op":{"kind":"lease_close","held":true}}"#,
    ] {
        framing::write(&mut input, text.as_bytes()).unwrap();
    }
    assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut Vec::new()).is_err());
    assert!(state.validate().is_err());
    let successor = NativeNodeDataState::capture(root).unwrap();
    successor
        .exclusive_lease("opensesame:activity-log:selected")
        .unwrap()
        .validate()
        .unwrap();
}
