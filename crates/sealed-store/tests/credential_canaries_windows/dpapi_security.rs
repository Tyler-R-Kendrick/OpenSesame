use super::*;
use opensesame_human_vault::{
    root_protection::{load_key_file, KeyFileContents},
    windows_publish,
};

const KEY_FILE: &str = ".opensesame-observation-device-key.v1";
fn identity(root: &Path) -> String {
    let KeyFileContents::Manifest(manifest) = load_key_file(root).unwrap() else {
        panic!("expected actual stable manifest")
    };
    manifest.vault_id
}

fn probe_fixed_filenames(root: &Path) {
    let sealed = windows_publish::detector_key::seal(&identity(root), &[71_u8; 32])
        .expect("fixed-filename detector key protect failed");
    for (name, value) in [
        (KEY_FILE, sealed.as_slice()),
        (
            ".opensesame-credential-canaries.v1",
            b"private fixture".as_slice(),
        ),
        (
            ".opensesame-installed-canary-validator.v1",
            b"private fixture".as_slice(),
        ),
    ] {
        windows_publish::atomic_write(root, Path::new(name), value)
            .expect("fixed-filename detector publication failed");
        assert_eq!(
            windows_io::read_bounded(root, Path::new(name), 4096)
                .expect("fixed-filename detector read failed"),
            value,
        );
        windows_io::remove(root, Path::new(name)).expect("fixed-filename detector removal failed");
    }
}

#[test]
fn windows_detector_key_is_dpapi_sealed_and_reopens_without_a_real_root_key() {
    let dir = store();
    let root = dir.path();
    probe_fixed_filenames(root);
    let canary = create(root, b"current owner", ArtifactKind::McpConfiguration).unwrap();
    let protected = windows_io::read_bounded(root, Path::new(KEY_FILE), 4096).unwrap();
    let independent = windows_publish::detector_key::open(&identity(root), &protected).unwrap();
    assert_eq!(independent.len(), 32);
    assert!(protected.len() > 32 && protected.starts_with(b"OSDK\0\x01"));
    assert!(!protected.windows(32).any(|part| part == &independent[..]));
    assert!(unlock_store_key(root, b"wrong owner").is_err());
    assert!(matches!(
        observe(root, &canary.id, &canary.presented_id, Phase::Connected)
            .unwrap()
            .decision,
        Decision::Canary { .. }
    ));
    assert!(
        status(root, b"current owner").unwrap()["artifacts"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );
    assert_eq!(
        windows_io::read_bounded(root, Path::new(KEY_FILE), 4096).unwrap(),
        protected
    );
}

#[test]
fn transplanted_tampered_or_lost_dpapi_keys_never_recreate_or_change_real_admission() {
    let first = store();
    let second = store();
    create(
        first.path(),
        b"current owner",
        ArtifactKind::McpConfiguration,
    )
    .unwrap();
    let canary = create(
        second.path(),
        b"current owner",
        ArtifactKind::McpConfiguration,
    )
    .unwrap();
    let original = windows_io::read_bounded(second.path(), Path::new(KEY_FILE), 4096).unwrap();
    let foreign = windows_io::read_bounded(first.path(), Path::new(KEY_FILE), 4096).unwrap();
    windows_publish::atomic_write(second.path(), Path::new(KEY_FILE), &foreign).unwrap();
    assert!(observe(
        second.path(),
        &canary.id,
        &canary.presented_id,
        Phase::Connected
    )
    .is_err());
    assert_eq!(
        windows_io::read_bounded(second.path(), Path::new(KEY_FILE), 4096).unwrap(),
        foreign
    );
    let mut tampered = original;
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    windows_publish::atomic_write(second.path(), Path::new(KEY_FILE), &tampered).unwrap();
    assert!(status(second.path(), b"current owner").is_err());
    assert_eq!(
        windows_io::read_bounded(second.path(), Path::new(KEY_FILE), 4096).unwrap(),
        tampered
    );
    windows_io::remove(second.path(), Path::new(KEY_FILE)).unwrap();
    assert!(status(second.path(), b"current owner").is_err());
    assert!(!second.path().join(KEY_FILE).exists());
    assert!(unlock_store_key(second.path(), b"current owner").is_ok());
}
