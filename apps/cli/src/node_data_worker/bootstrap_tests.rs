//! Genuine private worker phase; incoming existence/mode/held metadata cannot manufacture custody.
use super::*;
#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use opensesame_human_vault::root_protection::windows_private_files::write_new;
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>, OriginalSession) {
    let temporary = tempfile::tempdir().unwrap();
    let parent = std::fs::canonicalize(temporary.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("bootstrap-worker-state");
    #[cfg(windows)]
    let path = Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap())
        .join("bootstrap-worker-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([61; 32])).as_bytes(),
    )
    .unwrap();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let original = OriginalSession {
        state,
        lease: None,
        credential: None,
        body: None,
        bootstrap: None,
        reader: None,
        inventory: None,
    };
    (temporary, root, original)
}
fn request(op: wire::Operation) -> wire::Request {
    wire::Request { v: 1, op }
}
fn selected() -> wire::Request {
    request(wire::Operation::BodyOrBootstrapTry {
        tomb: "new-selected".into(),
    })
}
#[test]
fn actual_absent_worker_custody_never_exposes_data_writer_or_precreates_directory() {
    let (_temporary, root, mut original) = fixture();
    assert!(original.apply(selected()).is_err());
    original
        .apply(request(wire::Operation::CredentialTry {}))
        .unwrap();
    assert!(matches!(
        original.apply(selected()).unwrap().0,
        wire::Reply::Available { acquired: true }
    ));
    assert!(original.body.is_none());
    assert!(original.bootstrap.is_some());
    assert!(root.original_entry_absent(Path::new("vault")).unwrap());
    original
        .apply(request(wire::Operation::BootstrapDestinationAbsent {}))
        .unwrap();
    for op in [
        wire::Operation::ReadGeneration {},
        wire::Operation::PublishGeneration {
            expected: None,
            next: Some(STANDARD.encode("controlled DATA")),
        },
        wire::Operation::BodyTry {
            tomb: "new-selected".into(),
        },
        wire::Operation::Body {
            tomb: "new-selected".into(),
        },
        wire::Operation::CaptureBodyReader {
            tomb: "new-selected".into(),
        },
        wire::Operation::LeaseTry {
            logical: "arbitrary".into(),
            mode: wire::LeaseMode::Exclusive,
        },
        wire::Operation::CredentialClose {},
    ] {
        assert!(original.apply(request(op)).is_err());
    }
    original
        .apply(request(wire::Operation::Validate {}))
        .unwrap();
    original
        .apply(request(wire::Operation::BodyClose {}))
        .unwrap();
    assert!(original.bootstrap.is_none());
    original.credential.as_ref().unwrap().validate().unwrap();
    original
        .apply(request(wire::Operation::CredentialClose {}))
        .unwrap();
    original.drain().unwrap();
    assert!(root.original_entry_absent(Path::new("vault")).unwrap());
}
#[test]
fn actual_absent_body_worker_keeps_same_credential_while_kernel_is_busy_and_closes_ordered() {
    let (_temporary, root, mut original) = fixture();
    let other = NativeNodeDataState::capture(root).unwrap();
    let body = other
        .try_shared_lease("opensesame:vault-body:new-selected")
        .unwrap()
        .unwrap();
    original
        .apply(request(wire::Operation::CredentialTry {}))
        .unwrap();
    assert!(matches!(
        original.apply(selected()).unwrap().0,
        wire::Reply::Available { acquired: false }
    ));
    assert!(original.bootstrap.is_none());
    assert!(other.try_credential_writer().unwrap().is_none());
    original.credential.as_ref().unwrap().validate().unwrap();
    drop(body);
    assert!(matches!(
        original.apply(selected()).unwrap().0,
        wire::Reply::Available { acquired: true }
    ));
    assert!(other
        .try_exclusive_lease("opensesame:vault-body:new-selected")
        .unwrap()
        .is_none());
    original
        .apply(request(wire::Operation::BodyClose {}))
        .unwrap();
    other
        .try_exclusive_lease("opensesame:vault-body:new-selected")
        .unwrap()
        .unwrap();
    assert!(other.try_credential_writer().unwrap().is_none());
    original
        .apply(request(wire::Operation::CredentialClose {}))
        .unwrap();
    other.try_credential_writer().unwrap().unwrap();
    original.drain().unwrap();
}
#[test]
fn actual_present_tomb_worker_uses_writer_and_absence_command_cannot_change_mode() {
    let (_temporary, root, mut original) = fixture();
    root.create_child(Path::new("origin-files")).unwrap();
    root.create_child(Path::new("vault"))
        .unwrap()
        .create_child(Path::new("new-selected"))
        .unwrap();
    original
        .apply(request(wire::Operation::CredentialTry {}))
        .unwrap();
    assert!(matches!(
        original.apply(selected()).unwrap().0,
        wire::Reply::Available { acquired: true }
    ));
    assert!(original.bootstrap.is_none());
    original.writer().unwrap().validate().unwrap();
    assert!(original
        .apply(request(wire::Operation::BootstrapDestinationAbsent {}))
        .is_err());
    assert!(matches!(
        original
            .apply(request(wire::Operation::ReadGeneration {}))
            .unwrap()
            .0,
        wire::Reply::Bytes { base64: None }
    ));
    original
        .apply(request(wire::Operation::BodyClose {}))
        .unwrap();
    original.drain().unwrap();
}
#[test]
fn actual_strict_bootstrap_protocol_failure_drains_both_original_kernels_without_metadata_promotion(
) {
    let (_temporary, root, original) = fixture();
    let state = Arc::clone(&original.state);
    let mut input = Vec::new();
    for text in [
        r#"{"v":1,"op":{"kind":"credential_try"}}"#,
        r#"{"v":1,"op":{"kind":"body_or_bootstrap_try","tomb":"new-selected"}}"#,
        r#"{"v":1,"op":{"kind":"bootstrap_destination_absent","held":true}}"#,
    ] {
        framing::write(&mut input, text.as_bytes()).unwrap();
    }
    let mut output = Vec::new();
    assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut output).is_err());
    let mut replies = output.as_slice();
    for _ in 0..2 {
        let frame = framing::read(&mut replies).unwrap().unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(reply["reply"]["kind"], "available");
        assert_eq!(reply["reply"]["acquired"], true);
    }
    assert!(framing::read(&mut replies).unwrap().is_none());
    assert!(state.validate().is_err());
    assert!(root.original_entry_absent(Path::new("vault")).unwrap());
    let successor = NativeNodeDataState::capture(root).unwrap();
    let credential = successor.try_credential_writer().unwrap().unwrap();
    credential
        .try_capture_bootstrap_lease("new-selected")
        .unwrap()
        .unwrap();
    for field in ["held", "exists", "owner", "mode"] {
        let text = format!(
            r#"{{"v":1,"op":{{"kind":"body_or_bootstrap_try","tomb":"new-selected","{field}":true}}}}"#
        );
        assert!(serde_json::from_str::<wire::Request>(&text).is_err());
    }
}
