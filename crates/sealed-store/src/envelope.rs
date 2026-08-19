use opensesame_human_vault::{
    decrypt_item, decrypt_item_with_ad, encrypt_item, AssociatedData, EncryptedEnvelope,
    ItemDataKey, ENVELOPE_VERSION,
};
use serde::{Deserialize, Serialize};

use crate::StoreError;

pub const OSSEAL_MAGIC: &[u8] = b"OSSEAL1\n";

#[derive(Serialize, Deserialize)]
struct OssealBody {
    envelope: EncryptedEnvelope,
}

fn store_ad(name: &str, revision: u64) -> AssociatedData {
    AssociatedData {
        envelope_version: ENVELOPE_VERSION,
        item_id: name.into(),
        organization_id: "local".into(),
        project_id: "store".into(),
        collection_id: "entries".into(),
        key_id: "idk".into(),
        revision,
    }
}

pub struct OpenedOsseal {
    pub plaintext: Vec<u8>,
    pub revision: u64,
    pub legacy: bool,
}

/// Seal plaintext into an `.osseal` blob (magic + JSON envelope).
pub fn seal_osseal(
    plaintext: &[u8],
    content_key: &ItemDataKey,
    name: &str,
    revision: u64,
) -> Result<Vec<u8>, StoreError> {
    if revision == 0 {
        return Err(StoreError::Crypto("entry revision must be positive".into()));
    }
    let envelope = encrypt_item(content_key, plaintext, store_ad(name, revision))
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    let body = OssealBody { envelope };
    let json = serde_json::to_vec(&body).map_err(|e| StoreError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(OSSEAL_MAGIC.len() + json.len());
    out.extend_from_slice(OSSEAL_MAGIC);
    out.extend_from_slice(&json);
    Ok(out)
}

/// Open an `.osseal` blob.
pub fn open_osseal(
    blob: &[u8],
    content_key: &ItemDataKey,
    name: &str,
    expected_revision: Option<u64>,
) -> Result<OpenedOsseal, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let json = &blob[OSSEAL_MAGIC.len()..];
    let body: OssealBody =
        serde_json::from_slice(json).map_err(|e| StoreError::Crypto(e.to_string()))?;
    if body.envelope.ad.item_id == "sealed-store-entry" {
        return Ok(OpenedOsseal {
            plaintext: decrypt_item(content_key, &body.envelope)
                .map_err(|e| StoreError::Crypto(e.to_string()))?,
            revision: 0,
            legacy: true,
        });
    }
    let revision = expected_revision.unwrap_or(body.envelope.ad.revision);
    if revision == 0 {
        return Err(StoreError::Crypto("entry revision must be positive".into()));
    }
    let plaintext = decrypt_item_with_ad(content_key, &body.envelope, &store_ad(name, revision))
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(OpenedOsseal {
        plaintext,
        revision,
        legacy: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osseal_round_trip() {
        let key = ItemDataKey([7u8; 32]);
        let pt = b"hello\nmeta: 1\n";
        let ct = seal_osseal(pt, &key, "Dev/token", 1).unwrap();
        assert!(ct.starts_with(OSSEAL_MAGIC));
        assert_eq!(
            open_osseal(&ct, &key, "Dev/token", Some(1))
                .unwrap()
                .plaintext,
            pt
        );
    }

    #[test]
    fn wrong_key_fails_closed() {
        let key = ItemDataKey([7u8; 32]);
        let other = ItemDataKey([8u8; 32]);
        let ct = seal_osseal(b"secret", &key, "Dev/token", 1).unwrap();
        assert!(open_osseal(&ct, &other, "Dev/token", Some(1)).is_err());
    }

    #[test]
    fn path_and_revision_are_mandatory_context() {
        let key = ItemDataKey([7u8; 32]);
        let ct = seal_osseal(b"secret", &key, "Dev/a", 2).unwrap();
        assert!(open_osseal(&ct, &key, "Dev/b", Some(2)).is_err());
        assert!(open_osseal(&ct, &key, "Dev/a", Some(3)).is_err());
    }
}
