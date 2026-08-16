use opensesame_human_vault::{
    decrypt_item, encrypt_item, AssociatedData, EncryptedEnvelope, ItemDataKey, ENVELOPE_VERSION,
};
use serde::{Deserialize, Serialize};

use crate::StoreError;

pub const OSSEAL_MAGIC: &[u8] = b"OSSEAL1\n";

#[derive(Serialize, Deserialize)]
struct OssealBody {
    envelope: EncryptedEnvelope,
}

fn store_ad() -> AssociatedData {
    AssociatedData {
        envelope_version: ENVELOPE_VERSION,
        item_id: "sealed-store-entry".into(),
        organization_id: "local".into(),
        project_id: "store".into(),
        collection_id: "entries".into(),
        key_id: "idk".into(),
        revision: 1,
    }
}

/// Seal plaintext into an `.osseal` blob (magic + JSON envelope).
pub fn seal_osseal(plaintext: &[u8], content_key: &ItemDataKey) -> Result<Vec<u8>, StoreError> {
    let envelope = encrypt_item(content_key, plaintext, store_ad())
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    let body = OssealBody { envelope };
    let json = serde_json::to_vec(&body).map_err(|e| StoreError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(OSSEAL_MAGIC.len() + json.len());
    out.extend_from_slice(OSSEAL_MAGIC);
    out.extend_from_slice(&json);
    Ok(out)
}

/// Open an `.osseal` blob.
pub fn open_osseal(blob: &[u8], content_key: &ItemDataKey) -> Result<Vec<u8>, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let json = &blob[OSSEAL_MAGIC.len()..];
    let body: OssealBody =
        serde_json::from_slice(json).map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(decrypt_item(content_key, &body.envelope).map_err(|e| StoreError::Crypto(e.to_string()))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osseal_round_trip() {
        let key = ItemDataKey([7u8; 32]);
        let pt = b"hello\nmeta: 1\n";
        let ct = seal_osseal(pt, &key).unwrap();
        assert!(ct.starts_with(OSSEAL_MAGIC));
        assert_eq!(open_osseal(&ct, &key).unwrap(), pt);
    }

    #[test]
    fn wrong_key_fails_closed() {
        let key = ItemDataKey([7u8; 32]);
        let other = ItemDataKey([8u8; 32]);
        let ct = seal_osseal(b"secret", &key).unwrap();
        assert!(open_osseal(&ct, &other).is_err());
    }
}
