//! Real protected-file/context and current-owner adapter regressions.
//! Controlled provider and logical engine timestamps are explicit test fixtures.

mod observation_vector {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../human-vault/tests/support/credential_observation_vector.rs"
    ));
}
use super::*;
use opensesame_human_vault::{
    credential_canaries::{
        receiver::{acknowledge, Provision},
        Artifact, ArtifactContext, DeviceState, Registry,
    },
    root_protection::{load_key_file, KeyFileContents},
    EncryptedEnvelope,
};
use std::cell::Cell;

const OWNER: &[u8] = b"current owner";
const DEVICE_KEY: &str = ".opensesame-observation-device-key.v1";
const DEVICE_STATE: &str = ".opensesame-credential-canaries.v1";
const ROOT_KEY: &str = ".opensesame-key";

fn store() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    crate::init_store(dir.path(), &[]).unwrap();
    crate::init_store_key(dir.path(), OWNER).unwrap();
    dir
}
fn manifest(root: &Path) -> opensesame_human_vault::root_protection::RootProtectionManifest {
    let KeyFileContents::Manifest(manifest) = load_key_file(root).unwrap() else {
        panic!("genuine protected manifest required")
    };
    manifest
}
fn state(root: &Path) -> DeviceState {
    let _lock = StoreLock::key_file_edit(root).unwrap();
    storage::ProtectedState::read(root, false).unwrap().state
}
fn provision() -> Provision {
    let vector: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
    )))
    .unwrap();
    let mut provision: Provision =
        serde_json::from_value(observation_vector::provision_json(&vector)).unwrap();
    provision.expires_at = (chrono::Utc::now() + chrono::Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    provision
}

