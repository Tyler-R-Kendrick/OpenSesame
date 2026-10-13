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
        bootstrap: None,
        reader: None,
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

#[test]
fn actual_try_kernel_contention_returns_absence_without_generic_writer_promotion() {
    let (_temporary, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let other = NativeNodeDataState::capture(root).unwrap();
    let held = other
        .exclusive_lease("opensesame:activity-log:selected")
        .unwrap();
    let mut original = session(state);
    let try_request = || {
        request(wire::Operation::LeaseTry {
            logical: "opensesame:activity-log:selected".into(),
            mode: wire::LeaseMode::Exclusive,
        })
    };
    assert!(matches!(
        original.apply(try_request()).unwrap().0,
        wire::Reply::Available { acquired: false }
    ));
    assert!(original.lease.is_none());
    held.validate().unwrap();
    drop(held);
    assert!(matches!(
        original.apply(try_request()).unwrap().0,
        wire::Reply::Available { acquired: true }
    ));
    assert!(original
        .apply(request(wire::Operation::CredentialTry {}))
        .is_err());
    assert!(original.credential.is_none());
    original
        .apply(request(wire::Operation::LeaseClose {}))
        .unwrap();
    original.drain().unwrap();
}
#[test]
fn actual_try_busy_body_preserves_original_credential_and_acquires_after_release() {
    let (_temporary, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let initializer = state.credential_writer().unwrap();
    drop(initializer.bootstrap_writer("selected").unwrap());
    drop(initializer);
    let other = NativeNodeDataState::capture(root).unwrap();
    let held = other
        .exclusive_lease("opensesame:vault-body:selected")
        .unwrap();
    let mut original = session(state);
    assert!(matches!(
        original
            .apply(request(wire::Operation::CredentialTry {}))
            .unwrap()
            .0,
        wire::Reply::Available { acquired: true }
    ));
    let try_body = || {
        request(wire::Operation::BodyTry {
            tomb: "selected".into(),
        })
    };
    assert!(matches!(
        original.apply(try_body()).unwrap().0,
        wire::Reply::Available { acquired: false }
    ));
    assert!(original.body.is_none());
    original.credential.as_ref().unwrap().validate().unwrap();
    held.validate().unwrap();
    drop(held);
    assert!(matches!(
        original.apply(try_body()).unwrap().0,
        wire::Reply::Available { acquired: true }
    ));
    original.writer().unwrap().validate().unwrap();
    original
        .apply(request(wire::Operation::BodyClose {}))
        .unwrap();
    original.credential.as_ref().unwrap().validate().unwrap();
    original
        .apply(request(wire::Operation::CredentialClose {}))
        .unwrap();
    original.drain().unwrap();
}

#[test]
fn actual_named_body_shared_reader_has_fixed_ciphertext_without_credential_or_publication() {
    let (_temporary, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let initialize = state.credential_writer().unwrap();
    drop(initialize.bootstrap_writer("selected").unwrap());
    drop(initialize);
    let mut original = session(state);
    original
        .apply(request(wire::Operation::Lease {
            logical: "opensesame:vault-body:selected".into(),
            mode: wire::LeaseMode::Shared,
        }))
        .unwrap();
    original
        .apply(request(wire::Operation::CaptureBodyReader {
            tomb: "selected".into(),
        }))
        .unwrap();
    assert!(original.lease.is_none());
    assert!(original.credential.is_none());
    assert!(original.body.is_none());
    assert!(matches!(
        original
            .apply(request(wire::Operation::ReadGeneration {}))
            .unwrap()
            .0,
        wire::Reply::Bytes { base64: None }
    ));
    assert!(original
        .apply(request(wire::Operation::PublishGeneration {
            expected: None,
            next: Some(STANDARD.encode("controlled invalid ciphertext")),
        }))
        .is_err());
    assert!(original
        .apply(request(wire::Operation::CredentialTry {}))
        .is_err());
    original.reader.as_ref().unwrap().validate().unwrap();
    original
        .apply(request(wire::Operation::BodyReaderClose {}))
        .unwrap();
    original.drain().unwrap();
    NativeNodeDataState::capture(root)
        .unwrap()
        .exclusive_lease("opensesame:vault-body:selected")
        .unwrap()
        .validate()
        .unwrap();
}
