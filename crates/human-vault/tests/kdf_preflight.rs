#![cfg(not(target_arch = "wasm32"))]

use opensesame_human_vault::{
    kdf_policy::{KdfPolicy, OfflineMigrationBudget},
    migrate_password_wrapper_offline, unwrap_vrk_with_password, wrap_vrk_with_password,
    PasswordWrapper, VaultCryptoError, VaultRootKey,
};

#[test]
fn malformed_wrapper_shape_is_rejected_before_expensive_work() {
    let (m, t, p) = KdfPolicy::current_platform().ceilings();
    let wrapper = PasswordWrapper {
        salt: "A".repeat(24),
        params_m_kib: m,
        params_t: t,
        params_p: p,
        wrapped_vrk: "A".repeat(64),
        nonce: String::new(),
    };
    assert!(matches!(
        unwrap_vrk_with_password(b"unused", &wrapper),
        Err(VaultCryptoError::NonceLength)
    ));
    // Source-order oracle: no malformed wrapper reaches allocation/hash after refactoring.
    let source = include_str!("../src/password_wrap.rs");
    let admitted = source.split("fn unwrap_admitted(").nth(1).unwrap();
    assert!(admitted.find("decode_nonce(").unwrap() < admitted.find("Params::new(").unwrap());
    assert!(admitted.find("wrapped_bytes.len()").unwrap() < admitted.find("Params::new(").unwrap());
}

#[test]
fn explicit_offline_migration_preserves_key_and_writer_floor() {
    let key = VaultRootKey::generate();
    let wrapper = wrap_vrk_with_password(b"offline-password", &key).unwrap();
    let budget = OfflineMigrationBudget::after_user_confirmation(64 * 1024, 3, true).unwrap();
    let migrated =
        migrate_password_wrapper_offline(b"offline-password", &wrapper, &budget).unwrap();
    assert_eq!(
        (migrated.params_m_kib, migrated.params_t, migrated.params_p),
        (64 * 1024, 3, 1)
    );
    assert_eq!(
        unwrap_vrk_with_password(b"offline-password", &migrated)
            .unwrap()
            .0,
        key.0
    );
}
