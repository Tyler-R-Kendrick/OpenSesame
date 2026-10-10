//! Genuine kernel lease/retained-filesystem controls. Payload bytes are physical DATA only.
use super::*;
#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use opensesame_human_vault::root_protection::windows_private_files::write_new;
use std::fs;
#[path = "ciphertext_fixture.rs"]
mod ciphertext_fixture;

fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("worker-state");
    #[cfg(windows)]
    let path =
        Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("worker-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([31; 32])).as_bytes(),
    )
    .unwrap();
    root.create_child(Path::new("origin-files")).unwrap();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    let vault = vaults.create_child(Path::new("selected")).unwrap();
    write_new(
        &vault,
        Path::new("opaque.json"),
        b"original physical fixture",
    )
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
    let wire =
        ciphertext_fixture::sealed_generation(&context, b"controlled synthetic generation DATA");
    write_new(&vault, Path::new("opensesame-generation.v1.json"), &wire).unwrap();
    drop(writer);
    drop(credential);
    state.seal().unwrap();
    (temp, root)
}
fn requests(ops: &[&str]) -> Vec<u8> {
    let mut input = Vec::new();
    for op in ops {
        framing::write(&mut input, format!(r#"{{"v":1,"op":{op}}}"#).as_bytes()).unwrap();
    }
    input
}
fn assert_kernel_released(root: Arc<PrivateDirectory>) {
    let successor = NativeNodeDataState::capture(root).unwrap();
    let credential = successor.credential_writer().unwrap();
    credential.capture_existing_writer("selected").unwrap();
}
#[test]
fn actual_worker_retains_ordered_objects_reads_original_data_and_drains_before_final_ack() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    let expected = writer.read_generation_ciphertext().unwrap();
    drop(writer);
    drop(credential);
    let input = requests(&[
        r#"{"kind":"credential"}"#,
        r#"{"kind":"body","tomb":"selected"}"#,
        r#"{"kind":"read_generation"}"#,
        r#"{"kind":"validate"}"#,
        r#"{"kind":"body_close"}"#,
        r#"{"kind":"credential_close"}"#,
        r#"{"kind":"close"}"#,
    ]);
    let mut output = Vec::new();
    serve(Arc::clone(&state), &mut input.as_slice(), &mut output).unwrap();
    assert!(state.validate().is_err());
    let mut received = output.as_slice();
    let mut responses = Vec::new();
    while let Some(bytes) = framing::read(&mut received).unwrap() {
        responses.push(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
    }
    assert_eq!(responses.len(), 7);
    assert_eq!(responses[2]["reply"]["base64"], STANDARD.encode(expected));
    assert_eq!(responses[6]["reply"]["kind"], "ack");
    assert_kernel_released(root);
}
#[test]
fn actual_worker_refuses_body_without_credential_and_never_accepts_a_caller_held_flag() {
    for op in [
        r#"{"kind":"body","tomb":"selected"}"#,
        r#"{"kind":"body","tomb":"selected","held":true}"#,
    ] {
        let (_temp, root) = fixture();
        let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
        let input = requests(&[op]);
        let mut output = Vec::new();
        assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut output).is_err());
        assert!(output.is_empty());
        assert!(state.validate().is_err());
        assert_kernel_released(root);
    }
}
#[test]
fn actual_worker_protocol_failure_with_held_body_seals_and_releases_both_kernel_objects() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let input = requests(&[
        r#"{"kind":"credential"}"#,
        r#"{"kind":"body","tomb":"selected"}"#,
        r#"{"kind":"credential_close"}"#,
    ]);
    let mut output = Vec::new();
    assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut output).is_err());
    assert!(state.validate().is_err());
    assert_kernel_released(root);
}

#[test]
fn worker_has_no_generic_raw_read_and_plaintext_generation_never_egresses() {
    for operation in [
        r#"{"kind":"read","scope":"vault","leaf":"opaque.json","maximum":64}"#,
        r#"{"kind":"read_generation"}"#,
    ] {
        let (_temp, root) = fixture();
        // Exact original private file path isn't exported; mutate through actual retained native writer instead.
        let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
        let credential = state.credential_writer().unwrap();
        let writer = credential.capture_existing_writer("selected").unwrap();
        let original = writer.read_generation_ciphertext().unwrap();
        writer
            .compare_publish(
                NativeNodeDataScope::Vault,
                Path::new("opensesame-generation.v1.json"),
                Some(&original),
                Some(b"private plaintext must never be returned"),
            )
            .unwrap();
        drop(writer);
        drop(credential);
        let input = requests(&[
            r#"{"kind":"credential"}"#,
            r#"{"kind":"body","tomb":"selected"}"#,
            operation,
        ]);
        let mut output = Vec::new();
        assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut output).is_err());
        let mut received = output.as_slice();
        assert!(framing::read(&mut received).unwrap().is_some());
        assert!(framing::read(&mut received).unwrap().is_some());
        assert!(framing::read(&mut received).unwrap().is_none());
        assert!(state.validate().is_err());
        assert_kernel_released(root);
    }
}

#[test]
fn actual_worker_retains_credential_inventory_and_reports_only_verified_absent_retired_slot() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let input = requests(&[
        r#"{"kind":"credential"}"#,
        r#"{"kind":"capture_inventory"}"#,
        r#"{"kind":"inventory_tombs"}"#,
        r#"{"kind":"read_retired","tomb":"selected"}"#,
        r#"{"kind":"inventory_close"}"#,
        r#"{"kind":"credential_close"}"#,
        r#"{"kind":"close"}"#,
    ]);
    let mut output = Vec::new();
    serve(Arc::clone(&state), &mut input.as_slice(), &mut output).unwrap();
    let mut received = output.as_slice();
    let mut replies = Vec::new();
    while let Some(bytes) = framing::read(&mut received).unwrap() {
        replies.push(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
    }
    assert_eq!(replies.len(), 7);
    assert_eq!(
        replies[2]["reply"]["values"],
        serde_json::json!(["selected"])
    );
    assert!(replies[3]["reply"]["base64"].is_null());
    assert!(state.validate().is_err());
    assert_kernel_released(root);
}
#[test]
fn actual_worker_cannot_acknowledge_credential_release_while_inventory_still_owns_it() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let input = requests(&[
        r#"{"kind":"credential"}"#,
        r#"{"kind":"capture_inventory"}"#,
        r#"{"kind":"credential_close"}"#,
    ]);
    let mut output = Vec::new();
    assert!(serve(Arc::clone(&state), &mut input.as_slice(), &mut output).is_err());
    assert!(state.validate().is_err());
    assert_kernel_released(root);
}

#[test]
fn every_empty_worker_command_rejects_unknown_held_metadata() {
    for kind in [
        "credential",
        "read_generation",
        "capture_inventory",
        "inventory_tombs",
        "origin_names",
        "inventory_close",
        "body_close",
        "credential_close",
        "validate",
        "close",
    ] {
        let original = serde_json::json!({"v":1,"op":{"kind":kind}});
        assert!(serde_json::from_value::<wire::Request>(original).is_ok());
        let offered = serde_json::json!({"v":1,"op":{"kind":kind,"held":true}});
        assert!(serde_json::from_value::<wire::Request>(offered).is_err());
    }
}
