use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;

const SECRET: &str = "tskey-client-customer-canary-0123456789abcdef";

fn connected(dir: &Path, tailnet: &str) -> (AdminStore, TailnetConfig) {
    let store = AdminStore::at(dir);
    let config = store
        .connect(
            tailnet,
            Credential {
                kind: CredentialKind::Oauth,
                client_id: "customerClient".into(),
            },
            &SecretString::from(SECRET.to_owned()),
            7,
        )
        .unwrap();
    (store, config)
}

fn raw(store: &AdminStore) -> String {
    std::fs::read_to_string(store.dir.join(SECRET_FILE)).unwrap()
}

fn unwrap(store: &AdminStore, config: &TailnetConfig, value: &str) -> Vec<u8> {
    let root = hex::decode(
        std::fs::read_to_string(store.dir.join(KEY_FILE))
            .unwrap()
            .trim(),
    )
    .unwrap();
    let key_path = std::fs::canonicalize(&store.dir).unwrap().join(KEY_FILE);
    let local = format!(
        "local-key:{}",
        URL_SAFE_NO_PAD.encode(key_path.as_os_str().as_encoded_bytes())
    );
    let customer = format!(
        "{}:{}{}",
        local.len(),
        local,
        store.namespace(config).unwrap()
    );
    let context = format!("customer:{customer}");
    let info = b"opensesame:event-seal:kek:v2";
    let mut customer_info = info.to_vec();
    customer_info.extend_from_slice(context.as_bytes());
    let mut wrapping = [0; 32];
    Hkdf::<Sha256>::new(None, &root)
        .expand(&customer_info, &mut wrapping)
        .unwrap();
    let mut kek = [0; 32];
    Hkdf::<Sha256>::new(Some(info), &wrapping)
        .expand(PURPOSE.as_bytes(), &mut kek)
        .unwrap();
    let mut aad = info.to_vec();
    aad.extend_from_slice(&(context.len() as u64).to_be_bytes());
    aad.extend_from_slice(context.as_bytes());
    aad.extend_from_slice(PURPOSE.as_bytes());
    let packed = URL_SAFE_NO_PAD
        .decode(value.strip_prefix("osev2.").unwrap())
        .unwrap();
    let dek = XChaCha20Poly1305::new((&kek).into())
        .decrypt(
            XNonce::from_slice(&packed[..24]),
            Payload {
                msg: &packed[24..72],
                aad: &aad,
            },
        )
        .unwrap();
    let plaintext = XChaCha20Poly1305::new(dek.as_slice().into())
        .decrypt(
            XNonce::from_slice(&packed[72..96]),
            Payload {
                msg: &packed[96..],
                aad: &aad,
            },
        )
        .unwrap();
    assert_eq!(plaintext, SECRET.as_bytes());
    dek
}

#[test]
fn fresh_data_keys_and_restart_preserve_only_encrypted_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let (store, config) = connected(dir.path(), "customer-a.example");
    let first = raw(&store);
    assert!(first.starts_with("osev2.") && !first.contains("tskey") && !first.contains("canary"));
    let dek = unwrap(&store, &config, &first);
    let restarted = AdminStore::at(dir.path());
    assert_eq!(restarted.secret(&config).unwrap().expose_secret(), SECRET);
    let (_, next) = connected(dir.path(), "customer-a.example");
    assert_ne!(dek, unwrap(&store, &next, &raw(&store)));
}

#[test]
fn copied_root_and_ciphertext_cannot_move_to_another_local_namespace() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (store, _) = connected(a.path(), "customer-a.example");
    let (other, config) = connected(b.path(), "customer-a.example");
    for name in [KEY_FILE, SECRET_FILE] {
        std::fs::copy(store.dir.join(name), other.dir.join(name)).unwrap();
    }
    assert!(other.secret(&config).is_err());
}

#[test]
fn changing_tailnet_client_kind_or_purpose_refuses_the_credential() {
    let dir = tempfile::tempdir().unwrap();
    let (store, config) = connected(dir.path(), "customer-a.example");
    let mut other = config.clone();
    other.tailnet = "customer-b.example".into();
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&other).unwrap(),
    )
    .unwrap();
    assert!(store.secret(&other).is_err());
    assert!(
        store.secret(&config).is_err(),
        "stale caller configuration cannot select a new credential"
    );
    other = config.clone();
    other.credential.client_id = "otherClient".into();
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&other).unwrap(),
    )
    .unwrap();
    assert!(store.secret(&other).is_err());
    other.credential = Credential {
        kind: CredentialKind::ApiKey,
        client_id: String::new(),
    };
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&other).unwrap(),
    )
    .unwrap();
    assert!(store.secret(&other).is_err());
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let key = LogKey::load(&store.dir.join(KEY_FILE)).unwrap();
    let wrong = key.seal_value(
        &store.namespace(&config).unwrap(),
        "another-purpose",
        SECRET,
    );
    write_private(&store.dir.join(SECRET_FILE), wrong.as_bytes()).unwrap();
    assert!(store.secret(&config).is_err());
}

