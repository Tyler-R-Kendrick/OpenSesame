//! Actual Unix standalone detector persistence and authority controls.
#![cfg(unix)]

use opensesame_human_vault::credential_canaries::{
    ArtifactKind, Registry, ValidatorBinding, MAX_REGISTRY_BYTES,
};
use opensesame_sealed_store::{
    credential_canaries::{self as canaries, validator},
    init_store, init_store_key, unlock_store_key, Entry,
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::Path,
};

const RECORD: &str = ".opensesame-installed-canary-validator.v1";
const REQUEST: &str = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"canary.status","arguments":{}}}"#;
const WRONG_TOKEN: &str = "oscanary:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn private_directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

fn binding() -> (ValidatorBinding, String) {
    let mut registry = Registry::new("generated-detector", "generated-vault");
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let artifact = registry
        .create(ArtifactKind::McpConfiguration, &at)
        .unwrap();
    let binding =
        ValidatorBinding::from_artifact(&registry.artifacts[0], &artifact.presented_id).unwrap();
    (binding, artifact.presented_id)
}

fn metadata(directory: &Path, binding: &ValidatorBinding) -> Value {
    serde_json::from_str(&validator::status(directory, &binding.validator_id).unwrap()).unwrap()
}

fn owner_store() -> tempfile::TempDir {
    let owner = private_directory();
    let store = init_store(owner.path(), &[]).unwrap();
    let key = init_store_key(owner.path(), b"generated current owner").unwrap();
    store
        .insert(
            "Owner/private",
            &Entry::parse("generated owner-only entry\n"),
            &key,
        )
        .unwrap();
    owner
}

fn assert_owner_preserved(directory: &Path, token: &str, key_before: &[u8], body_before: &[u8]) {
    assert!(unlock_store_key(directory, token.as_bytes()).is_err());
    let key = unlock_store_key(directory, b"generated current owner").unwrap();
    assert!(init_store(directory, &[])
        .unwrap()
        .show("Owner/private", &key)
        .unwrap()
        .render()
        .contains("generated owner-only entry"));
    assert_eq!(
        fs::read(directory.join("Owner/private.osseal")).unwrap(),
        body_before
    );
    assert_eq!(
        fs::read(directory.join(".opensesame-key")).unwrap(),
        key_before
    );
}

fn assert_request_denials(directory: &Path, binding: &ValidatorBinding, token: &str) {
    let installed_before = fs::read(directory.join(RECORD)).unwrap();
    for (expected, token, request) in [
        (binding.validator_id.as_str(), WRONG_TOKEN, REQUEST),
        ("00000000-0000-4000-8000-000000000000", token, REQUEST),
        (binding.validator_id.as_str(), token, "not JSON"),
        (
            binding.validator_id.as_str(),
            token,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vault.export"}}"#,
        ),
    ] {
        assert!(validator::handle(directory, expected, token, request).is_err());
        assert_eq!(fs::read(directory.join(RECORD)).unwrap(), installed_before);
    }
}

#[test]
fn owner_exported_detector_remains_rootless_and_persists_only_synthetic_evidence() {
    let owner = owner_store();
    let real_before = fs::read(owner.path().join(".opensesame-key")).unwrap();
    let body_before = fs::read(owner.path().join("Owner/private.osseal")).unwrap();
    let artifact = canaries::create(
        owner.path(),
        b"generated current owner",
        ArtifactKind::McpConfiguration,
    )
    .unwrap();
    assert!(canaries::export_validator(
        owner.path(),
        b"wrong generated owner",
        &artifact.id,
        &artifact.presented_id,
    )
    .is_err());
    let binding = canaries::export_validator(
        owner.path(),
        b"generated current owner",
        &artifact.id,
        &artifact.presented_id,
    )
    .unwrap();
    let detector = private_directory();
    let raw = serde_json::to_string(&binding).unwrap();
    assert!(validator::install(detector.path(), &raw, false).unwrap() == binding);
    canaries::remove(owner.path(), b"generated current owner", &artifact.id).unwrap();
    assert!(validator::install(detector.path(), &raw, false).is_err());
    assert_request_denials(detector.path(), &binding, &artifact.presented_id);
    assert!(validator::handle(
        detector.path(),
        &binding.validator_id,
        &artifact.presented_id,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    )
    .unwrap()
    .is_none());
    let response = validator::handle(
        detector.path(),
        &binding.validator_id,
        &artifact.presented_id,
        REQUEST,
    )
    .unwrap()
    .unwrap();
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], 1);
    let result: Value =
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        result,
        json!({"environment":"synthetic","status":"available"})
    );
    let evidence = metadata(detector.path(), &binding);
    assert_eq!(evidence["events"].as_array().unwrap().len(), 2);
    assert_eq!(evidence["events"][0]["phase"], "connected");
    assert_eq!(evidence["events"][1]["phase"], "invoked");
    assert_eq!(evidence["binding"]["artifactId"], artifact.id);
    assert!(!evidence.to_string().contains(&artifact.presented_id));
    assert!(!evidence.to_string().contains("generated current owner"));
    assert!(!detector.path().join(".opensesame-key").exists());
    assert_eq!(
        fs::metadata(detector.path().join(RECORD))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let durable = fs::read(detector.path().join(RECORD)).unwrap();
    assert!(validator::uninstall(detector.path(), "00000000-0000-4000-8000-000000000000").is_err());
    assert_eq!(fs::read(detector.path().join(RECORD)).unwrap(), durable);
    validator::uninstall(detector.path(), &binding.validator_id).unwrap();
    assert!(!detector.path().join(RECORD).exists());
    assert!(validator::status(detector.path(), &binding.validator_id).is_err());
    assert!(validator::handle(
        detector.path(),
        &binding.validator_id,
        &artifact.presented_id,
        REQUEST
    )
    .is_err());
    assert_owner_preserved(
        owner.path(),
        &artifact.presented_id,
        &real_before,
        &body_before,
    );
}

