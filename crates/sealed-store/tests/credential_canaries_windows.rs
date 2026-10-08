//! Phase-two actual Windows detector tests; not applied or executed yet.
#![cfg(windows)]
use opensesame_human_vault::{
    credential_canaries::{ArtifactKind, Phase},
    windows_io,
};
use opensesame_sealed_store as store_api;
use opensesame_sealed_store::credential_canaries::{
    clear_events, create, export_validator, issuer, observe, receiver, remove, status, validator,
};
use std::{path::Path, process::Command};
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

use opensesame_human_vault::credential_canaries::{
    receiver::{acknowledge, Provision},
    Decision,
};
use opensesame_sealed_store::{init_store, init_store_key, unlock_store_key, StoreError};

mod observation_vector {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../human-vault/tests/support/credential_observation_vector.rs"
    ));
}
fn provision() -> Provision {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
    ))
    .unwrap();
    serde_json::from_value(observation_vector::provision_json(&vectors)).unwrap()
}

fn store() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    init_store_key(dir.path(), b"current owner").unwrap();
    dir
}
#[test]
fn detection_observes_without_owner_root_and_reloads_private_state() {
    let dir = store();
    let root = dir.path();
    let real_before = std::fs::read(root.join(".opensesame-key")).unwrap();
    assert!(create(root, b"wrong owner", ArtifactKind::McpConfiguration).is_err());
    assert!(!root.join(".opensesame-observation-device-key.v1").exists());
    let artifact = create(root, b"current owner", ArtifactKind::McpConfiguration).unwrap();
    let observed = observe(root, &artifact.id, &artifact.presented_id, Phase::Connected).unwrap();
    assert!(matches!(observed.decision, Decision::Canary { .. }));
    assert!(observed.event.is_some());
    let metadata = status(root, b"current owner").unwrap();
    assert_eq!(metadata["events"].as_array().unwrap().len(), 1);
    assert!(!metadata.to_string().contains(&artifact.presented_id));
    assert!(!metadata.to_string().contains("digestB64"));
    assert!(unlock_store_key(root, artifact.presented_id.as_bytes()).is_err());
    assert_eq!(
        std::fs::read(root.join(".opensesame-key")).unwrap(),
        real_before
    );
    let protected = std::fs::read(root.join(".opensesame-credential-canaries.v1")).unwrap();
    assert!(!String::from_utf8(protected).unwrap().contains(&artifact.id));
    // Public confined reader rejects a broad ACL, reparse node or hardlinked key.
    let sealed_key = windows_io::read_bounded(
        root,
        Path::new(".opensesame-observation-device-key.v1"),
        opensesame_human_vault::windows_publish::detector_key::MAX_SEALED_KEY_BYTES,
    )
    .unwrap();
    assert!(sealed_key.starts_with(b"OSDK\0\x01") && sealed_key.len() > 32);
    remove(root, b"current owner", &artifact.id).unwrap();
    assert!(observe(root, &artifact.id, &artifact.presented_id, Phase::Invoked).is_err());
    clear_events(root, b"current owner").unwrap();
    assert!(status(root, b"current owner").unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn detector_copy_corruption_and_writer_races_fail_closed() {
    let first = store();
    let second = store();
    let artifact = create(first.path(), b"current owner", ArtifactKind::ConnectionRef).unwrap();
    create(second.path(), b"current owner", ArtifactKind::ConnectionRef).unwrap();
    std::fs::copy(
        first.path().join(".opensesame-credential-canaries.v1"),
        second.path().join(".opensesame-credential-canaries.v1"),
    )
    .unwrap();
    assert!(status(second.path(), b"current owner").is_err());
    let lock = windows_io::lock(first.path(), Path::new(".opensesame-lock"), true).unwrap();
    assert!(observe(
        first.path(),
        &artifact.id,
        &artifact.presented_id,
        Phase::Invoked
    )
    .is_err());
    drop(lock);
    std::fs::write(
        first.path().join(".opensesame-credential-canaries.v1"),
        b"corrupt",
    )
    .unwrap();
    assert!(observe(
        first.path(),
        &artifact.id,
        &artifact.presented_id,
        Phase::Invoked
    )
    .is_err());
}
#[test]
fn receiver_test_authentication_revocation_and_unlocked_transport_are_real() {
    let dir = store();
    let root = dir.path();
    let mut provision = provision();
    provision.expires_at = (chrono::Utc::now() + chrono::Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    receiver::configure(
        root,
        b"current owner",
        &serde_json::to_string(&provision).unwrap(),
    )
    .unwrap();
    assert!(receiver::enable(root, b"current owner", true).is_err());
    let id = receiver::test(root, b"current owner").unwrap().unwrap();
    let reservation = receiver::reserve(root, Some(&id), true).unwrap().unwrap();
    let request = receiver::begin_dispatch(root, &reservation, |destination, body| {
        assert_eq!(
            destination,
            "https://receiver.example/v1/credential-observations"
        );
        assert!(!body.contains("current owner"));
        Ok(body.to_owned())
    })
    .unwrap()
    .unwrap();
    assert!(!request.is_empty());
    // The actual network wait happens after begin_dispatch returns; no root lock remains.
    let lock = windows_io::lock(root, Path::new(".opensesame-lock"), true).unwrap();
    drop(lock);
    let ack = acknowledge(&reservation.packet, &provision, chrono::Utc::now()).unwrap();
    assert!(receiver::finish(
        root,
        &reservation,
        Some(&serde_json::to_string(&ack).unwrap())
    )
    .unwrap());
    receiver::enable(root, b"current owner", true).unwrap();
    let artifact = create(root, b"current owner", ArtifactKind::McpConfiguration).unwrap();
    observe(root, &artifact.id, &artifact.presented_id, Phase::Connected).unwrap();
    let pending = receiver::reserve(root, None, false).unwrap().unwrap();
    receiver::remove(root, b"current owner").unwrap();
    assert!(receiver::begin_dispatch(root, &pending, |_, _| Ok(()))
        .unwrap()
        .is_none());
    assert!(
        !receiver::finish(root, &pending, Some(&serde_json::to_string(&ack).unwrap())).unwrap()
    );
    assert!(status(root, b"current owner").unwrap()["receiver"].is_null());
}

#[test]
fn password_observation_queues_independently_without_changing_retired_admission() {
    use opensesame_human_vault::retired_credentials::Response;
    let dir = store();
    let root = dir.path();
    let mut provision = provision();
    provision.expires_at = (chrono::Utc::now() + chrono::Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    receiver::configure(
        root,
        b"current owner",
        &serde_json::to_string(&provision).unwrap(),
    )
    .unwrap();
    let id = receiver::test(root, b"current owner").unwrap().unwrap();
    let reserved = receiver::reserve(root, Some(&id), true).unwrap().unwrap();
    let ack = acknowledge(&reserved.packet, &provision, chrono::Utc::now()).unwrap();
    assert!(
        receiver::finish(root, &reserved, Some(&serde_json::to_string(&ack).unwrap())).unwrap()
    );
    receiver::enable(root, b"current owner", true).unwrap();
    store_api::retired_credentials::enroll_retired_password(
        root,
        b"current owner",
        b"historical only",
        Response::SyntheticDecoy,
    )
    .unwrap();
    assert!(matches!(
        store_api::retired_credentials::admit_store_read(root, b"historical only").unwrap(),
        store_api::retired_credentials::ReadAdmission::Synthetic(_)
    ));
    assert_eq!(receiver::outbox_status(root).unwrap()["queued"], 1);
    std::fs::write(
        root.join(".opensesame-credential-canaries.v1"),
        b"corrupt optional telemetry",
    )
    .unwrap();
    assert!(matches!(
        store_api::retired_credentials::admit_store_read(root, b"historical only").unwrap(),
        store_api::retired_credentials::ReadAdmission::Synthetic(_)
    ));
    assert_eq!(
        store_api::retired_credentials::retired_records_for_owner(root, b"current owner")
            .unwrap()
            .events
            .len(),
        2
    );
    assert!(unlock_store_key(root, b"current owner").is_ok());
    assert!(unlock_store_key(root, b"historical only").is_err());
}

#[test]
fn issued_provider_cannot_commit_after_owner_manifest_rotates_away_and_back() {
    struct Provider<'a> {
        root: &'a Path,
        artifact: opensesame_human_vault::credential_canaries::Artifact,
        completed_rewraps: std::cell::Cell<usize>,
    }
    impl issuer::TrustedIssuerProvider for Provider<'_> {
        fn retire_authenticated(
            &self,
            _: &str,
            identity: &str,
        ) -> Result<opensesame_human_vault::credential_canaries::Artifact, StoreError> {
            assert_eq!(identity, self.artifact.context.vault_identity);
            // Both real writes acquire the same edit lock. Host transport retained no root lock.
            store_api::protect_rewrap_store_password(
                self.root,
                b"current owner",
                b"temporary owner",
            )?;
            self.completed_rewraps.set(1);
            store_api::protect_rewrap_store_password(
                self.root,
                b"temporary owner",
                b"current owner",
            )?;
            self.completed_rewraps.set(2);
            Ok(self.artifact.clone())
        }
    }
    let dir = store();
    let root = dir.path();
    let opensesame_human_vault::root_protection::KeyFileContents::Manifest(manifest) =
        opensesame_human_vault::root_protection::load_key_file(root).unwrap()
    else {
        panic!("missing manifest")
    };
    let mut registry =
        opensesame_human_vault::credential_canaries::Registry::new("issuer", &manifest.vault_id);
    let context = opensesame_human_vault::credential_canaries::ArtifactContext {
        vault_identity: manifest.vault_id,
        kind: ArtifactKind::ConnectionRef,
        generation: 1,
    };
    let artifact = registry
        .register_verified_retired(
            &context,
            &opensesame_human_vault::credential_canaries::mint_presented_id(),
            &now(),
        )
        .unwrap();
    let id = artifact.id.clone();
    let provider = Provider {
        root,
        artifact,
        completed_rewraps: std::cell::Cell::new(0),
    };
    let result = issuer::retire_issued(root, b"current owner", &id, &provider);
    assert!(result.is_err());
    assert_eq!(provider.completed_rewraps.get(), 2);
    assert!(matches!(
        result,
        Err(StoreError::Other(message)) if message == "original issuer context changed"
    ));
    assert!(status(root, b"current owner").unwrap()["artifacts"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn authentic_testing_ack_does_not_verify_after_original_owner_manifest_changes() {
    let dir = store();
    let root = dir.path();
    let mut provision = provision();
    provision.expires_at = (chrono::Utc::now() + chrono::Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    receiver::configure(
        root,
        b"current owner",
        &serde_json::to_string(&provision).unwrap(),
    )
    .unwrap();
    let id = receiver::test(root, b"current owner").unwrap().unwrap();
    let reserved = receiver::reserve(root, Some(&id), true).unwrap().unwrap();
    let ack = serde_json::to_string(
        &acknowledge(&reserved.packet, &provision, chrono::Utc::now()).unwrap(),
    )
    .unwrap();
    store_api::protect_rewrap_store_password(root, b"current owner", b"temporary owner").unwrap();
    store_api::protect_rewrap_store_password(root, b"temporary owner", b"current owner").unwrap();
    assert!(
        receiver::begin_dispatch(root, &reserved, |_, _| -> Result<(), StoreError> {
            panic!("stale original owner reached transport")
        })
        .unwrap()
        .is_none()
    );
    assert!(!receiver::finish(root, &reserved, Some(&ack)).unwrap());
    assert_eq!(
        status(root, b"current owner").unwrap()["receiver"]["verified"],
        false
    );
    assert!(receiver::enable(root, b"current owner", true).is_err());
}

#[path = "credential_canaries_windows/security.rs"]
mod security;

#[path = "credential_canaries_windows/dpapi_security.rs"]
mod dpapi_security;
