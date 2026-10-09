//! Genuine original OS leases/private filesystem and real Node-compatible osr1 AEAD controls.
use super::*;
#[cfg(unix)]
use crate::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use crate::root_protection::windows_private_files::write_new;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use std::fs;
use zeroize::Zeroizing;
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("state");
    #[cfg(windows)]
    let path = Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([41; 32])).as_bytes(),
    )
    .unwrap();
    (temp, root)
}
fn sealed(domain: &str, name: &str, plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new_from_slice(&[41; 32]).unwrap();
    let nonce = [13; 24];
    let aad = format!("opensesame.at-rest.v1\0{domain}\0{name}");
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .unwrap();
    let mut bytes = nonce.to_vec();
    bytes.extend_from_slice(&encrypted);
    format!("osr1.{}", URL_SAFE_NO_PAD.encode(bytes)).into_bytes()
}
fn sealed_generation(name: &str, plaintext: &[u8]) -> Vec<u8> {
    let binding =
        serde_json::to_vec(&["opensesame.at-rest.v2", "node-vault-generation-v1", name]).unwrap();
    let mut kek = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(b"opensesame.at-rest.v2.kek"), &[41; 32])
        .expand(&binding, &mut *kek)
        .unwrap();
    let dek = Zeroizing::new([71; 32]);
    let wrap_nonce = [51; 24];
    let nonce = [61; 24];
    let aad = |purpose| {
        serde_json::to_vec(&["osr2", purpose, &URL_SAFE_NO_PAD.encode(&binding)]).unwrap()
    };
    let wrapper = XChaCha20Poly1305::new_from_slice(&*kek).unwrap();
    let cipher = XChaCha20Poly1305::new_from_slice(&*dek).unwrap();
    let mut bytes = wrap_nonce.to_vec();
    bytes.extend(
        wrapper
            .encrypt(
                XNonce::from_slice(&wrap_nonce),
                Payload {
                    msg: &*dek,
                    aad: &aad("wrap"),
                },
            )
            .unwrap(),
    );
    bytes.extend(nonce);
    bytes.extend(
        cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad("data"),
                },
            )
            .unwrap(),
    );
    format!("osr2.{}", URL_SAFE_NO_PAD.encode(bytes)).into_bytes()
}
#[test]
fn actual_generation_binding_is_reconstructed_and_plaintext_cannot_egress_as_ciphertext() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.bootstrap_writer("selected").unwrap();
    assert!(writer
        .read_optional_generation_ciphertext()
        .unwrap()
        .is_none());
    assert!(writer
        .read_optional_modern_device_ciphertext("tomb/selected/retired-credentials.v2")
        .unwrap()
        .is_none());
    let context = binding(
        "selected",
        &writer
            .resource_identity(NativeNodeDataScope::Vault)
            .unwrap(),
    )
    .unwrap();
    let wire = sealed_generation(&context, b"actual encrypted fixture payload");
    writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            Path::new(GENERATION),
            None,
            Some(&wire),
        )
        .unwrap();
    assert_eq!(writer.read_generation_ciphertext().unwrap(), wire);
    let legacy = sealed(
        "node-vault-generation-v1",
        &context,
        b"legacy generation forbidden",
    );
    writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            Path::new(GENERATION),
            Some(&wire),
            Some(&legacy),
        )
        .unwrap();
    assert!(writer.read_generation_ciphertext().is_err());
    writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            Path::new(GENERATION),
            Some(&legacy),
            Some(&wire),
        )
        .unwrap();
    writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            Path::new(GENERATION),
            Some(&wire),
            Some(b"private plaintext shaped like ordinary bytes"),
        )
        .unwrap();
    assert!(writer.read_generation_ciphertext().is_err());
    assert!(writer
        .read_modern_device_ciphertext("tomb/foreign/retired-credentials.v2")
        .is_err());
    assert!(writer
        .read_modern_device_ciphertext("unknown-global-key")
        .is_err());
}
#[test]
fn original_catalogue_exact_retired_slot_and_writer_modern_scope_use_actual_outer_crypto() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.bootstrap_writer("selected").unwrap();
    let logical = "tomb/selected/retired-credentials.v2";
    let leaf = modern_name(logical).unwrap();
    let wire = sealed(
        "node-device-record-v1",
        &binding(logical, &leaf).unwrap(),
        b"actual retired DATA fixture",
    );
    writer
        .compare_publish(
            NativeNodeDataScope::Origin,
            Path::new(&leaf),
            None,
            Some(&wire),
        )
        .unwrap();
    assert_eq!(writer.read_modern_device_ciphertext(logical).unwrap(), wire);
    let catalogue = credential.capture_device_inventory().unwrap();
    assert_eq!(catalogue.read_retired_ciphertext("selected").unwrap(), wire);
    assert!(catalogue.read_retired_ciphertext("foreign").is_err());
    let wrong_context = sealed(
        "node-device-record-v1",
        &binding("tomb/foreign/retired-credentials.v2", &leaf).unwrap(),
        b"foreign logical context",
    );
    writer
        .compare_publish(
            NativeNodeDataScope::Origin,
            Path::new(&leaf),
            Some(&wire),
            Some(&wrong_context),
        )
        .unwrap();
    assert!(writer.read_modern_device_ciphertext(logical).is_err());
    assert!(catalogue.read_retired_ciphertext("selected").is_err());
    state.seal().unwrap();
    assert!(writer.read_generation_ciphertext().is_err());
    assert!(catalogue.read_retired_ciphertext("selected").is_err());
}
#[test]
fn exact_modern_address_formula_and_unsafe_names_refuse_without_legacy_fallback() {
    assert_eq!(
        modern_name("tomb/selected/retired-credentials.v2").unwrap(),
        format!(
            "opensesame-pages-node-record-v2-{}-{}.json",
            digest("tomb/selected"),
            digest("tomb/selected/retired-credentials.v2")
        )
    );
    for invalid in [
        "",
        "/x",
        "tomb/selected",
        "tomb/../x",
        "tomb/selected//x",
        "tomb/selected/é",
        "tomb/selected/x\0",
    ] {
        assert!(modern_name(invalid).is_err());
    }
    assert!(modern_name(&"x".repeat(513)).is_err());
}

