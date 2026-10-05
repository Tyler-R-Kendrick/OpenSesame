//! Separate store roots remain separate key domains even with one operator password.
use opensesame_human_vault::{
    derive_attachment_key, open_chunk, seal_chunk, ChunkAd, ENVELOPE_VERSION,
};
use opensesame_sealed_store::{init_store_key, open_osseal, seal_osseal, unlock_store_key};

#[test]
fn shared_operator_password_does_not_share_customer_content_keys() {
    let customer_a = tempfile::tempdir().unwrap();
    let customer_b = tempfile::tempdir().unwrap();
    let password = b"operator fixture password";
    let key_a = init_store_key(customer_a.path(), password).unwrap();
    let key_b = init_store_key(customer_b.path(), password).unwrap();
    assert_ne!(key_a.0, key_b.0);
    let unlocked_a = unlock_store_key(customer_a.path(), password).unwrap();
    let unlocked_b = unlock_store_key(customer_b.path(), password).unwrap();

    // The entry format is opaque bytes: passwords, API keys, private keys,
    // OTP seeds, documents, and plugin-defined secrets all use the same seal.
    for plaintext in [
        b"password fixture".as_slice(),
        b"api token fixture",
        b"private key fixture",
        b"otp seed fixture",
        b"document fixture",
        b"custom type fixture",
    ] {
        let sealed = seal_osseal(plaintext, &key_a, "shared/path", 1).unwrap();
        assert_eq!(
            open_osseal(&sealed, &unlocked_a, "shared/path", Some(1))
                .unwrap()
                .plaintext,
            plaintext
        );
        assert!(open_osseal(&sealed, &unlocked_b, "shared/path", Some(1)).is_err());
    }

    // Reused logical paths and attachment IDs cannot cross the customer key boundary.
    let attachment_id = [9u8; 16];
    let attachment_a = derive_attachment_key(&key_a, &attachment_id);
    let attachment_b = derive_attachment_key(&key_b, &attachment_id);
    let ad = ChunkAd {
        envelope_version: ENVELOPE_VERSION,
        attachment_id: "09090909090909090909090909090909".into(),
        item_id: "shared/path".into(),
        chunk_index: 0,
        chunk_count: 1,
    };
    let chunk = seal_chunk(&attachment_a, b"attachment fixture", &ad).unwrap();
    assert_eq!(
        open_chunk(&attachment_a, &chunk, &ad).unwrap(),
        b"attachment fixture"
    );
    assert!(open_chunk(&attachment_b, &chunk, &ad).is_err());
}