#[test]
fn tampering_unknown_versions_truncation_and_plaintext_downgrade_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (store, config) = connected(dir.path(), "customer-a.example");
    let original = raw(&store);
    let packed = URL_SAFE_NO_PAD.decode(&original[6..]).unwrap();
    for position in [0, 24, 72, packed.len() - 1] {
        let mut corrupt = packed.clone();
        corrupt[position] ^= 1;
        let value = format!("osev2.{}", URL_SAFE_NO_PAD.encode(corrupt));
        write_private(&store.dir.join(SECRET_FILE), value.as_bytes()).unwrap();
        assert!(store.secret(&config).is_err());
    }
    for value in [
        SECRET,
        "osev2.",
        "osev3.invalid",
        &original[..original.len() - 3],
    ] {
        write_private(&store.dir.join(SECRET_FILE), value.as_bytes()).unwrap();
        assert!(store.secret(&config).is_err());
    }
}

#[test]
fn missing_root_never_mints_a_replacement_for_existing_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let (store, config) = connected(dir.path(), "customer-a.example");
    std::fs::remove_file(store.dir.join(KEY_FILE)).unwrap();
    assert!(store.secret(&config).is_err());
    assert!(!store.dir.join(KEY_FILE).exists());
    assert!(store
        .connect(
            &config.tailnet,
            config.credential.clone(),
            &SecretString::from(SECRET.to_owned()),
            8
        )
        .is_err());
    assert!(!store.dir.join(KEY_FILE).exists());
}

#[test]
fn damaged_marker_and_missing_root_cannot_authorize_reconnect_root_creation() {
    let dir = tempfile::tempdir().unwrap();
    let (store, config) = connected(dir.path(), "customer-a.example");
    std::fs::remove_file(store.dir.join(KEY_FILE)).unwrap();
    for damaged in [SECRET, "Xsev2.damaged", "osev3.damaged", ""] {
        write_private(&store.dir.join(SECRET_FILE), damaged.as_bytes()).unwrap();
        assert!(store
            .connect(
                &config.tailnet,
                config.credential.clone(),
                &SecretString::from(SECRET.to_owned()),
                8
            )
            .is_err());
        assert!(!store.dir.join(KEY_FILE).exists());
    }
}

#[test]
fn validated_private_legacy_config_migrates_once_and_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let store = AdminStore::at(dir.path());
    let config = TailnetConfig {
        v: 1,
        tailnet: "customer-a.example".into(),
        credential: Credential {
            kind: CredentialKind::Oauth,
            client_id: "customerClient".into(),
        },
        connected_at: 7,
    };
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    write_private(&store.dir.join(SECRET_FILE), SECRET.as_bytes()).unwrap();
    assert!(!store.dir.join(KEY_FILE).exists());
    assert_eq!(store.secret(&config).unwrap().expose_secret(), SECRET);
    let current = store.config().unwrap().unwrap();
    assert_eq!(current.v, FILE_VERSION);
    let sealed = raw(&store);
    assert!(sealed.starts_with("osev2."));
    let restarted = AdminStore::at(dir.path());
    assert_eq!(restarted.secret(&current).unwrap().expose_secret(), SECRET);
    assert_eq!(raw(&store), sealed, "migration is idempotent");
}

#[test]
fn api_key_restart_and_cache_context_follow_trusted_connection_and_credential() {
    let dir = tempfile::tempdir().unwrap();
    let store = AdminStore::at(dir.path());
    let kind = Credential {
        kind: CredentialKind::ApiKey,
        client_id: String::new(),
    };
    let value = SecretString::from("tskey-api-runtime-canary-0123456789abcdef".to_owned());
    let first = store.connect("-", kind.clone(), &value, 1).unwrap();
    let (read, first_scope) = store.credential_snapshot(&first).unwrap();
    assert_eq!(read.expose_secret(), value.expose_secret());
    assert!(!raw(&store).contains("runtime-canary"));
    let restarted = AdminStore::at(dir.path());
    assert_eq!(
        restarted.credential_snapshot(&first).unwrap().1,
        first_scope
    );
    let second = store.connect("another.example", kind, &value, 2).unwrap();
    assert!(store.credential_snapshot(&first).is_err());
    assert_ne!(store.credential_snapshot(&second).unwrap().1, first_scope);
}

#[cfg(unix)]
#[test]
fn legacy_plaintext_with_unknown_or_unprotected_provenance_cannot_mint_a_root() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = AdminStore::at(dir.path());
    let config = TailnetConfig {
        v: 1,
        tailnet: "customer-a.example".into(),
        credential: Credential {
            kind: CredentialKind::Oauth,
            client_id: "customerClient".into(),
        },
        connected_at: 7,
    };
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    write_private(&store.dir.join(SECRET_FILE), SECRET.as_bytes()).unwrap();
    let path = store.dir.join(SECRET_FILE);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.secret(&config).is_err());
    assert!(!store.dir.join(KEY_FILE).exists());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut invalid = config;
    invalid.credential.client_id = "../bad".into();
    write_private(
        &store.dir.join(CONFIG_FILE),
        &serde_json::to_vec(&invalid).unwrap(),
    )
    .unwrap();
    assert!(store.secret(&invalid).is_err());
    assert!(!store.dir.join(KEY_FILE).exists());
}