#[test]
fn actual_absence_is_distinct_from_a_present_directory_and_original_seal_failure() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.bootstrap_writer("selected").unwrap();
    let catalogue = credential.capture_device_inventory().unwrap();
    assert!(catalogue
        .read_optional_retired_ciphertext("selected")
        .unwrap()
        .is_none());
    assert!(catalogue
        .read_optional_retired_ciphertext("foreign")
        .is_err());
    let leaf = modern_name("tomb/selected/retired-credentials.v2").unwrap();
    writer.origin.create_child(Path::new(&leaf)).unwrap();
    assert!(writer
        .read_optional_modern_device_ciphertext("tomb/selected/retired-credentials.v2")
        .is_err());
    assert!(catalogue
        .read_optional_retired_ciphertext("selected")
        .is_err());
    state.seal().unwrap();
    assert!(writer.read_optional_generation_ciphertext().is_err());
}

#[test]
fn actual_case_alias_presence_never_becomes_false_absence_on_casefolding_filesystems() {
    let (temporary, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.bootstrap_writer("selected").unwrap();
    let fixture_root = fs::canonicalize(temporary.path()).unwrap().join("state");
    let aliases = [
        (
            Arc::clone(&writer.vault),
            GENERATION.to_owned(),
            fixture_root.join("vault").join("selected"),
        ),
        (
            Arc::clone(&writer.origin),
            modern_name("tomb/selected/retired-credentials.v2").unwrap(),
            fixture_root.join("origin-files"),
        ),
    ];
    for (directory, leaf, physical) in aliases {
        let alias = leaf.to_ascii_uppercase();
        assert_ne!(alias, leaf);
        write_new(
            &directory,
            Path::new(&alias),
            b"actual alias-present fixture",
        )
        .unwrap();
        assert!(directory
            .original_bounded_directory_entries(4096)
            .unwrap()
            .iter()
            .any(|(name, _)| name == &alias));
        // Independent controlled fixture lookup decides the actual filesystem case semantics.
        let actual_absent = match fs::symlink_metadata(physical.join(&leaf)) {
            Ok(_) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => panic!("independent fixture lookup failed: {error}"),
        };
        assert_eq!(
            directory.original_entry_absent(Path::new(&leaf)).unwrap(),
            actual_absent
        );
        let observed = read_optional(&directory, &leaf);
        if actual_absent {
            // Distinct case-sensitive names (including ordinary Linux) preserve genuine absence.
            assert!(observed.unwrap().is_none());
        } else {
            // Real Windows/APFS/casefold namespace lookup sees an existing entry, so refuse.
            assert!(observed.is_err());
        }
    }
}