#[test]
fn explicit_replacement_refreshes_binding_and_refuses_prior_identifier() {
    let detector = private_directory();
    let (first, first_token) = binding();
    let (second, second_token) = binding();
    let first_raw = serde_json::to_string(&first).unwrap();
    let second_raw = serde_json::to_string(&second).unwrap();
    validator::install(detector.path(), &first_raw, false).unwrap();
    validator::handle(detector.path(), &first.validator_id, &first_token, REQUEST).unwrap();
    let before = fs::read(detector.path().join(RECORD)).unwrap();
    assert!(validator::install(detector.path(), &second_raw, false).is_err());
    let mut invalid = second.clone();
    invalid.v = 2;
    assert!(validator::install(
        detector.path(),
        &serde_json::to_string(&invalid).unwrap(),
        true
    )
    .is_err());
    assert_eq!(fs::read(detector.path().join(RECORD)).unwrap(), before);
    validator::install(detector.path(), &second_raw, true).unwrap();
    let current = fs::read(detector.path().join(RECORD)).unwrap();
    assert!(validator::status(detector.path(), &first.validator_id).is_err());
    assert!(
        validator::handle(detector.path(), &first.validator_id, &first_token, REQUEST).is_err()
    );
    assert!(
        validator::handle(detector.path(), &second.validator_id, &first_token, REQUEST).is_err()
    );
    assert_eq!(fs::read(detector.path().join(RECORD)).unwrap(), current);
    assert!(metadata(detector.path(), &second)["events"]
        .as_array()
        .unwrap()
        .is_empty());
    validator::handle(
        detector.path(),
        &second.validator_id,
        &second_token,
        REQUEST,
    )
    .unwrap();
    let evidence = metadata(detector.path(), &second);
    assert_eq!(evidence["events"].as_array().unwrap().len(), 1);
    assert_eq!(evidence["events"][0]["artifactId"], second.artifact_id);
    assert!(!evidence.to_string().contains(&first.artifact_id));
    assert!(!evidence.to_string().contains(&second_token));
    validator::uninstall(detector.path(), &second.validator_id).unwrap();
}

#[test]
fn private_detector_storage_refuses_missing_broad_linked_and_corrupt_records() {
    let detector = private_directory();
    let (binding, token) = binding();
    let raw = serde_json::to_string(&binding).unwrap();
    assert!(validator::status(detector.path(), &binding.validator_id).is_err());
    assert!(validator::uninstall(detector.path(), &binding.validator_id).is_err());
    assert!(validator::handle(detector.path(), &binding.validator_id, &token, REQUEST).is_err());
    fs::set_permissions(detector.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(validator::install(detector.path(), &raw, false).is_err());
    fs::set_permissions(detector.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"generated outside sentinel").unwrap();
    let record = detector.path().join(RECORD);
    symlink(outside.path(), &record).unwrap();
    assert!(validator::install(detector.path(), &raw, true).is_err());
    assert!(validator::uninstall(detector.path(), &binding.validator_id).is_err());
    assert_eq!(
        fs::read(outside.path()).unwrap(),
        b"generated outside sentinel"
    );
    fs::remove_file(&record).unwrap();
    validator::install(detector.path(), &raw, false).unwrap();
    let before = fs::read(&record).unwrap();
    let alias = detector.path().join("generated-hardlink");
    fs::hard_link(&record, &alias).unwrap();
    assert!(validator::handle(detector.path(), &binding.validator_id, &token, REQUEST).is_err());
    assert!(validator::status(detector.path(), &binding.validator_id).is_err());
    assert!(validator::uninstall(detector.path(), &binding.validator_id).is_err());
    assert!(validator::install(detector.path(), &raw, true).is_err());
    assert_eq!(fs::read(&alias).unwrap(), before);
    fs::remove_file(alias).unwrap();
    fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(validator::status(detector.path(), &binding.validator_id).is_err());
    assert_eq!(fs::read(&record).unwrap(), before);
    fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
    let parent = private_directory();
    let directory_link = parent.path().join("detector-link");
    symlink(detector.path(), &directory_link).unwrap();
    assert!(validator::install(&directory_link, &raw, true).is_err());
    assert!(validator::handle(&directory_link, &binding.validator_id, &token, REQUEST).is_err());
    assert_eq!(fs::read(&record).unwrap(), before);
    for malformed in [vec![0xff], vec![b'x'; MAX_REGISTRY_BYTES + 1]] {
        fs::write(&record, &malformed).unwrap();
        assert!(
            validator::handle(detector.path(), &binding.validator_id, &token, REQUEST).is_err()
        );
        assert!(validator::status(detector.path(), &binding.validator_id).is_err());
        assert!(validator::uninstall(detector.path(), &binding.validator_id).is_err());
        assert_eq!(fs::read(&record).unwrap(), malformed);
    }
}
