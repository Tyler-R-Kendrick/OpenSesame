//! Native fixtures use real credential AEAD/MAC and the original issuer, never a proof factory.
use super::*;
use opensesame_human_vault::root_protection::{
    init_versioned_key_file, prepare_native_factor_configuration, seal_manifest_auth,
    unlock_key_file_with_password, write_key_file, AuthenticatedLegacyGates, KEY_FILE_NAME,
};
use opensesame_human_vault::wrap_vrk_with_password;
use std::fs;
use std::os::unix::fs::PermissionsExt;

const PASSWORD: &[u8] = b"actual native private owner credential";

fn fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    RootProtectionManifest,
    VaultRootKey,
) {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let (_, manifest) = init_versioned_key_file(&root, PASSWORD).unwrap();
    let (_, _, key) = unlock_key_file_with_password(&root, PASSWORD).unwrap();
    (temporary, root, manifest, key)
}

fn persist(root: &Path, key: &VaultRootKey, manifest: &mut RootProtectionManifest) {
    manifest.factor_configuration = Some(prepare_native_factor_configuration(manifest).unwrap());
    seal_manifest_auth(key, manifest).unwrap();
    verify_manifest_auth(key, manifest).unwrap();
    write_key_file(root, &KeyFileContents::Manifest(manifest.clone())).unwrap();
}

#[test]
fn actual_native_current_password_and_private_origin_produce_only_public_policy_metadata() {
    let (_temporary, root, manifest, _) = fixture();
    let view = super::super::inspect_native_retired_policy(&root, PASSWORD).unwrap();
    assert_eq!(view.vault_id, manifest.vault_id);
    assert_eq!(view.root_key_id, manifest.root_key_id);
    assert_eq!(view.root_epoch, manifest.root_epoch);
    assert_eq!(view.revision, manifest.revision);
    assert_eq!(
        Some(view.selected_protector_id),
        manifest.preferred_protector_id
    );
    assert!(super::super::inspect_native_retired_policy(&root, b"wrong actual password").is_err());
    crate::store_lock::StoreLock::exclusive(&root).unwrap();
}

#[test]
fn genuinely_maced_unsupported_selected_status_gate_and_purpose_profiles_refuse() {
    let (_temporary, root, original, key) = fixture();
    let mut cases = Vec::new();
    let mut changed = original.clone();
    changed.preferred_protector_id = None;
    cases.push(changed);
    let mut changed = original.clone();
    changed.preferred_protector_id = Some("other-current-path".into());
    cases.push(changed);
    for status in [ProofStatus::Stale, ProofStatus::Untested] {
        let mut changed = original.clone();
        let ProtectionRecord::Password { proof_status, .. } = &mut changed.records[0] else {
            panic!("native password fixture");
        };
        *proof_status = status;
        cases.push(changed);
    }
    for gate in 0..4 {
        let mut changed = original.clone();
        changed.legacy_gates = Some(AuthenticatedLegacyGates {
            totp_enrolled: gate == 0,
            email_enrolled: gate == 1,
            sms_enrolled: gate == 2,
            recovery_codes_enrolled: gate == 3,
        });
        cases.push(changed);
    }
    let mut changed = original.clone();
    changed.purpose = ProtectionPurpose::WorkloadRoot;
    cases.push(changed);
    let mut changed = original.clone();
    changed.root_epoch = 0;
    cases.push(changed);
    for mut changed in cases {
        persist(&root, &key, &mut changed);
        // Existing primary-only API cryptographically opens it: our refusal is policy-specific.
        unlock_key_file_with_password(&root, PASSWORD).unwrap();
        assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
    }
    let mut all_false = original;
    all_false.legacy_gates = Some(AuthenticatedLegacyGates {
        totp_enrolled: false,
        email_enrolled: false,
        sms_enrolled: false,
        recovery_codes_enrolled: false,
    });
    persist(&root, &key, &mut all_false);
    super::super::inspect_native_retired_policy(&root, PASSWORD).unwrap();
}

#[test]
fn unsigned_legacy_and_signed_unbound_are_not_fresh_retired_owner_admission() {
    let (_temporary, root, mut manifest, key) = fixture();
    let legacy = wrap_vrk_with_password(PASSWORD, &key).unwrap();
    write_key_file(&root, &KeyFileContents::Legacy(legacy)).unwrap();
    unlock_key_file_with_password(&root, PASSWORD).unwrap();
    assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
    manifest.factor_configuration = None;
    seal_manifest_auth(&key, &mut manifest).unwrap();
    write_key_file(&root, &KeyFileContents::Manifest(manifest)).unwrap();
    unlock_key_file_with_password(&root, PASSWORD).unwrap();
    assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
}

#[test]
fn actual_additional_password_or_recovery_paths_require_a_supported_policy_extension() {
    let (_temporary, root, mut manifest, key) = fixture();
    let mut additional = manifest.records[0].clone();
    let ProtectionRecord::Password { protector_id, .. } = &mut additional else {
        panic!("native password fixture");
    };
    *protector_id = "additional-native-password".into();
    manifest.records.push(additional);
    persist(&root, &key, &mut manifest);
    unlock_key_file_with_password(&root, PASSWORD).unwrap();
    assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
    manifest.records.truncate(1);
    persist(&root, &key, &mut manifest);
    opensesame_human_vault::root_protection::protect_add_recovery(&root, PASSWORD).unwrap();
    unlock_key_file_with_password(&root, PASSWORD).unwrap();
    assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
}

#[test]
fn actual_generation_replacement_invalidates_a_held_private_owner_before_any_next_action() {
    let (_temporary, root, _, _) = fixture();
    let mut owner = NativeOwner::admit(&root, PASSWORD).unwrap();
    let keyfile_before = fs::read(root.join(KEY_FILE_NAME)).unwrap();
    // Genuine low-level producer deliberately bypasses ordinary OS locking to exercise the guard.
    init_versioned_key_file(&root, PASSWORD).unwrap();
    assert_ne!(fs::read(root.join(KEY_FILE_NAME)).unwrap(), keyfile_before);
    assert!(owner.view().is_err());
    drop(owner);
    super::super::inspect_native_retired_policy(&root, PASSWORD).unwrap();
}

#[test]
fn malformed_current_mac_or_actual_physical_profile_never_returns_owner_metadata() {
    let (_temporary, root, mut manifest, _) = fixture();
    manifest.auth_b64 = Some("invalid actual root MAC".into());
    write_key_file(&root, &KeyFileContents::Manifest(manifest)).unwrap();
    assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
    init_versioned_key_file(&root, PASSWORD).unwrap();
    let path = root.join(KEY_FILE_NAME);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(super::super::inspect_native_retired_policy(&root, PASSWORD).is_err());
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
}
