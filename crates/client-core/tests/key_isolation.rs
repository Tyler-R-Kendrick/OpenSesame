//! Native client sync ciphertext is bound to its owner's key and item identity.
use opensesame_client_core::{open, DeviceKey, SyncStore};

#[test]
fn independent_customer_keys_refuse_foreign_ciphertext_for_the_same_item_id() {
    let customer_a = DeviceKey::from_bytes([11; 32]);
    let customer_b = DeviceKey::from_bytes([22; 32]);
    let mut store_a = SyncStore::new("customer-a-device");
    let mut store_b = SyncStore::new("customer-b-device");
    let a = store_a
        .put_local(&customer_a, "shared-item-id", b"customer-a-secret")
        .unwrap();
    let b = store_b
        .put_local(&customer_b, "shared-item-id", b"customer-b-secret")
        .unwrap();
    assert_eq!(
        open(&customer_a, &a.ciphertext, b"shared-item-id").unwrap(),
        b"customer-a-secret"
    );
    assert_eq!(
        open(&customer_b, &b.ciphertext, b"shared-item-id").unwrap(),
        b"customer-b-secret"
    );
    assert!(open(&customer_b, &a.ciphertext, b"shared-item-id").is_err());
    assert!(open(&customer_a, &b.ciphertext, b"shared-item-id").is_err());
    assert!(open(&customer_a, &a.ciphertext, b"different-item-id").is_err());
    let mut tampered = a.ciphertext;
    *tampered.last_mut().unwrap() ^= 1;
    assert!(open(&customer_a, &tampered, b"shared-item-id").is_err());
}
