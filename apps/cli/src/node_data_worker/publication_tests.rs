//! Genuine kernel/original AEAD publication controls. Inner payload remains synthetic DATA.
use super::*;
#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use opensesame_human_vault::root_protection::windows_private_files::write_new;
#[path = "ciphertext_fixture.rs"]
mod ciphertext_fixture;
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>, Vec<u8>, Vec<u8>) {
    let temp = tempfile::tempdir().unwrap();
    let parent = std::fs::canonicalize(temp.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("publication-worker-state");
    #[cfg(windows)]
    let path = Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap())
        .join("publication-worker-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([31; 32])).as_bytes(),
    )
    .unwrap();
    root.create_child(Path::new("origin-files")).unwrap();
    root.create_child(Path::new("vault"))
        .unwrap()
        .create_child(Path::new("selected"))
        .unwrap();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    let context = serde_json::to_string(&[
        "selected",
        &writer
            .resource_identity(NativeNodeDataScope::Vault)
            .unwrap(),
    ])
    .unwrap();
    let before = ciphertext_fixture::sealed_generation(&context, b"first synthetic DATA");
    let next = ciphertext_fixture::sealed_generation(&context, b"second synthetic DATA");
    writer
        .compare_publish_generation_ciphertext(None, Some(&before))
        .unwrap();
    drop(writer);
    drop(credential);
    state.seal().unwrap();
    (temp, root, before, next)
}
fn requests(operation: serde_json::Value, read: bool) -> Vec<u8> {
    let mut input = Vec::new();
    let mut operations = vec![
        serde_json::json!({"kind":"credential"}),
        serde_json::json!({"kind":"body","tomb":"selected"}),
        operation,
    ];
    if read {
        operations.push(serde_json::json!({"kind":"read_generation"}));
    }
    operations.push(serde_json::json!({"kind":"close"}));
    for op in operations {
        framing::write(
            &mut input,
            &serde_json::to_vec(&serde_json::json!({"v":1,"op":op})).unwrap(),
        )
        .unwrap();
    }
    input
}
fn actual_after(root: Arc<PrivateDirectory>) -> Vec<u8> {
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    writer.read_generation_ciphertext().unwrap()
}
#[test]
fn actual_authenticated_generation_replacement_acknowledges_exact_ciphertext_under_ordered_kernel_objects(
) {
    let (_temp, root, before, next) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let input = requests(
        serde_json::json!({"kind":"publish_generation","expected":STANDARD.encode(&before),"next":STANDARD.encode(&next)}),
        true,
    );
    let mut output = Vec::new();
    serve(Arc::clone(&state), &mut input.as_slice(), &mut output).unwrap();
    let mut received = output.as_slice();
    let mut replies = Vec::new();
    while let Some(bytes) = framing::read(&mut received).unwrap() {
        replies.push(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
    }
    assert_eq!(replies[2]["reply"]["kind"], "ack");
    assert_eq!(replies[3]["reply"]["base64"], STANDARD.encode(&next));
    assert!(state.validate().is_err());
    assert_eq!(actual_after(root), next);
}
#[test]
fn actual_wrong_expected_plaintext_wrong_binding_and_double_absence_refuse_without_ciphertext_effect(
) {
    for kind in 0..4 {
        let (_temp, root, before, next) = fixture();
        let (expected, proposed) = match kind {
            0 => (Some(STANDARD.encode(&next)), Some(STANDARD.encode(&next))),
            1 => (
                Some(STANDARD.encode(&before)),
                Some(STANDARD.encode(b"plaintext forbidden")),
            ),
            2 => (
                Some(STANDARD.encode(&before)),
                Some(STANDARD.encode(ciphertext_fixture::sealed_generation(
                    "other physical context",
                    b"DATA",
                ))),
            ),
            _ => (None, None),
        };
        let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
        let input = requests(
            serde_json::json!({"kind":"publish_generation","expected":expected,"next":proposed}),
            false,
        );
        let mut output = Vec::new();
        assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut output).is_err());
        assert!(state.validate().is_err());
        assert_eq!(actual_after(root), before);
    }
}
#[test]
fn combined_authenticated_ciphertext_input_has_an_explicit_bounded_frame_and_canonical_decoder() {
    assert!(2 * 4 * wire::MAX_DATA_BYTES.div_ceil(3) + 4096 < wire::MAX_FRAME_BYTES);
    assert!(ciphertext_input(Some("YQ".to_string())).is_err());
    assert!(ciphertext_input(Some("YQ==\n".to_string())).is_err());
    assert_eq!(
        ciphertext_input(Some("YQ==".to_string())).unwrap(),
        Some(b"a".to_vec())
    );
    assert!(ciphertext_input(None).unwrap().is_none());
}
