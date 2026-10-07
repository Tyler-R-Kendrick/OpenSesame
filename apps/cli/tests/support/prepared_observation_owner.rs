//! Genuine peer transactions prepared before HTTP, then committed under the real store flock.
//! Only this test helper retains the encrypted manifest; no production authorization seam exists.
use opensesame_human_vault::{
    credential_canaries::DeviceState,
    root_protection::{
        load_key_file, protect_rewrap_password, sync_dir, unlock_key_file_with_password,
        write_key_file, write_synced, KeyFileContents,
    },
    AssociatedData, EncryptedEnvelope, ItemDataKey,
};
use std::{
    fs::{File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

const KEY_FILE: &str = ".opensesame-key";
const DEVICE_KEY: &str = ".opensesame-observation-device-key.v1";
const DEVICE_STATE: &str = ".opensesame-credential-canaries.v1";

pub struct PreparedOwner {
    root: PathBuf,
    original: Vec<u8>,
    identity: String,
}

fn exclusive(root: &Path) -> File {
    assert!(!std::fs::symlink_metadata(root)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!root.join(".opensesame-rotation").exists());
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join(".opensesame-lock"))
        .unwrap();
    // SAFETY: file owns a valid descriptor throughout this nonblocking kernel lock call.
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert!(!root.join(".opensesame-rotation").exists());
    file
}

fn private_bytes(path: &Path, limit: usize) -> Vec<u8> {
    use std::io::Read;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .unwrap();
    let meta = file.metadata().unwrap();
    assert!(meta.is_file() && meta.nlink() == 1 && meta.mode() & 0o777 == 0o600);
    // SAFETY: geteuid has no pointer arguments or side effects.
    assert_eq!(meta.uid(), unsafe { libc::geteuid() });
    assert!(meta.len() <= limit as u64);
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= limit);
    bytes
}

fn associated(identity: &str) -> AssociatedData {
    AssociatedData {
        envelope_version: 1,
        item_id: "credential-observation-device-state.v1".into(),
        organization_id: "local-device-detector".into(),
        project_id: identity.into(),
        collection_id: "closed-credential-observations".into(),
        key_id: "independent-device-key.v1".into(),
        revision: 1,
    }
}

impl PreparedOwner {
    pub fn prove(root: &Path, password: &[u8]) -> Self {
        let _lock = exclusive(root);
        let original = private_bytes(&root.join(KEY_FILE), 65536);
        let (_, contents, _root) = unlock_key_file_with_password(root, password).unwrap();
        let KeyFileContents::Manifest(manifest) = contents else {
            panic!("expected authenticated manifest")
        };
        assert_eq!(private_bytes(&root.join(KEY_FILE), 65536), original);
        Self {
            root: root.into(),
            original,
            identity: manifest.vault_id,
        }
    }

    pub fn prepare_rewrap(&self, old: &[u8], new: &[u8]) -> KeyFileContents {
        let copy = tempfile::tempdir().unwrap();
        write_synced(&copy.path().join(KEY_FILE), &self.original).unwrap();
        protect_rewrap_password(copy.path(), old, new).unwrap();
        let (_, next, new_root) = unlock_key_file_with_password(copy.path(), new).unwrap();
        let _lock = exclusive(&self.root);
        self.assert_current();
        let (_, current, old_root) = unlock_key_file_with_password(&self.root, old).unwrap();
        assert!(
            old_root.0 == new_root.0,
            "rewrap must preserve the actual root"
        );
        let (KeyFileContents::Manifest(before), KeyFileContents::Manifest(after)) =
            (current, &next)
        else {
            panic!("expected authenticated manifests")
        };
        assert_eq!(before.vault_id, after.vault_id);
        assert_eq!(before.root_key_id, after.root_key_id);
        assert!(after.revision > before.revision);
        self.assert_current();
        next
    }

    fn assert_current(&self) {
        assert_eq!(
            private_bytes(&self.root.join(KEY_FILE), 65536),
            self.original,
            "a prepared peer transaction must not replace a changed owner policy"
        );
    }

    pub fn commit_rewrap(&self, next: &KeyFileContents) {
        let _lock = exclusive(&self.root);
        self.assert_current();
        write_key_file(&self.root, next).unwrap();
        assert!(matches!(
            load_key_file(&self.root).unwrap(),
            KeyFileContents::Manifest(_)
        ));
    }

    pub fn remove_latest_receiver(&self) {
        let _lock = exclusive(&self.root);
        self.assert_current();
        let bytes = Zeroizing::new(private_bytes(&self.root.join(DEVICE_KEY), 32));
        let key = ItemDataKey(bytes.as_slice().try_into().unwrap());
        let envelope: EncryptedEnvelope =
            serde_json::from_slice(&private_bytes(&self.root.join(DEVICE_STATE), 196608)).unwrap();
        let clear = Zeroizing::new(
            opensesame_human_vault::decrypt_item_with_ad(
                &key,
                &envelope,
                &associated(&self.identity),
            )
            .unwrap(),
        );
        let mut state = DeviceState::parse(
            std::str::from_utf8(&clear).unwrap(),
            &format!("native-store:{}", self.identity),
            &self.identity,
        )
        .unwrap();
        // These must be the current reserved package and current abuse budget, not a pre-HTTP snapshot.
        assert_eq!(state.outbox.entries.len(), 1);
        assert_eq!(state.owner_test_witnesses.len(), 1);
        let history = serde_json::to_value(&state.outbox.history).unwrap();
        assert_eq!(history.as_array().unwrap().len(), 1);
        let failed = state.outbox.failed;
        state.remove_receiver();
        assert_eq!(
            serde_json::to_value(&state.outbox.history).unwrap(),
            history
        );
        assert_eq!(state.outbox.failed, failed);
        let encoded = Zeroizing::new(state.encode().unwrap());
        let sealed = opensesame_human_vault::encrypt_item(
            &key,
            encoded.as_bytes(),
            associated(&self.identity),
        )
        .unwrap();
        let pending = self
            .root
            .join(format!(".observation-peer-{}.tmp", uuid::Uuid::new_v4()));
        write_synced(&pending, &serde_json::to_vec(&sealed).unwrap()).unwrap();
        self.assert_current();
        std::fs::rename(pending, self.root.join(DEVICE_STATE)).unwrap();
        sync_dir(&self.root);
    }
}