#[test]
fn detector_key_and_ciphertext_copy_cannot_cross_authoritative_root_context() {
    let first = store();
    let second = store();
    let a = first.path();
    let b = second.path();
    let original_a = std::fs::read(a.join(ROOT_KEY)).unwrap();
    let original_b = std::fs::read(b.join(ROOT_KEY)).unwrap();
    let identity_a = manifest(a).vault_id;
    let identity_b = manifest(b).vault_id;
    assert_ne!(identity_a, identity_b);
    let artifact = create(a, OWNER, ArtifactKind::ConnectionRef).unwrap();
    let second_artifact = create(b, OWNER, ArtifactKind::ConnectionRef).unwrap();
    assert_eq!(artifact.context.vault_identity, identity_a);
    assert_eq!(second_artifact.context.vault_identity, identity_b);
    let event = observe(a, &artifact.id, &artifact.presented_id, Phase::Connected)
        .unwrap()
        .event
        .unwrap();
    assert_eq!(event.vault_identity, identity_a);
    assert_eq!(
        status(a, OWNER).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let sealed_a: EncryptedEnvelope =
        serde_json::from_slice(&std::fs::read(a.join(DEVICE_STATE)).unwrap()).unwrap();
    assert_eq!(sealed_a.ad.project_id, identity_a);
    // Copy the correct independent key too: rejection must be context, not wrong-key AEAD.
    std::fs::copy(a.join(DEVICE_KEY), b.join(DEVICE_KEY)).unwrap();
    std::fs::copy(a.join(DEVICE_STATE), b.join(DEVICE_STATE)).unwrap();
    let copied_key = std::fs::read(b.join(DEVICE_KEY)).unwrap();
    let copied_state = std::fs::read(b.join(DEVICE_STATE)).unwrap();
    assert!(status(b, OWNER).is_err());
    assert!(observe(b, &artifact.id, &artifact.presented_id, Phase::Invoked).is_err());
    assert_eq!(std::fs::read(b.join(DEVICE_KEY)).unwrap(), copied_key);
    assert_eq!(std::fs::read(b.join(DEVICE_STATE)).unwrap(), copied_state);
    assert_eq!(std::fs::read(a.join(ROOT_KEY)).unwrap(), original_a);
    assert_eq!(std::fs::read(b.join(ROOT_KEY)).unwrap(), original_b);
    assert_eq!(
        status(a, OWNER).unwrap()["artifacts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(crate::unlock_store_key(a, artifact.presented_id.as_bytes()).is_err());
    assert!(crate::unlock_store_key(b, artifact.presented_id.as_bytes()).is_err());
}

#[test]
fn detection_and_existing_state_cannot_generate_a_missing_device_key() {
    let dir = store();
    let root = dir.path();
    let real_root = std::fs::read(root.join(ROOT_KEY)).unwrap();
    assert!(receiver::outbox_status(root).is_err());
    assert!(!root.join(DEVICE_KEY).exists());
    assert!(!root.join(DEVICE_STATE).exists());
    assert!(create(root, b"wrong owner", ArtifactKind::ConnectionRef).is_err());
    assert!(!root.join(DEVICE_KEY).exists());
    let artifact = create(root, OWNER, ArtifactKind::ConnectionRef).unwrap();
    assert_eq!(
        status(root, OWNER).unwrap()["artifacts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let sealed = std::fs::read(root.join(DEVICE_STATE)).unwrap();
    std::fs::remove_file(root.join(DEVICE_KEY)).unwrap();
    assert!(create(root, OWNER, ArtifactKind::ConnectionRef).is_err());
    assert!(observe(root, &artifact.id, &artifact.presented_id, Phase::Invoked).is_err());
    assert!(
        !root.join(DEVICE_KEY).exists(),
        "refusal must not replace the lost key"
    );
    assert_eq!(std::fs::read(root.join(DEVICE_STATE)).unwrap(), sealed);
    assert_eq!(std::fs::read(root.join(ROOT_KEY)).unwrap(), real_root);
    assert!(crate::unlock_store_key(root, OWNER).is_ok());
}

struct ControlledIssuer<'a> {
    root: &'a Path,
    artifact: Artifact,
    calls: Cell<usize>,
}
impl issuer::TrustedIssuerProvider for ControlledIssuer<'_> {
    fn retire_authenticated(&self, id: &str, identity: &str) -> Result<Artifact, StoreError> {
        assert_eq!(id, self.artifact.id);
        assert_eq!(identity, self.artifact.context.vault_identity);
        // The local adapter has released owner/root exclusion before calling its provider.
        let _lock = StoreLock::key_file_edit(self.root)?;
        self.calls.set(self.calls.get() + 1);
        Ok(self.artifact.clone())
    }
}
#[test]
fn unchanged_current_owner_can_import_and_observe_a_trusted_retired_artifact() {
    let dir = store();
    let root = dir.path();
    let real_root = std::fs::read(root.join(ROOT_KEY)).unwrap();
    let identity = manifest(root).vault_id;
    let presented = opensesame_human_vault::credential_canaries::mint_presented_id();
    let context = ArtifactContext {
        vault_identity: identity.clone(),
        kind: ArtifactKind::ConnectionRef,
        generation: 1,
    };
    let artifact = Registry::new("controlled-local-issuer", &identity)
        .register_verified_retired(&context, &presented, &now())
        .unwrap();
    let provider = ControlledIssuer {
        root,
        artifact,
        calls: Cell::new(0),
    };
    let id = provider.artifact.id.clone();
    assert!(issuer::retire_issued(root, b"wrong owner", &id, &provider).is_err());
    assert_eq!(provider.calls.get(), 0);
    assert!(!root.join(DEVICE_KEY).exists());
    issuer::retire_issued(root, OWNER, &id, &provider).unwrap();
    assert_eq!(provider.calls.get(), 1);
    let status = status(root, OWNER).unwrap();
    assert_eq!(status["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(status["artifacts"][0]["id"], id);
    assert_eq!(status["artifacts"][0]["context"]["vaultIdentity"], identity);
    assert!(!status.to_string().contains(&presented));
    assert!(!status.to_string().contains(&provider.artifact.digest_b64));
    let event = observe(root, &id, &presented, Phase::RetiredGenerationObserved)
        .unwrap()
        .event
        .unwrap();
    assert_eq!(event.artifact_id, id);
    assert_eq!(event.vault_identity, identity);
    assert_eq!(event.phase, Phase::RetiredGenerationObserved);
    assert!(crate::unlock_store_key(root, presented.as_bytes()).is_err());
    assert_eq!(std::fs::read(root.join(ROOT_KEY)).unwrap(), real_root);
}

fn prepare_two_owner_tests(root: &Path) -> (String, String) {
    let _lock = StoreLock::key_file_edit(root).unwrap();
    let mut protected = storage::ProtectedState::read(root, false).unwrap();
    let policy = serde_json::to_vec(&manifest(root)).unwrap();
    let now = chrono::Utc::now();
    // Model two genuine engine events across the existing 60-second dedup boundary.
    let first = protected
        .state
        .test_receiver(now - chrono::Duration::seconds(61))
        .unwrap()
        .unwrap();
    protected.state.pin_owner_test(&first, &policy).unwrap();
    let second = protected.state.test_receiver(now).unwrap().unwrap();
    protected.state.pin_owner_test(&second, &policy).unwrap();
    protected.write(root).unwrap();
    (first, second)
}
fn acknowledge_test(root: &Path, id: &str, provision: &Provision) {
    let reservation = receiver::reserve(root, Some(id), true).unwrap().unwrap();
    let packet = receiver::begin_dispatch(root, &reservation, |_, body| Ok(body.to_owned()))
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&packet).unwrap()["packageId"],
        id
    );
    let clear = opensesame_human_vault::credential_canaries::receiver::open(
        &packet,
        provision,
        chrono::Utc::now(),
    )
    .unwrap();
    assert_eq!(clear.vault_identity, manifest(root).vault_id);
    assert!(matches!(
        clear.event,
        opensesame_human_vault::credential_canaries::receiver::ClosedEvent::ReceiverTest
    ));
    let ack = acknowledge(&reservation.packet, provision, chrono::Utc::now()).unwrap();
    let mut wrong_mac = serde_json::to_value(&ack).unwrap();
    let mut altered = ack.mac_b64.clone();
    let replacement = if altered.starts_with('A') { "B" } else { "A" };
    altered.replace_range(0..1, replacement);
    wrong_mac["macB64"] = serde_json::Value::String(altered);
    assert!(!receiver::finish(root, &reservation, Some(&wrong_mac.to_string())).unwrap());
    assert!(state(root)
        .owner_test_witnesses
        .iter()
        .any(|w| w.package_id == id));
    let genuine = serde_json::to_string(&ack).unwrap();
    assert!(receiver::finish(root, &reservation, Some(&genuine)).unwrap());
    assert!(!receiver::finish(root, &reservation, Some(&genuine)).unwrap());
}
#[test]
fn authenticated_ack_removes_its_witness_and_keeps_other_pending_owner_test() {
    let dir = store();
    let root = dir.path();
    let provision = provision();
    receiver::configure(root, OWNER, &serde_json::to_string(&provision).unwrap()).unwrap();
    let (first, second) = prepare_two_owner_tests(root);
    let initial = state(root);
    assert_eq!(initial.owner_test_witnesses.len(), 2);
    let sealed_before: EncryptedEnvelope =
        serde_json::from_slice(&std::fs::read(root.join(DEVICE_STATE)).unwrap()).unwrap();
    acknowledge_test(root, &first, &provision);
    let after_first = state(root);
    assert_eq!(after_first.owner_test_witnesses.len(), 1);
    assert_eq!(after_first.owner_test_witnesses[0].package_id, second);
    assert_eq!(receiver::outbox_status(root).unwrap()["queued"], 1);
    let sealed_after: EncryptedEnvelope =
        serde_json::from_slice(&std::fs::read(root.join(DEVICE_STATE)).unwrap()).unwrap();
    assert_ne!(sealed_before.nonce, sealed_after.nonce);
    acknowledge_test(root, &second, &provision);
    assert!(state(root).owner_test_witnesses.is_empty());
    assert_eq!(receiver::outbox_status(root).unwrap()["queued"], 0);
    receiver::enable(root, OWNER, true).unwrap();
    assert_eq!(status(root, OWNER).unwrap()["receiver"]["verified"], true);
}
